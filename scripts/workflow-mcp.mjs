#!/usr/bin/env node

import { spawn } from "node:child_process";
import { open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.5.2";
const INNER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSCRIPT_PREFIX_BYTES = 16 * 1024 * 1024;
const JOURNAL_CHUNK_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 250;
const MAX_SCRIPT_LENGTH = 524_288;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const PROGRESS_PATTERN =
  /<codex-workflow-progress>(.{1,1024}?)<\/codex-workflow-progress>/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const PROVIDER_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "WORKFLOW_MODEL",
  "WORKFLOW_MIN_QUOTA_REMAINING_PERCENT",
  "WORKFLOW_QUOTA_URL",
]);
const children = new Set();
const runs = new Map();

await loadProviderEnv();

const workflowInputSchema = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      minLength: 1,
    },
    script: {
      type: "string",
      description:
        "Exact Claude Code Dynamic Workflow JavaScript source. Do not pass a natural-language task.",
      minLength: 1,
      maxLength: MAX_SCRIPT_LENGTH,
    },
    args: {},
    allowEdits: {
      type: "boolean",
      description:
        "Start Claude Code in acceptEdits permission mode for the requested cwd.",
    },
  },
  required: ["cwd", "script"],
  additionalProperties: false,
};

const workflowStartTool = {
  name: "WorkflowStart",
  description:
    "Start an exact JavaScript Claude Code Dynamic Workflow in a workspace.",
  inputSchema: workflowInputSchema,
};

const workflowQuotaTool = {
  name: "WorkflowQuota",
  description:
    "Return the current Z.AI GLM Coding Plan five-hour model quota. No arguments.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const workflowWaitTool = {
  name: "WorkflowWait",
  description:
    "Call directly to wait for a workflow revision or terminal state. Do not wrap this tool in a background execution shell.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", minLength: 1 },
      afterRevision: { type: "integer", minimum: 0 },
    },
    required: ["runId", "afterRevision"],
    additionalProperties: false,
  },
};

const workflowStopTool = {
  name: "WorkflowStop",
  description: "Stop a workflow run.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", minLength: 1 },
    },
    required: ["runId"],
    additionalProperties: false,
  },
};

const workflowTool = {
  name: "Workflow",
  description:
    "Execute an exact Claude Code Dynamic Workflow script in a workspace and wait for completion.",
  inputSchema: workflowInputSchema,
};

const tools = [
  workflowStartTool,
  workflowQuotaTool,
  workflowWaitTool,
  workflowStopTool,
  workflowTool,
];

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
    writeError(null, -32600, "Request is too large");
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeError(null, -32700, "Parse error");
    return;
  }

  void handleMessage(message).catch(() => {
    if (Object.hasOwn(message ?? {}, "id")) {
      writeError(message.id, -32603, "Internal error");
    }
  });
});

const terminateChildren = () => {
  for (const run of runs.values()) {
    if (!run.terminal) {
      run.failureMessage = "Claude Code stopped before workflow completion";
      finishRun(run, "failed");
    }
  }
  for (const child of children) child.kill("SIGTERM");
};

input.once("close", terminateChildren);
process.on("exit", terminateChildren);
process.once("SIGINT", () => {
  terminateChildren();
  process.exit(130);
});
process.once("SIGTERM", () => {
  terminateChildren();
  process.exit(143);
});

async function loadProviderEnv() {
  const configRoot =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  let contents;
  try {
    contents = await readFile(
      join(configRoot, "codex-dynamic-workflow-plugin", ".env"),
      "utf8",
    );
  } catch {
    return;
  }

  for (const sourceLine of contents.split(/\r?\n/)) {
    let line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !PROVIDER_KEYS.has(match[1])) continue;

    const key = match[1];
    if (process.env[key]?.trim()) continue;
    if (
      (key === "ANTHROPIC_AUTH_TOKEN" || key === "ANTHROPIC_API_KEY") &&
      (process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
        process.env.ANTHROPIC_API_KEY?.trim())
    ) {
      continue;
    }

    let value = match[2].trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.at(-1) === value[0]
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
}

function providerConfigError() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) {
    return "Configure ANTHROPIC_BASE_URL for the Z.AI provider";
  }
  try {
    const protocol = new URL(baseUrl).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new Error();
  } catch {
    return "ANTHROPIC_BASE_URL must be an absolute HTTP(S) URL";
  }
  if (
    !process.env.ANTHROPIC_AUTH_TOKEN?.trim() &&
    !process.env.ANTHROPIC_API_KEY?.trim()
  ) {
    return "Configure ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for Z.AI";
  }
  return null;
}

function minimumQuotaRemainingPercent() {
  const rawValue = process.env.WORKFLOW_MIN_QUOTA_REMAINING_PERCENT?.trim();
  if (!rawValue) return 50;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(
      "WORKFLOW_MIN_QUOTA_REMAINING_PERCENT must be a finite number from 0 through 100",
    );
  }
  return value;
}

function quotaUrl() {
  const url = process.env.WORKFLOW_QUOTA_URL?.trim() || DEFAULT_QUOTA_URL;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new Error();
  } catch {
    throw new Error("WORKFLOW_QUOTA_URL must be an absolute HTTP(S) URL");
  }
  return url;
}

function parseQuotaResponse(payload) {
  if (payload?.code !== 200 || payload.success !== true) {
    throw new Error("Z.AI quota request was rejected");
  }

  const level = payload.data?.level;
  if (typeof level !== "string" || !level.trim()) {
    throw new Error("Z.AI quota response has no subscription level");
  }

  const limits = payload.data?.limits;
  if (!Array.isArray(limits)) {
    throw new Error("Z.AI quota response has no five-hour model quota");
  }

  const quota = limits.find(
    (limit) =>
      limit?.type === "TOKENS_LIMIT" &&
      limit.unit === 3 &&
      limit.number === 5,
  );
  if (!quota) {
    throw new Error("Z.AI quota response has no five-hour model quota");
  }

  const usedPercent = quota.percentage;
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error("Z.AI quota response has an invalid model usage percent");
  }

  return {
    level,
    usedPercent,
    remainingPercent: Number((100 - usedPercent).toFixed(6)),
    resetAt:
      Number.isFinite(quota.nextResetTime) && quota.nextResetTime > 0
        ? quota.nextResetTime
        : null,
  };
}

async function fetchWorkflowQuota() {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim();

  let response;
  try {
    response = await fetch(quotaUrl(), {
      headers: { Authorization: token, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Unable to query Z.AI quota");
  }
  if (!response.ok) throw new Error("Unable to query Z.AI quota");

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Z.AI quota response is not JSON");
  }
  return parseQuotaResponse(payload);
}

async function ensureQuotaAvailable() {
  const minimum = minimumQuotaRemainingPercent();
  if (minimum === 0) return;

  const quota = await fetchWorkflowQuota();
  if (quota.remainingPercent < minimum) {
    throw new Error(
      `Z.AI quota remaining is ${quota.remainingPercent}%; minimum is ${minimum}%`,
    );
  }
}

async function handleMessage(message) {
  const hasId = Object.hasOwn(message ?? {}, "id");
  if (
    !message ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    if (hasId) writeError(message.id, -32600, "Invalid request");
    return;
  }

  if (!hasId) return;

  switch (message.method) {
    case "initialize":
      writeResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "codex-dynamic-workflow",
          version: SERVER_VERSION,
        },
        instructions:
          "Pass exact Dynamic Workflow JavaScript, never a natural-language task, to WorkflowStart. " +
          "Then call WorkflowWait with the latest revision until terminal. " +
          "Report phase/role/leaf changes. Use WorkflowStop when the run is cancelled.",
      });
      return;
    case "ping":
      writeResult(message.id, {});
      return;
    case "tools/list":
      writeResult(message.id, { tools });
      return;
    case "tools/call":
      writeResult(message.id, await callTool(message.params));
      return;
    default:
      writeError(message.id, -32601, "Method not found");
  }
}

async function callTool(params) {
  try {
    switch (params?.name) {
      case "Workflow":
        return await callWorkflow(params.arguments, false);
      case "WorkflowStart":
        return await callWorkflow(params.arguments, true);
      case "WorkflowQuota":
        return await callWorkflowQuota(params.arguments);
      case "WorkflowWait":
        return await callWorkflowWait(params.arguments);
      case "WorkflowStop":
        return callWorkflowStop(params.arguments);
      default:
        return toolError("Unknown tool");
    }
  } catch (error) {
    return toolError(
      error instanceof Error ? error.message : "Workflow execution failed",
    );
  }
}

async function callWorkflow(args, asynchronous) {
  const validationError = validateArguments(args);
  if (validationError) return toolError(validationError);

  const nativeArguments = { script: args.script };
  if (Object.hasOwn(args, "args")) nativeArguments.args = args.args;
  const allowEdits = args.allowEdits === true;
  if (!asynchronous) {
    return toolSuccess(
      await runWorkflow(nativeArguments, args.cwd, allowEdits),
    );
  }

  const run = await startWorkflow(nativeArguments, args.cwd, allowEdits);
  return toolSuccess({
    runId: run.runId,
    status: "starting",
    revision: 0,
    elapsedMs: 0,
  });
}

async function callWorkflowQuota(args = {}) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    if (Object.keys(args).length) {
      return toolError("WorkflowQuota received an unsupported argument");
    }
  } else {
    return toolError("WorkflowQuota arguments must be an object");
  }

  const configError = providerConfigError();
  if (configError) return toolError(configError);
  return toolSuccess(await fetchWorkflowQuota());
}

async function callWorkflowWait(args) {
  const validationError = validateWaitArguments(args);
  if (validationError) return toolError(validationError);

  const run = runs.get(args.runId);
  if (!run) return toolError("Unknown workflow run");
  if (args.afterRevision > run.revision) {
    return toolError(
      "WorkflowWait afterRevision cannot exceed current revision",
    );
  }
  return toolSuccess(await waitForUpdate(run, args.afterRevision));
}

function callWorkflowStop(args) {
  const validationError = validateStopArguments(args);
  if (validationError) return toolError(validationError);

  const run = runs.get(args.runId);
  if (!run) return toolError("Unknown workflow run");
  return toolSuccess(stopWorkflow(run));
}

function validateArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "Workflow arguments must be an object";
  }
  if (
    Object.keys(args).some(
      (key) =>
        key !== "cwd" &&
        key !== "script" &&
        key !== "args" &&
        key !== "allowEdits",
    )
  ) {
    return "Workflow received an unsupported argument";
  }
  if (typeof args.cwd !== "string" || !isAbsolute(args.cwd)) {
    return "Workflow cwd must be an absolute path";
  }
  if (typeof args.script !== "string" || !args.script.trim()) {
    return "Workflow script must be a non-empty string";
  }
  if (args.script.length > MAX_SCRIPT_LENGTH) {
    return "Workflow script is too large";
  }
  if (
    Object.hasOwn(args, "allowEdits") &&
    typeof args.allowEdits !== "boolean"
  ) {
    return "Workflow allowEdits must be a boolean";
  }
  return null;
}

function validateWaitArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "WorkflowWait arguments must be an object";
  }
  if (
    Object.keys(args).some(
      (key) => key !== "runId" && key !== "afterRevision",
    )
  ) {
    return "WorkflowWait received an unsupported argument";
  }
  if (typeof args.runId !== "string" || !args.runId) {
    return "WorkflowWait runId must be a non-empty string";
  }
  if (!Number.isInteger(args.afterRevision) || args.afterRevision < 0) {
    return "WorkflowWait afterRevision must be a non-negative integer";
  }
  return null;
}

function validateStopArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "WorkflowStop arguments must be an object";
  }
  if (Object.keys(args).some((key) => key !== "runId")) {
    return "WorkflowStop received an unsupported argument";
  }
  if (typeof args.runId !== "string" || !args.runId) {
    return "WorkflowStop runId must be a non-empty string";
  }
  return null;
}

async function startWorkflow(nativeArguments, cwd, allowEdits) {
  const configError = providerConfigError();
  if (configError) throw new Error(configError);
  await ensureQuotaAvailable();

  const native = startNativeClient(cwd, allowEdits);
  try {
    await native.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codex-dynamic-workflow", version: SERVER_VERSION },
    });
    native.notify("notifications/initialized");
    const response = await native.request("tools/call", {
      name: "Workflow",
      arguments: nativeArguments,
    });
    const launch = parseNativeLaunch(response);
    const workflowRoot = dirname(dirname(launch.scriptPath));
    const transcriptRoot = join(
      dirname(workflowRoot),
      "subagents",
      "workflows",
      launch.runId,
    );
    const run = {
      runId: launch.runId,
      child: native.child,
      close: native.close,
      startedAt: Date.now(),
      finishedAt: undefined,
      status: "running",
      revision: 0,
      events: [],
      waiters: new Set(),
      leaves: new Map(),
      currentPhase: null,
      statePath: join(workflowRoot, `${launch.runId}.json`),
      transcriptRoot,
      journalPath: join(transcriptRoot, "journal.jsonl"),
      journalOffset: 0,
      journalTail: "",
      journalDecoder: new TextDecoder("utf-8", { fatal: true }),
      pendingJournalEvents: [],
      terminalState: undefined,
      result: undefined,
      terminal: false,
      childExited: false,
    };
    runs.set(run.runId, run);
    native.child.once("exit", () => {
      run.childExited = true;
    });
    if (native.child.exitCode !== null || native.child.signalCode !== null) {
      run.childExited = true;
    }
    void watchRun(run).catch((error) => {
      run.failureMessage =
        error instanceof Error
          ? error.message
          : "Unable to read workflow progress";
      finishRun(run, "failed");
    });
    return run;
  } catch (error) {
    native.close();
    throw error;
  }
}

function startNativeClient(cwd, allowEdits) {
  if (allowEdits) return startNativeSessionClient(cwd);
  return startNativeMcpClient(cwd);
}

function workflowEnvironment(model) {
  return {
    ...process.env,
    CLAUDE_CODE_WORKFLOWS: "1",
    ANTHROPIC_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

function startNativeSessionClient(cwd) {
  const model = process.env.WORKFLOW_MODEL?.trim() || "glm-5.3";
  let child;
  let reader;
  let launchPromise;
  let closed = false;

  const request = (method, params) => {
    if (method === "initialize") return Promise.resolve({});
    if (method !== "tools/call" || params?.name !== "Workflow") {
      return Promise.reject(new Error("Unsupported Claude Code request"));
    }
    if (launchPromise) {
      return Promise.reject(new Error("Claude Code workflow already requested"));
    }

    const expectedInput = params.arguments;
    child = spawn(
      "claude",
      [
        "-p",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Workflow",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      {
        cwd,
        env: workflowEnvironment(model),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    child.stderr.resume();
    reader = createInterface({ input: child.stdout });

    launchPromise = new Promise((resolveLaunch, rejectLaunch) => {
      let toolUseId;
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error("Claude Code did not launch the workflow")),
        120_000,
      );
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectLaunch(error);
      };

      child.on("error", fail);
      child.on("exit", () =>
        fail(new Error("Claude Code stopped before launching the workflow")),
      );
      child.stdin.on("error", fail);
      reader.on("line", (line) => {
        if (settled) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail(new Error("Claude Code returned invalid session output"));
          return;
        }

        if (message?.type === "result" && message.is_error === true) {
          fail(
            new Error(
              typeof message.result === "string" && message.result.trim()
                ? message.result.trim().slice(0, 2048)
                : "Claude Code rejected the workflow",
            ),
          );
          return;
        }

        const blocks = message?.message?.content;
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
          if (block?.type === "tool_use") {
            if (
              block.name !== "Workflow" ||
              toolUseId ||
              !isDeepStrictEqual(block.input, expectedInput)
            ) {
              fail(new Error("Claude Code changed the workflow request"));
              return;
            }
            toolUseId = block.id;
          }
          if (
            block?.type === "tool_result" &&
            toolUseId &&
            block.tool_use_id === toolUseId
          ) {
            const text =
              typeof block.content === "string" ? block.content.trim() : "";
            if (block.is_error || !text) {
              fail(
                new Error(
                  text.slice(0, 2048) || "Claude Code rejected the workflow",
                ),
              );
              return;
            }
            const runId = text.match(
              /^Run ID:\s*(wf_[a-z0-9-]{6,})\s*$/m,
            )?.[1];
            const scriptPath = text
              .match(/^Script file:\s*(.+)\s*$/m)?.[1]
              ?.trim();
            settled = true;
            clearTimeout(timer);
            resolveLaunch({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "async_launched",
                    runId,
                    scriptPath,
                  }),
                },
              ],
              isError: false,
            });
            return;
          }
        }
      });
    });

    child.stdin.end(
      [
        "Act only as a transport for Codex.",
        "Call the Workflow tool exactly once with the exact JSON input below.",
        "Do not call any other tool, alter the input, plan, or execute the task yourself.",
        "<workflow-input>",
        JSON.stringify(expectedInput),
        "</workflow-input>",
      ].join("\n"),
    );
    return launchPromise;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    reader?.close();
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    children.delete(child);
  };

  return {
    get child() {
      return child;
    },
    request,
    notify() {},
    close,
  };
}

function startNativeMcpClient(cwd) {
  const model = process.env.WORKFLOW_MODEL?.trim() || "glm-5.3";
  const child = spawn("claude", ["mcp", "serve"], {
    cwd,
    env: workflowEnvironment(model),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.stderr.resume();

  const reader = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let childStopped = false;
  let closed = false;

  const rejectPending = () => {
    childStopped = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Claude Code stopped unexpectedly"));
    }
    pending.clear();
  };

  child.on("error", rejectPending);
  child.on("exit", rejectPending);
  child.stdin.on("error", rejectPending);
  reader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectPending();
      return;
    }

    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error("Claude Code rejected the workflow request"));
    } else {
      request.resolve(message.result);
    }
  });

  const request = (method, params) => {
    if (childStopped) {
      return Promise.reject(new Error("Claude Code stopped unexpectedly"));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Claude Code did not respond"));
      }, INNER_REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };

  const notify = (method, params = {}) => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  };

  const close = () => {
    if (closed) return;
    closed = true;
    reader.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    child.stdin.end();
    children.delete(child);
  };

  return { child, request, notify, close };
}

function parseNativeLaunch(nativeResult) {
  if (nativeResult?.isError) {
    const reason = nativeResult?.content
      ?.find(
        (item) =>
          item?.type === "text" &&
          typeof item.text === "string" &&
          item.text.trim(),
      )
      ?.text.trim();
    throw new Error(
      reason?.slice(0, 2048) || "Claude Code rejected the workflow",
    );
  }
  const text = nativeResult?.content?.find(
    (item) => item?.type === "text",
  )?.text;
  let launch;
  try {
    launch = JSON.parse(text);
  } catch {
    throw new Error("Claude Code returned an invalid workflow response");
  }

  const runId = launch?.runId;
  const scriptPath = launch?.scriptPath;
  if (
    launch?.status !== "async_launched" ||
    typeof runId !== "string" ||
    !/^wf_[a-z0-9-]{6,}$/.test(runId) ||
    typeof scriptPath !== "string" ||
    !isAbsolute(scriptPath) ||
    basename(dirname(scriptPath)) !== "scripts"
  ) {
    throw new Error("Claude Code returned an invalid workflow launch");
  }
  return launch;
}

async function readJournalAdditions(run) {
  let file;
  try {
    file = await open(run.journalPath, "r");
    const { size } = await file.stat();
    const lines = [];
    while (run.journalOffset < size) {
      const length = Math.min(
        JOURNAL_CHUNK_BYTES,
        size - run.journalOffset,
      );
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(
        chunk,
        0,
        length,
        run.journalOffset,
      );
      if (bytesRead === 0) break;
      run.journalOffset += bytesRead;
      const decoded = run.journalDecoder.decode(
        chunk.subarray(0, bytesRead),
        { stream: true },
      );
      const additions = `${run.journalTail}${decoded}`.split("\n");
      run.journalTail = additions.pop();
      lines.push(...additions.filter(Boolean));
    }
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Unable to read workflow journal");
  } finally {
    await file?.close();
  }
}

function fallbackProgressMetadata(agentId) {
  return {
    phase: null,
    role: null,
    label: `leaf-${agentId.slice(0, 8)}`,
  };
}

function validateProgressMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.phase !== "string" ||
    value.phase.length < 1 ||
    value.phase.length > 80
  ) {
    return null;
  }
  if (
    typeof value.role !== "string" ||
    value.role.length < 1 ||
    value.role.length > 80
  ) {
    return null;
  }
  if (
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 80
  ) {
    return null;
  }
  return { phase: value.phase, role: value.role, label: value.label };
}

function progressMetadataFromText(text, agentId) {
  const match = PROGRESS_PATTERN.exec(text);
  if (!match) return fallbackProgressMetadata(agentId);
  try {
    return (
      validateProgressMetadata(JSON.parse(match[1])) ??
      fallbackProgressMetadata(agentId)
    );
  } catch {
    return fallbackProgressMetadata(agentId);
  }
}

function userRecordText(record) {
  if (record?.type !== "user" || record?.message?.role !== "user") {
    return undefined;
  }
  const { content } = record.message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) => block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

async function readProgressMetadata(run, agentId, forceFallback = false) {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("Claude Code returned an invalid workflow journal");
  }

  const resolvedTranscriptRoot = resolve(run.transcriptRoot);
  const candidate = resolve(
    resolvedTranscriptRoot,
    `agent-${agentId}.jsonl`,
  );
  if (dirname(candidate) !== resolvedTranscriptRoot) {
    throw new Error("Claude Code returned an invalid workflow journal");
  }

  let file;
  try {
    file = await open(candidate, "r");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    let tail = "";
    while (offset < MAX_TRANSCRIPT_PREFIX_BYTES) {
      const length = Math.min(
        JOURNAL_CHUNK_BYTES,
        MAX_TRANSCRIPT_PREFIX_BYTES - offset,
      );
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const decoded = decoder.decode(chunk.subarray(0, bytesRead), {
        stream: true,
      });
      const lines = `${tail}${decoded}`.split("\n");
      tail = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          return fallbackProgressMetadata(agentId);
        }
        const text = userRecordText(record);
        if (text !== undefined) {
          return progressMetadataFromText(text, agentId);
        }
      }
    }
    return offset >= MAX_TRANSCRIPT_PREFIX_BYTES || forceFallback
      ? fallbackProgressMetadata(agentId)
      : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return forceFallback ? fallbackProgressMetadata(agentId) : undefined;
    }
    throw new Error("Unable to read workflow transcript");
  } finally {
    await file?.close();
  }
}

async function processJournalEvents(run, events, forceFallback = false) {
  const observedAt = Date.now();
  run.pendingJournalEvents.push(
    ...events.map((event) => ({ event, observedAt })),
  );
  while (!run.terminal && run.pendingJournalEvents.length > 0) {
    const pending = run.pendingJournalEvents[0];
    const { event } = pending;
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      !["started", "result"].includes(event.type) ||
      typeof event.agentId !== "string" ||
      !AGENT_ID_PATTERN.test(event.agentId)
    ) {
      throw new Error("Claude Code returned an invalid workflow journal");
    }

    if (event.type === "started") {
      if (run.leaves.has(event.agentId)) {
        throw new Error("Claude Code returned an invalid workflow journal");
      }
      const metadata = await readProgressMetadata(
        run,
        event.agentId,
        forceFallback,
      );
      if (run.terminal) return;
      if (!metadata) return;
      run.pendingJournalEvents.shift();
      const leaf = {
        id: event.agentId,
        ...metadata,
        status: "active",
        startedAt: pending.observedAt,
        finishedAt: undefined,
      };
      run.leaves.set(leaf.id, leaf);
      run.currentPhase = leaf.phase;
      appendEvent(run, {
        type: "leaf_started",
        id: leaf.id,
        phase: leaf.phase,
        role: leaf.role,
        label: leaf.label,
      });
      continue;
    }

    const leaf = run.leaves.get(event.agentId);
    if (!leaf || leaf.status !== "active") {
      throw new Error("Claude Code returned an invalid workflow journal");
    }
    run.pendingJournalEvents.shift();
    leaf.status = "completed";
    leaf.finishedAt = Date.now();
    appendEvent(run, {
      type: "leaf_completed",
      id: leaf.id,
      phase: leaf.phase,
      role: leaf.role,
      label: leaf.label,
      durationMs: leaf.finishedAt - leaf.startedAt,
    });
  }
}

function flushJournalDecoder(run) {
  try {
    const tail = `${run.journalTail}${run.journalDecoder.decode()}`;
    run.journalTail = "";
    return tail ? [JSON.parse(tail)] : [];
  } catch {
    throw new Error("Unable to read workflow journal");
  }
}

async function waitAtTestGate(run, point) {
  const gateDir = process.env.CODEX_WORKFLOW_TEST_GATE_DIR;
  if (!gateDir) return;
  const gate = join(gateDir, `${run.runId}.${point}`);
  try {
    await readFile(`${gate}.block`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Unable to coordinate workflow watcher");
  }
  try {
    await writeFile(`${gate}.ready`, "ready");
    while (true) {
      try {
        await readFile(`${gate}.release`);
        return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(5);
    }
  } catch {
    throw new Error("Unable to coordinate workflow watcher");
  }
}

async function readNativeState(run) {
  try {
    const state = JSON.parse(await readFile(run.statePath, "utf8"));
    await waitAtTestGate(run, "after-state-read");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Unable to read workflow state");
  }
}

async function watchRun(run) {
  while (!run.terminal) {
    const additions = await readJournalAdditions(run);
    if (run.terminal) return;
    await processJournalEvents(run, additions);
    if (run.terminal) return;
    await waitAtTestGate(run, "after-journal");
    if (run.terminal) return;

    let state = await readNativeState(run);
    if (run.terminal) return;
    if (!state && run.childExited) {
      state = await readNativeState(run);
      if (run.terminal) return;
    }
    if (state) {
      await finishFromNativeState(run, state);
      return;
    }
    if (run.childExited) {
      run.failureMessage = "Claude Code stopped before workflow completion";
      finishRun(run, "failed");
      return;
    }
    await delay(POLL_INTERVAL_MS);
    if (run.terminal) return;
  }
}

async function finishFromNativeState(run, state) {
  if (
    !state ||
    state.runId !== run.runId ||
    !["completed", "failed", "killed"].includes(state.status)
  ) {
    throw new Error("Claude Code returned an invalid workflow state");
  }

  const additions = await readJournalAdditions(run);
  if (run.terminal) return;
  await processJournalEvents(run, additions, true);
  if (run.terminal) return;
  await processJournalEvents(run, flushJournalDecoder(run), true);
  if (run.terminal) return;
  finishRun(run, state.status, state);
}

function appendEvent(run, event) {
  run.revision += 1;
  run.events.push({ revision: run.revision, ...event });
  for (const resolveWaiter of run.waiters) resolveWaiter();
  run.waiters.clear();
}

function failOpenLeaves(run) {
  for (const leaf of run.leaves.values()) {
    if (leaf.status !== "active") continue;
    leaf.status = "failed";
    leaf.finishedAt = run.finishedAt;
    appendEvent(run, {
      type: "leaf_failed",
      id: leaf.id,
      phase: leaf.phase,
      role: leaf.role,
      label: leaf.label,
      durationMs: leaf.finishedAt - leaf.startedAt,
    });
  }
}

function finishRun(run, status, terminalState) {
  if (run.terminal) return false;
  run.terminal = true;
  run.status = status;
  run.finishedAt = Date.now();
  run.terminalState = terminalState;
  run.result = terminalState?.result;
  failOpenLeaves(run);
  appendEvent(run, { type: `workflow_${status}` });
  run.close();
  return true;
}

function snapshotRun(run, afterRevision) {
  const now = run.finishedAt ?? Date.now();
  const counts = { started: 0, active: 0, completed: 0, failed: 0 };
  const activeLeaves = [];
  for (const leaf of run.leaves.values()) {
    counts.started += 1;
    if (leaf.status === "active") {
      counts.active += 1;
      activeLeaves.push({
        id: leaf.id,
        phase: leaf.phase,
        role: leaf.role,
        label: leaf.label,
        elapsedMs: now - leaf.startedAt,
      });
    } else if (leaf.status === "completed") {
      counts.completed += 1;
    } else {
      counts.failed += 1;
    }
  }

  const snapshot = {
    runId: run.runId,
    status: run.status,
    revision: run.revision,
    elapsedMs: now - run.startedAt,
    currentPhase: run.currentPhase,
    counts,
    activeLeaves,
    events: run.events.filter((event) => event.revision > afterRevision),
  };
  if (run.terminal && run.result !== undefined) snapshot.result = run.result;
  return snapshot;
}

async function waitForUpdate(run, afterRevision) {
  if (!run.terminal && run.revision <= afterRevision) {
    await new Promise((resolveWaiter) => {
      run.waiters.add(resolveWaiter);
    });
  }
  return snapshotRun(run, afterRevision);
}

function stopWorkflow(run) {
  finishRun(run, "killed");
  return snapshotRun(run, 0);
}

async function runWorkflow(nativeArguments, cwd, allowEdits) {
  const run = await startWorkflow(nativeArguments, cwd, allowEdits);
  while (!run.terminal) await delay(POLL_INTERVAL_MS);
  if (run.status === "completed") return run.terminalState;
  if (run.status === "killed") throw new Error("Workflow was killed");
  throw new Error(run.failureMessage || "Workflow failed");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolSuccess(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    })}\n`,
  );
}

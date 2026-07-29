#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.2.0";
const INNER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_STATUS_WAIT_MS = 20_000;
const MAX_TRANSCRIPT_PREFIX_BYTES = 16 * 1024 * 1024;
const JOURNAL_CHUNK_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 250;
const MAX_SCRIPT_LENGTH = 524_288;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const PROVIDER_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
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
      minLength: 1,
      maxLength: MAX_SCRIPT_LENGTH,
    },
    args: {},
  },
  required: ["cwd", "script"],
  additionalProperties: false,
};

const workflowStartTool = {
  name: "WorkflowStart",
  description: "Start a Claude Code Dynamic Workflow in a workspace.",
  inputSchema: workflowInputSchema,
};

const workflowStatusTool = {
  name: "WorkflowStatus",
  description: "Read progress and terminal status for a workflow run.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", minLength: 1 },
      afterRevision: { type: "integer", minimum: 0, default: 0 },
      waitMs: {
        type: "integer",
        minimum: 0,
        maximum: MAX_STATUS_WAIT_MS,
        default: 0,
      },
    },
    required: ["runId"],
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
  workflowStatusTool,
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
  if (providerConfigError() === null) return;

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
          "Use WorkflowStart, then poll WorkflowStatus with its latest revision until terminal. " +
          "Report phase/role/leaf changes and heartbeat updates. Use WorkflowStop when the run is cancelled.",
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
      case "WorkflowStatus":
        return await callWorkflowStatus(params.arguments);
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
  if (!asynchronous) return toolSuccess(await runWorkflow(nativeArguments, args.cwd));

  const run = await startWorkflow(nativeArguments, args.cwd);
  return toolSuccess({
    runId: run.runId,
    status: "starting",
    revision: 0,
    elapsedMs: 0,
  });
}

async function callWorkflowStatus(args) {
  const validationError = validateStatusArguments(args);
  if (validationError) return toolError(validationError);

  const run = runs.get(args.runId);
  if (!run) return toolError("Unknown workflow run");
  return toolSuccess(
    await waitForStatus(run, args.afterRevision ?? 0, args.waitMs ?? 0),
  );
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
      (key) => key !== "cwd" && key !== "script" && key !== "args",
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
  return null;
}

function validateStatusArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "WorkflowStatus arguments must be an object";
  }
  if (
    Object.keys(args).some(
      (key) =>
        key !== "runId" && key !== "afterRevision" && key !== "waitMs",
    )
  ) {
    return "WorkflowStatus received an unsupported argument";
  }
  if (typeof args.runId !== "string" || !args.runId) {
    return "WorkflowStatus runId must be a non-empty string";
  }

  const afterRevision = args.afterRevision ?? 0;
  if (!Number.isInteger(afterRevision) || afterRevision < 0) {
    return "WorkflowStatus afterRevision must be a non-negative integer";
  }
  const waitMs = args.waitMs ?? 0;
  if (
    !Number.isInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > MAX_STATUS_WAIT_MS
  ) {
    return `WorkflowStatus waitMs must be an integer between 0 and ${MAX_STATUS_WAIT_MS}`;
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

async function startWorkflow(nativeArguments, cwd) {
  const configError = providerConfigError();
  if (configError) throw new Error(configError);

  const native = startNativeClient(cwd);
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
    const run = {
      runId: launch.runId,
      child: native.child,
      close: native.close,
      startedAt: Date.now(),
      finishedAt: undefined,
      status: "running",
      revision: 0,
      events: [],
      leaves: new Map(),
      currentPhase: null,
      statePath: join(workflowRoot, `${launch.runId}.json`),
      transcriptRoot: join(
        dirname(workflowRoot),
        "subagents",
        "workflows",
        launch.runId,
      ),
      terminalState: undefined,
      result: undefined,
      terminal: false,
    };
    runs.set(run.runId, run);
    native.child.once("exit", () => {
      if (run.terminal) return;
      run.failureMessage = "Claude Code stopped before workflow completion";
      finishRun(run, "failed");
    });
    if (native.child.exitCode !== null || native.child.signalCode !== null) {
      run.failureMessage = "Claude Code stopped before workflow completion";
      finishRun(run, "failed");
    } else {
      void watchRun(run).catch(() => {
        finishRun(run, "failed");
      });
    }
    return run;
  } catch (error) {
    native.close();
    throw error;
  }
}

function startNativeClient(cwd) {
  const child = spawn("claude", ["mcp", "serve"], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CODE_WORKFLOWS: "1",
      ANTHROPIC_MODEL: "glm-5.2",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.2",
    },
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
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    children.delete(child);
  };

  return { child, request, notify, close };
}

function parseNativeLaunch(nativeResult) {
  if (nativeResult?.isError) {
    throw new Error("Claude Code rejected the workflow");
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

async function readNativeState(run) {
  try {
    return JSON.parse(await readFile(run.statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw new Error("Unable to read workflow state");
  }
}

async function watchRun(run) {
  while (!run.terminal) {
    const state = await readNativeState(run);
    if (run.terminal) return;
    if (state) {
      finishFromNativeState(run, state);
      return;
    }
    await delay(POLL_INTERVAL_MS);
    if (run.terminal) return;
  }
}

function finishFromNativeState(run, state) {
  if (
    !state ||
    state.runId !== run.runId ||
    !["completed", "failed", "killed"].includes(state.status)
  ) {
    throw new Error("Claude Code returned an invalid workflow state");
  }
  finishRun(run, state.status, state);
}

function appendEvent(run, event) {
  run.revision += 1;
  run.events.push({ revision: run.revision, ...event });
}

function finishRun(run, status, terminalState) {
  if (run.terminal) return false;
  run.terminal = true;
  run.status = status;
  run.finishedAt = Date.now();
  run.terminalState = terminalState;
  run.result = terminalState?.result;
  appendEvent(run, { type: `workflow_${status}` });
  run.close();
  return true;
}

function snapshotRun(run, afterRevision, heartbeat) {
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
    heartbeat,
    elapsedMs: now - run.startedAt,
    currentPhase: run.currentPhase,
    counts,
    activeLeaves,
    events: run.events.filter((event) => event.revision > afterRevision),
  };
  if (run.terminal && run.result !== undefined) snapshot.result = run.result;
  return snapshot;
}

async function waitForStatus(run, afterRevision, waitMs) {
  const deadline = Date.now() + waitMs;
  while (
    !run.terminal &&
    run.revision <= afterRevision &&
    Date.now() < deadline
  ) {
    await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
  }
  const heartbeat = !run.terminal && run.revision <= afterRevision;
  return snapshotRun(run, afterRevision, heartbeat);
}

function stopWorkflow(run) {
  finishRun(run, "killed");
  return snapshotRun(run, 0, false);
}

async function runWorkflow(nativeArguments, cwd) {
  const run = await startWorkflow(nativeArguments, cwd);
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

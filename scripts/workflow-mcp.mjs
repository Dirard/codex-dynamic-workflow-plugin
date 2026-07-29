#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const WORKFLOW_TIMEOUT_MS = 600_000;
const MAX_SCRIPT_LENGTH = 524_288;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const PROVIDER_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);
const children = new Set();

await loadProviderEnv();

const workflowTool = {
  name: "Workflow",
  description:
    "Execute an exact Claude Code Dynamic Workflow script in a workspace and wait for completion.",
  inputSchema: {
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
  },
};

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
          version: "0.1.0",
        },
      });
      return;
    case "ping":
      writeResult(message.id, {});
      return;
    case "tools/list":
      writeResult(message.id, { tools: [workflowTool] });
      return;
    case "tools/call":
      writeResult(message.id, await callTool(message.params));
      return;
    default:
      writeError(message.id, -32601, "Method not found");
  }
}

async function callTool(params) {
  if (params?.name !== "Workflow") return toolError("Unknown tool");

  const args = params.arguments;
  const validationError = validateArguments(args);
  if (validationError) return toolError(validationError);

  const nativeArguments = { script: args.script };
  if (Object.hasOwn(args, "args")) nativeArguments.args = args.args;

  try {
    const result = await runWorkflow(nativeArguments, args.cwd);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: false,
    };
  } catch (error) {
    return toolError(
      error instanceof Error ? error.message : "Workflow execution failed",
    );
  }
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

async function runWorkflow(nativeArguments, cwd) {
  const configError = providerConfigError();
  if (configError) throw new Error(configError);

  const deadline = Date.now() + WORKFLOW_TIMEOUT_MS;
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
  let protocolBroken = false;

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
      protocolBroken = true;
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
    const id = nextId++;
    const timeout = Math.max(1, Math.min(15_000, deadline - Date.now()));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Claude Code did not respond"));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };

  try {
    await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codex-dynamic-workflow", version: "0.1.0" },
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );

    const nativeResult = await request("tools/call", {
      name: "Workflow",
      arguments: nativeArguments,
    });
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

    return await waitForWorkflow(
      launch,
      deadline,
      () => childStopped || protocolBroken,
    );
  } finally {
    reader.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    children.delete(child);
  }
}

async function waitForWorkflow(launch, deadline, childUnavailable) {
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

  const statePath = join(dirname(dirname(scriptPath)), `${runId}.json`);
  while (Date.now() < deadline) {
    let state;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw new Error("Unable to read workflow state");
      }
    }

    if (state) {
      if (state.runId !== runId) {
        throw new Error("Claude Code returned an invalid workflow state");
      }
      if (state.status === "completed") return state;
      if (state.status === "failed") throw new Error("Workflow failed");
      if (state.status === "killed") throw new Error("Workflow was killed");
    }
    if (childUnavailable()) {
      throw new Error("Claude Code stopped before workflow completion");
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, deadline - Date.now())),
    );
  }
  throw new Error("Workflow timed out after 600 seconds");
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

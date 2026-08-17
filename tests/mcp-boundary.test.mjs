import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url)).replace(
  /[/\\]$/,
  "",
);
const config = JSON.parse(
  await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
);
const server = config.mcpServers["claude-workflow"];

const canaryScript = `export const meta = {
  name: "readonly-parallel-canary",
  description: "Run two independent read-only reviews and synthesize them",
  phases: [
    {
      title: "Review",
      detail: "Two read-only reviewers inspect the workspace in parallel",
    },
    {
      title: "Synthesize",
      detail: "Synthesize the independent reviews",
    },
  ],
};

const RESULT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

function leaf(phaseName, role, label, prompt, options = {}) {
  const progress = JSON.stringify({ phase: phaseName, role, label });
  return agent(
    \`<codex-workflow-progress>\${progress}</codex-workflow-progress>\\n\${prompt}\`,
    { ...options, label, phase: phaseName },
  );
}

phase("Review");
const [structure, documentation] = await parallel([
  () =>
    leaf(
      "Review",
      "architecture",
      "review-architecture",
      "Inspect the workspace structure without modifying anything. Return a concise summary.",
      { schema: RESULT_SCHEMA },
    ),
  () =>
    leaf(
      "Review",
      "product",
      "review-product",
      "Inspect project documentation without modifying anything. Return a concise summary.",
      { schema: RESULT_SCHEMA },
    ),
]);

phase("Synthesize");
const synthesis = await leaf(
  "Synthesize",
  "synthesis",
  "synthesize-reviews",
  \`Synthesize both inspections without new research.\\n\${JSON.stringify({
    structure,
    documentation,
  })}\`,
  { schema: RESULT_SCHEMA },
);

return { structure, documentation, synthesis };`;

function parseToolPayload(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, `Missing MCP text result: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function assertToolSuccess(result, name) {
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
}

async function waitWorkflowToTerminal(
  client,
  launch,
  deadline,
  now = Date.now,
) {
  let afterRevision = launch.revision;
  const events = [];
  let terminal = false;

  try {
    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("Live workflow canary timed out");
      const result = await client.request(
        "tools/call",
        {
          name: "WorkflowWait",
          arguments: { runId: launch.runId, afterRevision },
        },
        remaining,
      );
      assertToolSuccess(result, "WorkflowWait");
      const snapshot = parseToolPayload(result);
      events.push(...snapshot.events);
      afterRevision = snapshot.revision;
      if (["completed", "failed", "killed"].includes(snapshot.status)) {
        terminal = true;
        return { ...snapshot, events };
      }
    }
  } finally {
    if (!terminal) {
      const stopped = await client.request("tools/call", {
        name: "WorkflowStop",
        arguments: { runId: launch.runId },
      });
      assertToolSuccess(stopped, "WorkflowStop");
    }
  }
}

test("canary waiting uses each returned revision until terminal", async () => {
  const calls = [];
  const snapshots = [
    {
      status: "running",
      revision: 2,
      events: [{ type: "leaf_started", role: "architecture" }],
    },
    {
      status: "completed",
      revision: 4,
      events: [{ type: "workflow_completed" }],
      result: { ok: true },
    },
  ];
  const client = {
    async request(method, params, timeout) {
      calls.push({ method, params, timeout });
      return {
        content: [{ type: "text", text: JSON.stringify(snapshots.shift()) }],
      };
    },
  };

  const completed = await waitWorkflowToTerminal(
    client,
    { runId: "wf_canary", revision: 0 },
    40_000,
    () => 0,
  );

  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.events, [
    { type: "leaf_started", role: "architecture" },
    { type: "workflow_completed" },
  ]);
  assert.deepEqual(
    calls.map(({ params, timeout }) => ({ ...params, timeout })),
    [
      {
        name: "WorkflowWait",
        arguments: {
          runId: "wf_canary",
          afterRevision: 0,
        },
        timeout: 40_000,
      },
      {
        name: "WorkflowWait",
        arguments: {
          runId: "wf_canary",
          afterRevision: 2,
        },
        timeout: 40_000,
      },
    ],
  );
});

test("canary waiting stops the run when its test deadline expires", async () => {
  const calls = [];
  const client = {
    async request(method, params, timeout) {
      calls.push({ method, params, timeout });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "killed", runId: "wf_canary" }),
          },
        ],
      };
    },
  };

  await assert.rejects(
    waitWorkflowToTerminal(
      client,
      { runId: "wf_canary", revision: 0 },
      100,
      () => 100,
    ),
    /timed out/,
  );
  assert.deepEqual(
    calls.map(({ params }) => params),
    [
      {
        name: "WorkflowStop",
        arguments: { runId: "wf_canary" },
      },
    ],
  );
});

async function initialize(client) {
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-06-18");
  assert.equal(initialized.serverInfo.version, "0.5.1");
  client.notify("notifications/initialized");
  return initialized;
}

async function waitForFileText(path, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")) === expected) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}`);
}

async function createWorkflowClaude(t) {
  const fakeBin = await mkdtemp(join(tmpdir(), "codex-workflow-mcp-"));
  const stateRoot = join(fakeBin, "state");
  const fakeClaude = join(fakeBin, "claude");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const stateRoot =
  process.env.FAKE_WORKFLOW_STATE_ROOT || path.join(path.dirname(process.argv[1]), "state");
const runId =
  process.env.FAKE_WORKFLOW_UNIQUE_RUNS === "1"
    ? "wf_child-" + process.pid
    : "wf_fixture";
const lifecyclePath =
  process.env.FAKE_WORKFLOW_MARKER ||
  (process.env.FAKE_WORKFLOW_MARKER_ROOT
    ? path.join(process.env.FAKE_WORKFLOW_MARKER_ROOT, runId)
    : null);
const statePath = path.join(stateRoot, runId + ".json");
const transcriptRoot = path.join(
  path.dirname(stateRoot),
  "subagents",
  "workflows",
  runId,
);
const journalPath = path.join(transcriptRoot, "journal.jsonl");
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
};

if (lifecyclePath) {
  fs.mkdirSync(path.dirname(lifecyclePath), { recursive: true });
  fs.writeFileSync(lifecyclePath, "running");
  process.once("SIGTERM", () => {
    fs.writeFileSync(lifecyclePath, "terminated");
    process.exit(0);
  });
}

function readMode() {
  const modePath = path.join(stateRoot, "mode");
  if (fs.existsSync(modePath)) return fs.readFileSync(modePath, "utf8").trim();
  return process.env.FAKE_WORKFLOW_MODE || "complete";
}

function resetRunFiles() {
  fs.rmSync(statePath, { force: true });
  fs.rmSync(transcriptRoot, { recursive: true, force: true });
  fs.mkdirSync(transcriptRoot, { recursive: true });
  fs.mkdirSync(path.join(stateRoot, "scripts"), { recursive: true });
}

function writeState(status = "completed") {
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      runId,
      status,
      result: {
        cwd: process.cwd(),
        argv: process.argv.slice(2),
        model: process.env.ANTHROPIC_MODEL,
        subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
      },
    }),
  );
}

function markerText() {
  return (
    '<codex-workflow-progress>{"phase":"Inspect","role":"correctness",' +
    '"label":"inspect-readme"}</codex-workflow-progress>'
  );
}

function writeTranscript(mode, agentId) {
  if (mode === "invalid-agent") return;
  if (mode === "pending-transcript") {
    fs.writeFileSync(
      path.join(transcriptRoot, "agent-" + agentId + ".jsonl"),
      '{"type":"user","message":{"role":"user","content":',
    );
    return;
  }
  let records;
  if (mode === "later-marker") {
    records = [
      {
        type: "user",
        message: { role: "user", content: "No progress metadata here" },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: markerText() },
      },
      {
        type: "tool",
        message: { role: "tool", content: markerText() },
      },
    ];
  } else {
    const prefix = mode === "large-user" ? "x".repeat(9 * 1024) : "";
    records = [
      {
        type: "user",
        message: {
          role: "user",
          content: prefix + markerText() + "\\nSECRET_PROMPT_TEXT",
        },
      },
    ];
  }
  fs.writeFileSync(
    path.join(transcriptRoot, "agent-" + agentId + ".jsonl"),
    records.map((record) => JSON.stringify(record)).join("\\n") + "\\n",
  );
}

function appendJournal(value) {
  fs.appendFileSync(journalPath, JSON.stringify(value) + "\\n");
}

function scheduleState(status, delay = 50) {
  setTimeout(() => writeState(status), delay);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, "id")) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-claude", version: "1.0.0" },
    });
    return;
  }
  if (message.method !== "tools/call") return;

  resetRunFiles();
  const mode =
    process.env.FAKE_WORKFLOW_PROGRESS === "1" ? "progress" : readMode();
  const agentId = process.env.FAKE_WORKFLOW_AGENT_ID || "agentone";

  if (mode === "rejected") {
    respond(message.id, {
      content: [
        { type: "text", text: "  " },
        { type: "text", text: "Workflow script must be JavaScript" },
      ],
      isError: true,
    });
    return;
  }

  if (
    [
      "progress",
      "terminal-drain",
      "failed-leaf",
      "later-marker",
      "large-user",
      "invalid-agent",
      "pending-transcript",
      "split-journal",
    ].includes(mode)
  ) {
    writeTranscript(mode, agentId);
  }

  if (mode === "split-journal") {
    const prefix =
      '{"type":"started","agentId":"' + agentId + '","padding":"';
    const paddingLength = 65_535 - Buffer.byteLength(prefix);
    const firstLine =
      prefix + "a".repeat(paddingLength) + "é" + '"}\\n';
    fs.writeFileSync(
      journalPath,
      firstLine +
        JSON.stringify({
          type: "result",
          agentId,
          result: "SECRET_LEAF_RESULT",
        }) +
        "\\n",
    );
    scheduleState("completed");
  } else if (mode === "malformed-journal") {
    fs.writeFileSync(journalPath, '{"type":\\n');
  } else if (
    [
      "progress",
      "terminal-drain",
      "failed-leaf",
      "later-marker",
      "large-user",
      "invalid-agent",
      "missing-transcript",
      "pending-transcript",
    ].includes(mode)
  ) {
    appendJournal({ type: "started", agentId });
    if (mode === "failed-leaf") scheduleState("failed");
    if (["later-marker", "large-user", "invalid-agent"].includes(mode)) {
      appendJournal({
        type: "result",
        agentId,
        result: "SECRET_LEAF_RESULT",
      });
      scheduleState("completed");
    }
  } else if (mode === "malformed-state") {
    fs.writeFileSync(statePath, "{");
  } else if (mode === "exit") {
    setTimeout(() => process.exit(23), 20);
  } else if (
    mode !== "no-state" &&
    process.env.FAKE_WORKFLOW_NO_STATE !== "1"
  ) {
    scheduleState(
      process.env.FAKE_WORKFLOW_STATUS || "completed",
      Number(process.env.FAKE_WORKFLOW_STATE_DELAY_MS || 0),
    );
  }

  respond(message.id, {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "async_launched",
        runId,
        scriptPath: path.join(stateRoot, "scripts", "workflow.js"),
      }),
    }],
    isError: false,
  });

  if (mode === "progress") {
    let resultWritten = false;
    const timer = setInterval(() => {
      if (
        !resultWritten &&
        fs.existsSync(path.join(stateRoot, runId + ".release-result"))
      ) {
        appendJournal({
          type: "result",
          agentId,
          result: "SECRET_LEAF_RESULT",
        });
        resultWritten = true;
      }
      if (
        resultWritten &&
        fs.existsSync(path.join(stateRoot, runId + ".release-state"))
      ) {
        clearInterval(timer);
        writeState("completed");
      }
    }, 5);
  }
});
`,
  );
  await chmod(fakeClaude, 0o755);
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  return { fakeBin, stateRoot };
}

async function setFakeWorkflowMode(stateRoot, mode) {
  await writeFile(join(stateRoot, "mode"), mode);
}

async function startFakeWorkflow(client) {
  const started = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "progress", description: "Progress" };\nreturn { ok: true };',
    },
  });
  assertToolSuccess(started, "WorkflowStart");
  return parseToolPayload(started);
}

async function startFakeProgressClient(t, env = {}) {
  const { fakeBin, stateRoot } = await createWorkflowClaude(t);
  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_ROOT: stateRoot,
    FAKE_WORKFLOW_PROGRESS: "1",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
    ...env,
  });
  t.after(() => client.stop());
  await initialize(client);
  return { client, stateRoot };
}

async function startFakeModeClient(t, mode, env = {}) {
  const { fakeBin, stateRoot } = await createWorkflowClaude(t);
  await setFakeWorkflowMode(stateRoot, mode);
  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_ROOT: stateRoot,
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
    ...env,
  });
  t.after(() => client.stop());
  await initialize(client);
  return { client, stateRoot };
}

function fakeJournalPath(stateRoot, runId) {
  return join(
    dirname(stateRoot),
    "subagents",
    "workflows",
    runId,
    "journal.jsonl",
  );
}

function fakeTranscriptPath(stateRoot, runId, agentId = "agentone") {
  return join(
    dirname(stateRoot),
    "subagents",
    "workflows",
    runId,
    `agent-${agentId}.jsonl`,
  );
}

async function createWatcherGate(t, point, runId = "wf_fixture") {
  const gateDir = await mkdtemp(join(tmpdir(), "codex-workflow-gate-"));
  t.after(() => rm(gateDir, { recursive: true, force: true }));
  await writeFile(join(gateDir, `${runId}.${point}.block`), "");
  return {
    gateDir,
    ready: join(gateDir, `${runId}.${point}.ready`),
    release: join(gateDir, `${runId}.${point}.release`),
  };
}

async function createPartialReadHook(t) {
  const hookRoot = await mkdtemp(join(tmpdir(), "codex-workflow-read-hook-"));
  const hookPath = join(hookRoot, "partial-read.mjs");
  const markerPath = join(hookRoot, "partial-read-observed");
  t.after(() => rm(hookRoot, { recursive: true, force: true }));
  await writeFile(
    hookPath,
    `import { open } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const probe = await open(new URL(import.meta.url));
const fileHandlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalRead = fileHandlePrototype.read;
fileHandlePrototype.read = async function (buffer, offset, length, position) {
  const limitedLength = Math.min(length, 32 * 1024);
  const result = await originalRead.call(
    this,
    buffer,
    offset,
    limitedLength,
    position,
  );
  if (limitedLength < length && result.bytesRead === limitedLength) {
    writeFileSync(${JSON.stringify(markerPath)}, "partial");
  }
  return result;
};
`,
  );
  return { hookPath, markerPath };
}

function terminalWorkflowEvents(snapshot) {
  return snapshot.events.filter((event) =>
    ["workflow_completed", "workflow_failed", "workflow_killed"].includes(
      event.type,
    ),
  );
}

async function assertPending(promise) {
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(settled, false);
}

async function collectWorkflowEvents(client, runId) {
  let afterRevision = 0;
  const events = [];
  while (true) {
    const result = await client.request("tools/call", {
      name: "WorkflowWait",
      arguments: { runId, afterRevision },
    });
    assertToolSuccess(result, "WorkflowWait");
    const snapshot = parseToolPayload(result);
    events.push(...snapshot.events);
    afterRevision = snapshot.revision;
    if (snapshot.status !== "running") return { ...snapshot, events };
  }
}

test("plugin starts its bundled native-workflow adapter", () => {
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./scripts/workflow-mcp.mjs"]);
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.env_vars, [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "WORKFLOW_MODEL",
    "WORKFLOW_MIN_QUOTA_REMAINING_PERCENT",
    "WORKFLOW_QUOTA_URL",
    "XDG_CONFIG_HOME",
  ]);
  assert.equal(server.tool_timeout_sec, 31_536_000);
});

test("native-workflow allows implicit invocation", async () => {
  const config = await readFile(
    new URL("../skills/native-workflow/agents/openai.yaml", import.meta.url),
    "utf8",
  );
  assert.match(config, /allow_implicit_invocation:\s*true/);
});

function startClient(env = {}) {
  const child = spawn(server.command, server.args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...server.env,
      WORKFLOW_MIN_QUOTA_REMAINING_PERCENT:
        env.WORKFLOW_MIN_QUOTA_REMAINING_PERCENT ?? "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  function rejectPending(reason) {
    const error =
      reason instanceof Error
        ? reason
        : new Error(`workflow MCP adapter exited (${reason}): ${stderr}`);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  child.on("error", rejectPending);
  child.on("exit", (code, signal) => rejectPending(code ?? signal));

  function request(method, params, timeout = 15_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  return {
    request,
    notify,
    closeInput() {
      child.stdin.end();
    },
    stop() {
      child.kill("SIGTERM");
    },
  };
}

async function startQuotaServer(t, limits, status = 200) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    response.statusCode = status;
    response.end(
      JSON.stringify({
        code: status,
        msg: "",
        data: { level: "max", limits },
        success: status === 200,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    url: `http://127.0.0.1:${server.address().port}/quota`,
    requests,
  };
}

async function startRawQuotaServer(t, body, contentType = "application/json") {
  const server = createServer((request, response) => {
    response.setHeader("content-type", contentType);
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/quota`;
}

async function startQuotaClient(t, url) {
  const client = startClient({
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    WORKFLOW_QUOTA_URL: url,
  });
  t.after(() => client.stop());
  await initialize(client);
  return client;
}

async function assertQuotaFailure(client, message) {
  const result = await client.request("tools/call", {
    name: "WorkflowQuota",
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, message);
}

test("configured MCP publishes the workflow lifecycle tools", async (t) => {
  const client = startClient();
  t.after(() => client.stop());
  await initialize(client);

  const { tools } = await client.request("tools/list", {});
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "Workflow",
    "WorkflowQuota",
    "WorkflowStart",
    "WorkflowStop",
    "WorkflowWait",
  ]);
  assert.deepEqual(byName.WorkflowStart.inputSchema.required, ["cwd", "script"]);
  assert.equal(
    byName.WorkflowStart.inputSchema.properties.allowEdits.type,
    "boolean",
  );
  assert.match(
    byName.WorkflowStart.inputSchema.properties.allowEdits.description,
    /acceptEdits.*cwd/i,
  );
  assert.match(byName.WorkflowStart.description, /exact JavaScript/i);
  assert.match(
    byName.WorkflowStart.inputSchema.properties.script.description,
    /not.*natural-language task/i,
  );
  assert.deepEqual(byName.WorkflowWait.inputSchema.required, [
    "runId",
    "afterRevision",
  ]);
  assert.deepEqual(byName.WorkflowStop.inputSchema.required, ["runId"]);
  assert.deepEqual(byName.WorkflowQuota.inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("WorkflowQuota identifies the five-hour quota before its reset starts", async (t) => {
  const quota = await startQuotaServer(t, [
    {
      type: "TIME_LIMIT",
      unit: 5,
      number: 1,
      percentage: 10,
      nextResetTime: Date.now() + 7 * 24 * 3_600_000,
    },
    {
      type: "TOKENS_LIMIT",
      unit: 4,
      number: 1,
      percentage: 99,
      nextResetTime: Date.now() + 600_000,
    },
    {
      type: "TOKENS_LIMIT",
      unit: 3,
      number: 5,
      percentage: 25.5,
    },
  ]);
  const client = startClient({
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    WORKFLOW_MIN_QUOTA_REMAINING_PERCENT: "101",
    WORKFLOW_QUOTA_URL: quota.url,
  });
  t.after(() => client.stop());
  await initialize(client);

  const invalidArguments = await client.request("tools/call", {
    name: "WorkflowQuota",
    arguments: { unexpected: true },
  });
  assert.equal(invalidArguments.isError, true);
  assert.equal(invalidArguments.content[0].text, "WorkflowQuota received an unsupported argument");

  const result = await client.request("tools/call", {
    name: "WorkflowQuota",
  });
  assertToolSuccess(result, "WorkflowQuota");
  assert.deepEqual(parseToolPayload(result), {
    level: "max",
    usedPercent: 25.5,
    remainingPercent: 74.5,
    resetAt: null,
  });
  assert.deepEqual(quota.requests.map((request) => request.method), ["GET"]);
  assert.equal(quota.requests[0].url, "/quota");
  assert.equal(quota.requests[0].authorization, "quota-test-token");
});

test("a decimal custom quota threshold blocks WorkflowStart before Claude spawns", async (t) => {
  const marker = join(tmpdir(), `quota-blocked-${process.pid}`);
  const quota = await startQuotaServer(t, [
    {
      type: "TOKENS_LIMIT",
      unit: 3,
      number: 5,
      percentage: 87.6,
      nextResetTime: Date.now() + 3_600_000,
    },
  ]);
  const { client } = await startFakeModeClient(t, "complete", {
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    FAKE_WORKFLOW_MARKER: marker,
    WORKFLOW_MIN_QUOTA_REMAINING_PERCENT: "12.5",
    WORKFLOW_QUOTA_URL: quota.url,
  });

  const result = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script: 'export const meta = { name: "quota-blocked" };',
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Z\.AI quota remaining is 12\.4%; minimum is 12\.5%/);

  const legacyResult = await client.request("tools/call", {
    name: "Workflow",
    arguments: {
      cwd: repositoryRoot,
      script: 'export const meta = { name: "quota-blocked-legacy" };',
    },
  });
  assert.equal(legacyResult.isError, true);
  assert.match(legacyResult.content[0].text, /Z\.AI quota remaining is 12\.4%; minimum is 12\.5%/);

  assert.equal(quota.requests.length, 2);
  assert.equal(existsSync(marker), false);
});

test("the default threshold allows exactly fifty percent remaining", async (t) => {
  const marker = join(tmpdir(), `quota-exact-${process.pid}`);
  const configHome = await mkdtemp(join(tmpdir(), "quota-default-config-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  await rm(marker, { force: true });
  const quota = await startQuotaServer(t, [
    {
      type: "TOKENS_LIMIT",
      unit: 3,
      number: 5,
      percentage: 50,
      nextResetTime: Date.now() + 3_600_000,
    },
  ]);
  const { client } = await startFakeModeClient(t, "complete", {
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    FAKE_WORKFLOW_MARKER: marker,
    WORKFLOW_MIN_QUOTA_REMAINING_PERCENT: "",
    WORKFLOW_QUOTA_URL: quota.url,
    XDG_CONFIG_HOME: configHome,
  });

  const result = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script: 'export const meta = { name: "quota-exact" };',
    },
  });
  assertToolSuccess(result, "WorkflowStart");
  assert.equal(quota.requests.length, 1);
  assert.equal(existsSync(marker), true);
});

test("a zero threshold disables the quota request but still starts Claude", async (t) => {
  const quota = await startQuotaServer(t, [
    {
      type: "TOKENS_LIMIT",
      unit: 3,
      number: 5,
      percentage: 0,
      nextResetTime: Date.now() + 3_600_000,
    },
  ]);
  const { client } = await startFakeModeClient(t, "complete", {
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    WORKFLOW_MIN_QUOTA_REMAINING_PERCENT: "0",
    WORKFLOW_QUOTA_URL: quota.url,
  });

  const result = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script: 'export const meta = { name: "quota-disabled" };',
    },
  });
  assertToolSuccess(result, "WorkflowStart");
  assert.equal(quota.requests.length, 0);

  const quotaResult = await client.request("tools/call", {
    name: "WorkflowQuota",
    arguments: {},
  });
  assertToolSuccess(quotaResult, "WorkflowQuota");
  assert.equal(quota.requests.length, 1);
});

test("an invalid threshold is a fail-closed configuration error", async (t) => {
  const marker = join(tmpdir(), `quota-invalid-${process.pid}`);
  const quota = await startQuotaServer(t, []);
  const { client } = await startFakeModeClient(t, "complete", {
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    FAKE_WORKFLOW_MARKER: marker,
    WORKFLOW_MIN_QUOTA_REMAINING_PERCENT: "101",
    WORKFLOW_QUOTA_URL: quota.url,
  });

  const result = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script: 'export const meta = { name: "quota-invalid" };',
    },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /WORKFLOW_MIN_QUOTA_REMAINING_PERCENT must be a finite number from 0 through 100/,
  );
  assert.equal(quota.requests.length, 0);
  assert.equal(existsSync(marker), false);
});

test("WorkflowQuota fails closed without a five-hour model quota", async (t) => {
  const quota = await startQuotaServer(t, [
    {
      type: "TIME_LIMIT",
      percentage: 10,
      nextResetTime: Date.now() + 3_600_000,
    },
  ]);
  const client = startClient({
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "quota-test-token",
    WORKFLOW_QUOTA_URL: quota.url,
  });
  t.after(() => client.stop());
  await initialize(client);

  const result = await client.request("tools/call", {
    name: "WorkflowQuota",
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Z.AI quota response has no five-hour model quota");
});

test("WorkflowQuota fails closed when quota authentication fails", async (t) => {
  const quota = await startQuotaServer(t, [], 401);
  const client = await startQuotaClient(t, quota.url);
  await assertQuotaFailure(client, "Unable to query Z.AI quota");
  assert.equal(quota.requests.length, 1);
});

test("WorkflowQuota rejects an unsuccessful HTTP 200 response", async (t) => {
  const client = await startQuotaClient(
    t,
    await startRawQuotaServer(
      t,
      JSON.stringify({ code: 429, msg: "rejected", data: null, success: false }),
    ),
  );
  await assertQuotaFailure(client, "Z.AI quota request was rejected");
});

test("WorkflowQuota fails closed when quota response is not JSON", async (t) => {
  const client = await startQuotaClient(
    t,
    await startRawQuotaServer(t, "not-json"),
  );
  await assertQuotaFailure(client, "Z.AI quota response is not JSON");
});

test("WorkflowQuota fails closed when quota usage percent is invalid", async (t) => {
  const quota = await startQuotaServer(t, [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        nextResetTime: Date.now() + 3_600_000,
      },
    ]);
  const client = await startQuotaClient(t, quota.url);
  await assertQuotaFailure(
    client,
    "Z.AI quota response has an invalid model usage percent",
  );
});

test("WorkflowStart preserves Claude Code's rejection reason", async (t) => {
  const { client } = await startFakeModeClient(t, "rejected");
  const result = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script: "This is not JavaScript",
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Workflow script must be JavaScript");
});

test("Workflow refuses to fall back when Z.AI provider env is missing", async (t) => {
  const client = startClient({
    XDG_CONFIG_HOME: `/tmp/codex-workflow-no-provider-${process.pid}`,
    ANTHROPIC_BASE_URL: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
  });
  t.after(() => client.stop());

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const result = await client.request("tools/call", {
    name: "Workflow",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "missing-provider", description: "Must fail closed" };\nreturn { ok: true };',
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ANTHROPIC_BASE_URL/);
});

test("Workflow rejects a relative workspace path", async (t) => {
  const client = startClient({
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const result = await client.request("tools/call", {
    name: "Workflow",
    arguments: {
      cwd: "relative-workspace",
      script:
        'export const meta = { name: "relative", description: "Reject ambiguous workspace" };\nreturn { ok: true };',
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /absolute path/);
});

test("Workflow survives an early Claude stdin close", async (t) => {
  const fakeBin = await mkdtemp(join(tmpdir(), "codex-workflow-claude-"));
  const fakeClaude = join(fakeBin, "claude");
  await writeFile(fakeClaude, "#!/bin/sh\nexec 0<&-\nsleep 1\n");
  await chmod(fakeClaude, 0o755);

  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(async () => {
    client.stop();
    await rm(fakeBin, { recursive: true, force: true });
  });

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const result = await client.request("tools/call", {
    name: "Workflow",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "early-close", description: "Exercise lifecycle error handling" };\nreturn { ok: true };',
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Claude Code stopped unexpectedly/);
});

test("Workflow runs Claude in the requested workspace", async (t) => {
  const { fakeBin, stateRoot } = await createWorkflowClaude(t);
  const workspace = await mkdtemp(join(tmpdir(), "codex-workflow-workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_ROOT: stateRoot,
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const result = await client.request("tools/call", {
    name: "Workflow",
    arguments: {
      cwd: workspace,
      script:
        'export const meta = { name: "workspace", description: "Use the requested workspace" };\nreturn { ok: true };',
    },
  });
  assertToolSuccess(result, "Workflow");
  assert.equal(parseToolPayload(result).result.cwd, workspace);
});

test("WorkflowStart enables edits and passes WORKFLOW_MODEL to Claude", async (t) => {
  const { client } = await startFakeModeClient(t, "complete", {
    WORKFLOW_MODEL: "glm-custom",
  });
  const started = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "editable", description: "Editable" };\nreturn { ok: true };',
      allowEdits: true,
    },
  });
  assertToolSuccess(started, "WorkflowStart");

  const completed = await collectWorkflowEvents(
    client,
    parseToolPayload(started).runId,
  );
  assert.deepEqual(completed.result.argv, [
    "--permission-mode",
    "acceptEdits",
    "mcp",
    "serve",
  ]);
  assert.equal(completed.result.model, "glm-custom");
  assert.equal(completed.result.subagentModel, "glm-custom");
});

test("Workflow defaults Claude to glm-5.3 without edit mode", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "workflow-model-default-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const { client } = await startFakeModeClient(t, "complete", {
    WORKFLOW_MODEL: "",
    XDG_CONFIG_HOME: configHome,
  });

  const result = await client.request("tools/call", {
    name: "Workflow",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "default-model", description: "Default model" };\nreturn { ok: true };',
    },
  });
  assertToolSuccess(result, "Workflow");
  const payload = parseToolPayload(result).result;
  assert.deepEqual(payload.argv, ["mcp", "serve"]);
  assert.equal(payload.model, "glm-5.3");
  assert.equal(payload.subagentModel, "glm-5.3");
});

test("Workflow rejects a non-boolean allowEdits before Claude starts", async (t) => {
  const marker = join(tmpdir(), `workflow-invalid-edits-${process.pid}`);
  await rm(marker, { force: true });
  const { client } = await startFakeModeClient(t, "complete", {
    FAKE_WORKFLOW_MARKER: marker,
  });

  const result = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "invalid-edits", description: "Invalid" };',
      allowEdits: "yes",
    },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Workflow allowEdits must be a boolean");
  assert.equal(existsSync(marker), false);
});

test("WorkflowStart returns before terminal state and WorkflowWait returns the result", async (t) => {
  const { fakeBin } = await createWorkflowClaude(t);
  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_DELAY_MS: "100",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());
  await initialize(client);

  const started = await client.request("tools/call", {
    name: "WorkflowStart",
    arguments: {
      cwd: repositoryRoot,
      script:
        'export const meta = { name: "async", description: "Async" };\nreturn { ok: true };',
    },
  });
  assertToolSuccess(started, "WorkflowStart");
  const launch = parseToolPayload(started);
  assert.equal(launch.status, "starting");
  assert.equal(launch.revision, 0);

  const completed = await client.request("tools/call", {
    name: "WorkflowWait",
    arguments: { runId: launch.runId, afterRevision: 0 },
  });
  assertToolSuccess(completed, "WorkflowWait");
  const snapshot = parseToolPayload(completed);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.result.cwd, repositoryRoot);
});

test("Workflow reports a killed native run immediately", async (t) => {
  const { fakeBin, stateRoot } = await createWorkflowClaude(t);
  const workspace = await mkdtemp(join(tmpdir(), "codex-workflow-workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_ROOT: stateRoot,
    FAKE_WORKFLOW_STATUS: "killed",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const result = await client.request(
    "tools/call",
    {
      name: "Workflow",
      arguments: {
        cwd: workspace,
        script:
          'export const meta = { name: "killed", description: "Expose terminal state" };\nreturn { ok: true };',
      },
    },
    1_000,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Workflow was killed/);
});

test("closing adapter input terminates an active Claude workflow", async (t) => {
  const { fakeBin, stateRoot } = await createWorkflowClaude(t);
  const workspace = await mkdtemp(join(tmpdir(), "codex-workflow-workspace-"));
  const marker = join(stateRoot, "lifecycle");
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_ROOT: stateRoot,
    FAKE_WORKFLOW_MARKER: marker,
    FAKE_WORKFLOW_NO_STATE: "1",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");

  const workflow = client.request(
    "tools/call",
    {
      name: "Workflow",
      arguments: {
        cwd: workspace,
        script:
          'export const meta = { name: "lifecycle", description: "Stop with the adapter" };\nreturn { ok: true };',
      },
    },
    2_000,
  );
  await waitForFileText(marker, "running");
  client.closeInput();

  const result = await workflow;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Claude Code stopped/);
  await waitForFileText(marker, "terminated");
});

test("WorkflowWait reports revisioned leaf progress without transcript data", async (t) => {
  const { client, stateRoot } = await startFakeProgressClient(t);
  const launch = await startFakeWorkflow(client);

  const running = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowWait",
      arguments: { runId: launch.runId, afterRevision: 0 },
    }),
  );
  assert.equal(running.events[0].type, "leaf_started");
  assert.equal(running.events[0].phase, "Inspect");
  assert.equal(running.events[0].role, "correctness");
  assert.equal(running.events[0].label, "inspect-readme");
  assert.equal(running.counts.active, 1);
  assert.equal("heartbeat" in running, false);

  const serialized = JSON.stringify(running);
  assert.doesNotMatch(serialized, /SECRET_PROMPT_TEXT|SECRET_LEAF_RESULT/);
  assert.doesNotMatch(serialized, /subagents|journal\\.jsonl|agent-agentone/);

  await writeFile(join(stateRoot, `${launch.runId}.release-result`), "");
  const leafCompleted = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowWait",
      arguments: {
        runId: launch.runId,
        afterRevision: running.revision,
      },
    }),
  );
  assert.ok(
    leafCompleted.events.some((event) => event.type === "leaf_completed"),
  );
  assert.equal(leafCompleted.status, "running");
  assert.equal(leafCompleted.counts.active, 0);
  assert.equal(leafCompleted.counts.completed, 1);
  const completedSerialized = JSON.stringify(leafCompleted);
  assert.doesNotMatch(
    completedSerialized,
    /SECRET_PROMPT_TEXT|SECRET_LEAF_RESULT/,
  );
  assert.doesNotMatch(
    completedSerialized,
    /subagents|journal\\.jsonl|agent-agentone/,
  );

  await writeFile(join(stateRoot, `${launch.runId}.release-state`), "");
  const terminal = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowWait",
      arguments: {
        runId: launch.runId,
        afterRevision: leafCompleted.revision,
      },
    }),
  );
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.events[0].type, "workflow_completed");
  assert.ok(terminal.revision > leafCompleted.revision);
});

test("WorkflowWait stays pending until a complete first user record emits progress", async (t) => {
  const gate = await createWatcherGate(t, "after-journal");
  const { client, stateRoot } = await startFakeModeClient(
    t,
    "pending-transcript",
    { CODEX_WORKFLOW_TEST_GATE_DIR: gate.gateDir },
  );
  const launch = await startFakeWorkflow(client);
  await waitForFileText(gate.ready, "ready");

  const waiting = client.request(
    "tools/call",
    {
      name: "WorkflowWait",
      arguments: { runId: launch.runId, afterRevision: 0 },
    },
    2_000,
  );
  await assertPending(waiting);

  await writeFile(
    fakeTranscriptPath(stateRoot, launch.runId),
    `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          '<codex-workflow-progress>{"phase":"Synthesize","role":"synthesis","label":"synthesize-results"}</codex-workflow-progress>\nSECRET_DELAYED_PROMPT',
      },
    })}\n`,
  );
  await appendFile(
    fakeJournalPath(stateRoot, launch.runId),
    `${JSON.stringify({
      type: "result",
      agentId: "agentone",
      result: "SECRET_DELAYED_RESULT",
    })}\n`,
  );
  await writeFile(
    join(stateRoot, `${launch.runId}.json`),
    JSON.stringify({
      runId: launch.runId,
      status: "completed",
      result: { ok: true },
    }),
  );
  await writeFile(gate.release, "");

  const first = parseToolPayload(await waiting);
  assert.ok(first.revision > 0);
  const snapshot = await collectWorkflowEvents(client, launch.runId);
  assert.equal(snapshot.status, "completed");
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ["leaf_started", "leaf_completed", "workflow_completed"],
  );
  assert.deepEqual(
    snapshot.events.map((event) => event.revision),
    [1, 2, 3],
  );
  assert.equal(snapshot.events[0].phase, "Synthesize");
  assert.equal(snapshot.events[0].role, "synthesis");
  assert.equal(snapshot.events[0].label, "synthesize-results");
  assert.equal(snapshot.counts.active, 0);
  assert.equal(snapshot.counts.completed, 1);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /SECRET_DELAYED_PROMPT|SECRET_DELAYED_RESULT|agent-agentone|subagents/,
  );
});

test("terminal drain forces fallback for a permanently missing progress transcript", async (t) => {
  const gate = await createWatcherGate(t, "after-journal");
  const { client, stateRoot } = await startFakeModeClient(
    t,
    "missing-transcript",
    { CODEX_WORKFLOW_TEST_GATE_DIR: gate.gateDir },
  );
  const launch = await startFakeWorkflow(client);
  await waitForFileText(gate.ready, "ready");

  const waiting = client.request(
    "tools/call",
    {
      name: "WorkflowWait",
      arguments: { runId: launch.runId, afterRevision: 0 },
    },
    2_000,
  );
  await assertPending(waiting);

  await writeFile(
    join(stateRoot, `${launch.runId}.json`),
    JSON.stringify({
      runId: launch.runId,
      status: "completed",
      result: { ok: true },
    }),
  );
  await writeFile(gate.release, "");

  const first = parseToolPayload(await waiting);
  assert.ok(first.revision > 0);
  const snapshot = await collectWorkflowEvents(client, launch.runId);
  assert.equal(snapshot.status, "completed");
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ["leaf_started", "leaf_failed", "workflow_completed"],
  );
  assert.deepEqual(
    snapshot.events.map((event) => event.revision),
    [1, 2, 3],
  );
  assert.equal(snapshot.events[0].phase, null);
  assert.equal(snapshot.events[0].role, null);
  assert.equal(snapshot.events[0].label, "leaf-agentone");
  assert.equal(snapshot.counts.active, 0);
  assert.equal(snapshot.counts.failed, 1);
});

test("WorkflowWait rejects unknown runs and invalid revision arguments safely", async (t) => {
  const client = startClient({
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());
  await initialize(client);

  const cases = [
    {
      arguments: { runId: "wf_missing", afterRevision: 0 },
      expected: /Unknown workflow run/,
    },
    {
      arguments: { runId: "wf_missing" },
      expected: /afterRevision must be a non-negative integer/,
    },
    {
      arguments: { runId: "wf_missing", afterRevision: -1 },
      expected: /afterRevision must be a non-negative integer/,
    },
    {
      arguments: { runId: "wf_missing", afterRevision: 1.5 },
      expected: /afterRevision must be a non-negative integer/,
    },
    {
      arguments: { runId: "wf_missing", afterRevision: 0, waitMs: 1 },
      expected: /unsupported argument/,
    },
  ];

  for (const item of cases) {
    const result = await client.request("tools/call", {
      name: "WorkflowWait",
      arguments: item.arguments,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, item.expected);
    assert.doesNotMatch(
      result.content[0].text,
      /subagents|journal\\.jsonl|SECRET_/,
    );
  }

  const { client: runningClient } = await startFakeModeClient(t, "no-state");
  const launch = await startFakeWorkflow(runningClient);
  const future = await runningClient.request("tools/call", {
    name: "WorkflowWait",
    arguments: { runId: launch.runId, afterRevision: launch.revision + 1 },
  });
  assert.equal(future.isError, true);
  assert.match(future.content[0].text, /cannot exceed current revision/);
  await runningClient.request("tools/call", {
    name: "WorkflowStop",
    arguments: { runId: launch.runId },
  });
});

test("unsafe journal agent ids fail without reading outside the transcript root", async (t) => {
  for (const agentId of [
    "x/../../../../outside",
    "bad/name",
    "bad\\\\name",
  ]) {
    await t.test(agentId, async (subtest) => {
      const { client, stateRoot } = await startFakeModeClient(
        subtest,
        "invalid-agent",
        { FAKE_WORKFLOW_AGENT_ID: agentId },
      );
      await writeFile(
        join(dirname(stateRoot), "outside.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content:
              '<codex-workflow-progress>{"phase":"SECRET_OUTSIDE_TRANSCRIPT","role":"secret","label":"secret"}</codex-workflow-progress>',
          },
        })}\n`,
      );

      const launch = await startFakeWorkflow(client);
      const snapshot = await collectWorkflowEvents(client, launch.runId);
      assert.equal(snapshot.status, "failed");
      assert.equal(terminalWorkflowEvents(snapshot).length, 1);
      assert.equal(
        terminalWorkflowEvents(snapshot)[0].type,
        "workflow_failed",
      );
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /SECRET_OUTSIDE_TRANSCRIPT|outside\\.jsonl|subagents/,
      );
    });
  }
});

test("progress metadata in later assistant or tool records is ignored", async (t) => {
  const { client } = await startFakeModeClient(t, "later-marker");
  const launch = await startFakeWorkflow(client);
  const snapshot = await collectWorkflowEvents(client, launch.runId);
  const started = snapshot.events.find((event) => event.type === "leaf_started");

  assert.equal(snapshot.status, "completed");
  assert.equal(started.phase, null);
  assert.equal(started.role, null);
  assert.equal(started.label, "leaf-agentone");
});

test("progress metadata survives a first user record larger than 8 KiB", async (t) => {
  const { client } = await startFakeModeClient(t, "large-user");
  const launch = await startFakeWorkflow(client);
  const snapshot = await collectWorkflowEvents(client, launch.runId);
  const started = snapshot.events.find((event) => event.type === "leaf_started");

  assert.equal(snapshot.status, "completed");
  assert.equal(started.phase, "Inspect");
  assert.equal(started.role, "correctness");
  assert.equal(started.label, "inspect-readme");
});

test("terminal cleanup reports a started leaf without a result as failed", async (t) => {
  const { client } = await startFakeModeClient(t, "failed-leaf");
  const launch = await startFakeWorkflow(client);
  const snapshot = await collectWorkflowEvents(client, launch.runId);
  const failed = snapshot.events.filter(
    (event) => event.type === "leaf_failed",
  );

  assert.equal(snapshot.status, "failed");
  assert.equal(failed.length, 1);
  assert.equal(snapshot.counts.failed, 1);
  assert.equal(snapshot.counts.active, 0);
  assert.deepEqual(snapshot.activeLeaves, []);
  assert.equal(
    snapshot.events.filter((event) => event.type === "leaf_completed").length,
    0,
  );
  assert.ok(Number.isInteger(failed[0].durationMs));
  assert.ok(failed[0].durationMs >= 0);
});

test("bounded journal reads preserve split UTF-8 and emit each event once", async (t) => {
  const { hookPath, markerPath } = await createPartialReadHook(t);
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--import=${hookPath}`,
  ]
    .filter(Boolean)
    .join(" ");
  const { client } = await startFakeModeClient(t, "split-journal", {
    NODE_OPTIONS: nodeOptions,
  });
  const launch = await startFakeWorkflow(client);
  const snapshot = await collectWorkflowEvents(client, launch.runId);
  const eventTypes = snapshot.events.map((event) => event.type);

  assert.equal(snapshot.status, "completed");
  assert.deepEqual(eventTypes, [
    "leaf_started",
    "leaf_completed",
    "workflow_completed",
  ]);
  assert.equal(snapshot.revision, 3);
  assert.equal(new Set(snapshot.events.map((event) => event.revision)).size, 3);
  assert.equal(snapshot.counts.completed, 1);
  assert.equal(snapshot.counts.active, 0);
  await waitForFileText(markerPath, "partial");
});

test("WorkflowWait stays pending until WorkflowStop advances the revision", async (t) => {
  const { client } = await startFakeModeClient(t, "no-state");
  const launch = await startFakeWorkflow(client);
  const waiting = client.request(
    "tools/call",
    {
      name: "WorkflowWait",
      arguments: { runId: launch.runId, afterRevision: 0 },
    },
    2_000,
  );

  await assertPending(waiting);
  const stopped = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowStop",
      arguments: { runId: launch.runId },
    }),
  );
  const snapshot = parseToolPayload(await waiting);

  assert.equal(stopped.status, "killed");
  assert.equal(snapshot.status, "killed");
  assert.equal(snapshot.events.at(-1).type, "workflow_killed");
  assert.equal("heartbeat" in snapshot, false);
});

test("WorkflowStop emits workflow_killed, terminates Claude, and is idempotent", async (t) => {
  const markerRoot = await mkdtemp(join(tmpdir(), "codex-workflow-stop-"));
  const marker = join(markerRoot, "lifecycle");
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const { client } = await startFakeModeClient(t, "no-state", {
    FAKE_WORKFLOW_MARKER: marker,
  });
  const launch = await startFakeWorkflow(client);
  await waitForFileText(marker, "running");

  const first = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowStop",
      arguments: { runId: launch.runId },
    }),
  );
  assert.equal(first.status, "killed");
  assert.equal(first.events.at(-1).type, "workflow_killed");
  assert.equal(terminalWorkflowEvents(first).length, 1);
  assert.equal(first.counts.active, 0);
  await waitForFileText(marker, "terminated");

  const second = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowStop",
      arguments: { runId: launch.runId },
    }),
  );
  assert.equal(second.status, "killed");
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.events, first.events);
  assert.equal(terminalWorkflowEvents(second).length, 1);
});

test("terminal journal drain keeps a just-appended leaf result", async (t) => {
  const gate = await createWatcherGate(t, "after-journal");
  const { client, stateRoot } = await startFakeModeClient(
    t,
    "terminal-drain",
    { CODEX_WORKFLOW_TEST_GATE_DIR: gate.gateDir },
  );
  const launch = await startFakeWorkflow(client);
  await waitForFileText(gate.ready, "ready");

  await appendFile(
    fakeJournalPath(stateRoot, launch.runId),
    `${JSON.stringify({
      type: "result",
      agentId: "agentone",
      result: "SECRET_LEAF_RESULT",
    })}\n`,
  );
  await writeFile(
    join(stateRoot, `${launch.runId}.json`),
    JSON.stringify({
      runId: launch.runId,
      status: "completed",
      result: { ok: true },
    }),
  );
  await writeFile(gate.release, "");

  const snapshot = await collectWorkflowEvents(client, launch.runId);
  const eventTypes = snapshot.events.map((event) => event.type);
  assert.equal(snapshot.status, "completed");
  assert.ok(
    eventTypes.indexOf("leaf_completed") <
      eventTypes.indexOf("workflow_completed"),
  );
  assert.equal(snapshot.counts.active, 0);
  assert.equal(snapshot.counts.completed, 1);
  assert.equal(terminalWorkflowEvents(snapshot).length, 1);
});

test("WorkflowStop wins over an already-read native terminal state", async (t) => {
  const gate = await createWatcherGate(t, "after-state-read");
  const { client } = await startFakeModeClient(t, "complete", {
    CODEX_WORKFLOW_TEST_GATE_DIR: gate.gateDir,
  });
  const launch = await startFakeWorkflow(client);
  await waitForFileText(gate.ready, "ready");

  const stopped = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowStop",
      arguments: { runId: launch.runId },
    }),
  );
  assert.equal(stopped.status, "killed");
  await writeFile(gate.release, "");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const snapshot = parseToolPayload(
    await client.request("tools/call", {
      name: "WorkflowWait",
      arguments: { runId: launch.runId, afterRevision: 0 },
    }),
  );
  assert.equal(snapshot.status, "killed");
  assert.equal(terminalWorkflowEvents(snapshot).length, 1);
  assert.equal(terminalWorkflowEvents(snapshot)[0].type, "workflow_killed");
});

test("malformed native progress fails once and the same server accepts another run", async (t) => {
  for (const mode of ["malformed-journal", "malformed-state"]) {
    await t.test(mode, async (subtest) => {
      const { client, stateRoot } = await startFakeModeClient(subtest, mode);
      const firstLaunch = await startFakeWorkflow(client);
      const failed = await collectWorkflowEvents(client, firstLaunch.runId);
      assert.equal(failed.status, "failed");
      assert.equal(terminalWorkflowEvents(failed).length, 1);
      assert.equal(terminalWorkflowEvents(failed)[0].type, "workflow_failed");
      assert.doesNotMatch(
        JSON.stringify(failed),
        /journal\\.jsonl|subagents|\\{"type":/,
      );

      await setFakeWorkflowMode(stateRoot, "complete");
      const secondLaunch = await startFakeWorkflow(client);
      const completed = await collectWorkflowEvents(
        client,
        secondLaunch.runId,
      );
      assert.equal(completed.status, "completed");
      assert.equal(
        terminalWorkflowEvents(completed).at(-1).type,
        "workflow_completed",
      );
    });
  }
});

test("closing adapter input terminates every active Claude workflow", async (t) => {
  const { fakeBin, stateRoot } = await createWorkflowClaude(t);
  const markerRoot = join(stateRoot, "children");
  await mkdir(markerRoot, { recursive: true });
  await setFakeWorkflowMode(stateRoot, "no-state");
  const client = startClient({
    PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    FAKE_WORKFLOW_STATE_ROOT: stateRoot,
    FAKE_WORKFLOW_UNIQUE_RUNS: "1",
    FAKE_WORKFLOW_MARKER_ROOT: markerRoot,
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "placeholder",
  });
  t.after(() => client.stop());
  await initialize(client);

  const first = await startFakeWorkflow(client);
  const second = await startFakeWorkflow(client);
  assert.notEqual(first.runId, second.runId);
  await waitForFileText(join(markerRoot, first.runId), "running");
  await waitForFileText(join(markerRoot, second.runId), "running");

  client.closeInput();
  await waitForFileText(join(markerRoot, first.runId), "terminated");
  await waitForFileText(join(markerRoot, second.runId), "terminated");
});

test("an unexpected Claude exit produces one workflow_failed event", async (t) => {
  const { client } = await startFakeModeClient(t, "exit");
  const launch = await startFakeWorkflow(client);
  const snapshot = await collectWorkflowEvents(client, launch.runId);

  assert.equal(snapshot.status, "failed");
  assert.equal(terminalWorkflowEvents(snapshot).length, 1);
  assert.equal(
    terminalWorkflowEvents(snapshot)[0].type,
    "workflow_failed",
  );
});

test(
  "GLM exposes parallel reviewer leaves and a synthesis leaf",
  { skip: process.env.RUN_WORKFLOW_CANARY !== "1" },
  async (t) => {
    const client = startClient();
    t.after(() => client.stop());
    const deadline = Date.now() + 620_000;

    await initialize(client);
    const started = await client.request("tools/call", {
      name: "WorkflowStart",
      arguments: { cwd: repositoryRoot, script: canaryScript },
    });
    assertToolSuccess(started, "WorkflowStart");
    const launch = parseToolPayload(started);
    const completed = await waitWorkflowToTerminal(
      client,
      launch,
      deadline,
    );

    assert.equal(completed.status, "completed");
    assert.deepEqual(
      [...new Set(completed.events.map((event) => event.role).filter(Boolean))].sort(),
      ["architecture", "product", "synthesis"],
    );
    assert.deepEqual(
      [...new Set(completed.events.map((event) => event.label).filter(Boolean))].sort(),
      ["review-architecture", "review-product", "synthesize-reviews"],
    );
    assert.deepEqual(
      [...new Set(completed.events.map((event) => event.phase).filter(Boolean))].sort(),
      ["Review", "Synthesize"],
    );
    for (const key of ["structure", "documentation", "synthesis"]) {
      assert.notEqual(completed.result[key], null);
      assert.ok(completed.result[key].summary.trim());
    }
  },
);

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(
  await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
);
const server = config.mcpServers["claude-workflow"];

const canaryScript = `export const meta = {
  name: "readonly-parallel-canary",
  description: "Run two independent read-only workspace inspections",
  phases: [
    {
      title: "Inspect",
      detail: "Two read-only agents inspect the workspace in parallel",
    },
  ],
};

const RESULT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

phase("Inspect");

const [structure, documentation] = await parallel([
  () =>
    agent(
      "Inspect the workspace structure without modifying anything. Return a concise summary.",
      {
        label: "inspect-structure",
        phase: "Inspect",
        schema: RESULT_SCHEMA,
      },
    ),
  () =>
    agent(
      "Inspect project documentation without modifying anything. Return a concise summary.",
      {
        label: "inspect-documentation",
        phase: "Inspect",
        schema: RESULT_SCHEMA,
      },
    ),
]);

const synthesis = await agent(
  \`Synthesize both inspections without new research.\\n\${JSON.stringify({
    structure,
    documentation,
  })}\`,
  {
    label: "synthesize-inspections",
    phase: "Inspect",
    schema: RESULT_SCHEMA,
  },
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
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const runId = "wf_fixture";
const stateRoot = process.env.FAKE_WORKFLOW_STATE_ROOT;
const marker = process.env.FAKE_WORKFLOW_MARKER;
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
};

if (marker) {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "running");
  process.once("SIGTERM", () => {
    fs.writeFileSync(marker, "terminated");
    process.exit(0);
  });
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

  fs.mkdirSync(path.join(stateRoot, "scripts"), { recursive: true });
  if (process.env.FAKE_WORKFLOW_NO_STATE !== "1") {
    fs.writeFileSync(
      path.join(stateRoot, runId + ".json"),
      JSON.stringify({
        runId,
        status: process.env.FAKE_WORKFLOW_STATUS || "completed",
        result: { cwd: process.cwd() },
      }),
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
});
`,
  );
  await chmod(fakeClaude, 0o755);
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  return { fakeBin, stateRoot };
}

test("plugin starts its bundled native-workflow adapter", () => {
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./scripts/workflow-mcp.mjs"]);
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.env_vars, [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "XDG_CONFIG_HOME",
  ]);
});

function startClient(env = {}) {
  const child = spawn(server.command, server.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...server.env, ...env },
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

test("configured MCP publishes the synchronous native Workflow tool", async (t) => {
  const client = startClient();
  t.after(() => client.stop());

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-06-18");
  client.notify("notifications/initialized");

  const { tools } = await client.request("tools/list", {});
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(["Workflow"].filter((name) => !byName[name]), []);
  assert.equal(byName.Workflow.inputSchema.properties.cwd.type, "string");
  assert.equal(byName.Workflow.inputSchema.properties.script.type, "string");
  assert.deepEqual(byName.Workflow.inputSchema.required, ["cwd", "script"]);
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

test(
  "GLM executes two parallel read-only leaves and a synthesis leaf",
  { skip: process.env.RUN_WORKFLOW_CANARY !== "1" },
  async (t) => {
    const client = startClient();
    t.after(() => client.stop());

    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-workflow-canary", version: "1.0.0" },
    });
    client.notify("notifications/initialized");

    const completed = await client.request(
      "tools/call",
      {
        name: "Workflow",
        arguments: { cwd: repositoryRoot, script: canaryScript },
      },
      620_000,
    );
    assertToolSuccess(completed, "Workflow");

    const output = parseToolPayload(completed);
    assert.equal(output.status, "completed");
    for (const key of ["structure", "documentation", "synthesis"]) {
      assert.notEqual(output.result[key], null);
      assert.ok(output.result[key].summary.trim());
    }
  },
);

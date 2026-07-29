import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(
  await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
);
const server = config.mcpServers["claude-workflow"];

function startClient() {
  const child = spawn(server.command, server.args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...server.env },
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
        : new Error(`claude mcp serve exited (${reason}): ${stderr}`);
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
    stop() {
      child.kill("SIGTERM");
    },
  };
}

test("configured Claude MCP publishes native workflow tools", async (t) => {
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

  assert.deepEqual(
    ["Workflow", "TaskOutput", "TaskStop"].filter((name) => !byName[name]),
    [],
  );
  assert.equal(byName.Workflow.inputSchema.properties.script.type, "string");
  const taskOutputRequired = new Set(byName.TaskOutput.inputSchema.required);
  for (const field of ["task_id", "block", "timeout"]) {
    assert.ok(taskOutputRequired.has(field));
  }
  assert.ok(byName.TaskStop.inputSchema.properties.task_id);
});

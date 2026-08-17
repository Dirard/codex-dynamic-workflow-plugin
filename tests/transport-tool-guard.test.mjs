import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guardPath = fileURLToPath(
  new URL("../scripts/transport-tool-guard.mjs", import.meta.url),
);

async function createGuardState(t, expectedInput) {
  const root = await mkdtemp(join(tmpdir(), "workflow-transport-guard-"));
  const path = join(root, "state.json");
  await writeFile(path, JSON.stringify({ expectedInput }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path;
}

function runGuard(input, statePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guardPath, statePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function decision(result) {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout
    ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision
    : "allow";
}

test("transport guard allows only one exact parent Workflow", async (t) => {
  const expectedInput = { script: "return null" };
  const statePath = await createGuardState(t, expectedInput);
  const parentWrite = await runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/should-not-write" },
  }, statePath);
  assert.equal(decision(parentWrite), "deny");

  const changed = await runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Workflow",
    tool_input: { script: "return changed" },
  }, statePath);
  assert.equal(decision(changed), "deny");

  const exact = await runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Workflow",
    tool_input: expectedInput,
  }, statePath);
  assert.equal(decision(exact), "allow");

  const second = await runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Workflow",
    tool_input: expectedInput,
  }, statePath);
  assert.equal(decision(second), "deny");
});

test("transport guard preserves workflow leaf tools", async (t) => {
  const statePath = await createGuardState(t, { script: "return null" });
  const leafWrite = await runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/leaf-write" },
    agent_id: "workflow-leaf",
  }, statePath);
  assert.equal(decision(leafWrite), "allow");
});

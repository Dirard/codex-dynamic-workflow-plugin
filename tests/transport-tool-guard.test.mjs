import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const guardPath = fileURLToPath(
  new URL("../scripts/transport-tool-guard.mjs", import.meta.url),
);

function runGuard(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guardPath], {
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

test("transport guard denies parent tools except Workflow", async () => {
  const parentWrite = await runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/should-not-write" },
  });
  assert.equal(parentWrite.code, 0, parentWrite.stderr);
  assert.equal(
    JSON.parse(parentWrite.stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );

  for (const input of [
    {
      hook_event_name: "PreToolUse",
      tool_name: "Workflow",
      tool_input: { script: "return null" },
    },
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/leaf-write" },
      agent_id: "workflow-leaf",
    },
  ]) {
    const allowed = await runGuard(input);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(allowed.stdout, "");
  }
});

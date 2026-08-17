#!/usr/bin/env node

let source = "";
for await (const chunk of process.stdin) source += chunk;

let event;
try {
  event = JSON.parse(source);
} catch {
  process.stderr.write("Invalid transport hook input\n");
  process.exitCode = 2;
}

if (event) {
  const isLeaf =
    typeof event.agent_id === "string" && event.agent_id.length > 0;
  if (!isLeaf && event.tool_name !== "Workflow") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "The transport session may only launch the exact Workflow request",
        },
      }),
    );
  }
}

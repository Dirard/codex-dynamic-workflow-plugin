#!/usr/bin/env node

import { closeSync, openSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

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
  const deny = (reason) => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  };

  if (!isLeaf && event.tool_name !== "Workflow") {
    deny("The transport session may only launch the exact Workflow request");
  } else if (!isLeaf) {
    let expectedInput;
    try {
      expectedInput = JSON.parse(
        readFileSync(process.argv[2], "utf8"),
      ).expectedInput;
    } catch {
      process.stderr.write("Unable to read transport guard state\n");
      process.exitCode = 2;
    }

    if (process.exitCode !== 2) {
      let actualInput = event.tool_input;
      if (
        actualInput &&
        typeof actualInput === "object" &&
        typeof actualInput.args === "string"
      ) {
        try {
          actualInput = { ...actualInput, args: JSON.parse(actualInput.args) };
        } catch {}
      }
      if (!isDeepStrictEqual(actualInput, expectedInput)) {
        deny("The Workflow request does not match the Codex-planned input");
      } else {
        try {
          closeSync(openSync(`${process.argv[2]}.used`, "wx", 0o600));
        } catch (error) {
          if (error?.code === "EEXIST") {
            deny("The transport session already launched its Workflow");
          } else {
            process.stderr.write("Unable to claim transport guard state\n");
            process.exitCode = 2;
          }
        }
      }
    }
  }
}

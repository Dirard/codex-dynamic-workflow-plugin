# Workflow Event Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heartbeat-based `WorkflowStatus` polling with a single event-driven `WorkflowWait` tool that returns only after a new revision or terminal state.

**Architecture:** Remove `WorkflowStatus`, `waitMs`, and `heartbeat` from the public and internal contracts. Each run owns a `Set` of Promise resolvers; the existing `appendEvent()` function drains it after every revision change, so progress, native completion, failure, and `WorkflowStop` share one notification path. Keep the synchronous compatibility `Workflow` unchanged and configure Codex's unavoidable host watchdog to one year without adding a server-side wait timer.

**Tech Stack:** Node.js 20+, ECMAScript modules, Node standard library, JSON-RPC MCP over stdio, native `node:test`.

## Global Constraints

- Public tools after the change: `Workflow`, `WorkflowStart`, `WorkflowWait`, `WorkflowStop`.
- `WorkflowWait` requires `{ runId: string, afterRevision: non-negative integer }`.
- `WorkflowWait` returns immediately only when `revision > afterRevision` or the run is terminal.
- Reject an `afterRevision` greater than the run's current revision.
- No `WorkflowStatus`, `waitMs`, `heartbeat`, server-side wait timer, or workflow execution deadline.
- `.mcp.json` sets `tool_timeout_sec` to `31_536_000`; this host watchdog must not stop the background workflow.
- Codex owns the DAG and orchestration; GLM-5.2 remains limited to leaf `agent()` execution.
- Do not add dependencies or rewrite historical completed specs, plans, or execution reports.
- Test-only timeouts may fail a stuck test and call `WorkflowStop`; they are not product deadlines.
- Release version is `0.3.0`.

---

### Task 1: Specify the Wait-Only Lifecycle in Boundary Tests

**Files:**
- Modify: `tests/mcp-boundary.test.mjs:101-239`
- Modify: `tests/mcp-boundary.test.mjs:640-655`
- Modify: `tests/mcp-boundary.test.mjs:657-667`
- Modify: `tests/mcp-boundary.test.mjs:742-761`
- Modify: `tests/mcp-boundary.test.mjs:884-957`
- Modify: `tests/mcp-boundary.test.mjs:1040-1267`
- Modify: `tests/mcp-boundary.test.mjs:1382-1504`
- Modify: `tests/mcp-boundary.test.mjs:1575-1594`

**Interfaces:**
- Consumes: current MCP test client `request(method, params, timeout?)` and async launch `{ runId, revision }`.
- Produces: `waitWorkflowToTerminal(client, launch, deadline, now?)`, `assertPending(promise)`, and boundary expectations for `WorkflowWait({ runId, afterRevision })`.

- [ ] **Step 1: Replace the canary polling helper with revisioned Wait calls**

Rename `pollWorkflowToTerminal` to `waitWorkflowToTerminal` and replace its loop with:

```js
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
```

Update the helper unit test to expect:

```js
[
  {
    name: "WorkflowWait",
    arguments: { runId: "wf_canary", afterRevision: 0 },
    timeout: 40_000,
  },
  {
    name: "WorkflowWait",
    arguments: { runId: "wf_canary", afterRevision: 2 },
    timeout: 40_000,
  },
]
```

Keep the deadline expiry test expecting only `WorkflowStop`.

- [ ] **Step 2: Add one reusable pending assertion and switch event collection to Wait**

Add:

```js
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
```

Replace `collectWorkflowEvents()` with:

```js
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
```

- [ ] **Step 3: Make tool publication and host timeout expectations fail**

Change the lifecycle schema test to:

```js
assert.deepEqual(Object.keys(byName).sort(), [
  "Workflow",
  "WorkflowStart",
  "WorkflowStop",
  "WorkflowWait",
]);
assert.deepEqual(byName.WorkflowStart.inputSchema.required, ["cwd", "script"]);
assert.deepEqual(byName.WorkflowWait.inputSchema.required, [
  "runId",
  "afterRevision",
]);
assert.deepEqual(byName.WorkflowStop.inputSchema.required, ["runId"]);
assert.equal(server.tool_timeout_sec, 31_536_000);
```

- [ ] **Step 4: Convert terminal and progress tests to `WorkflowWait`**

Rename the async terminal test to
`"WorkflowStart returns before terminal state and WorkflowWait returns the result"`
and call:

```js
const completed = await client.request("tools/call", {
  name: "WorkflowWait",
  arguments: { runId: launch.runId, afterRevision: 0 },
});
```

In the revisioned leaf progress test, use these three calls in order:

```js
const running = parseToolPayload(
  await client.request("tools/call", {
    name: "WorkflowWait",
    arguments: { runId: launch.runId, afterRevision: 0 },
  }),
);

const leafCompleted = parseToolPayload(
  await client.request("tools/call", {
    name: "WorkflowWait",
    arguments: {
      runId: launch.runId,
      afterRevision: running.revision,
    },
  }),
);

const terminal = parseToolPayload(
  await client.request("tools/call", {
    name: "WorkflowWait",
    arguments: {
      runId: launch.runId,
      afterRevision: leafCompleted.revision,
    },
  }),
);
```

Keep the existing assertions around those calls and add:

```js
assert.equal("heartbeat" in running, false);
```

Update the terminal race test at the former `WorkflowStatus` call to:

```js
const snapshot = parseToolPayload(
  await client.request("tools/call", {
    name: "WorkflowWait",
    arguments: { runId: launch.runId, afterRevision: 0 },
  }),
);
```

- [ ] **Step 5: Replace heartbeat assertions with true pending-Wait assertions**

Replace `"WorkflowStatus defaults return immediately"` and
`"WorkflowStatus returns a heartbeat when no journal or state changes"` with
one test:

```js
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
```

For the pending-transcript and permanently-missing-transcript tests, start this
request before releasing their watcher gate:

```js
const waiting = client.request(
  "tools/call",
  {
    name: "WorkflowWait",
    arguments: { runId: launch.runId, afterRevision: 0 },
  },
  2_000,
);
await assertPending(waiting);
```

After writing the transcript/state and releasing the gate, use
`const snapshot = parseToolPayload(await waiting);` and keep the existing exact
event, revision, redaction, and count assertions.

- [ ] **Step 6: Replace polling validation with strict Wait validation**

Rename the validation test to
`"WorkflowWait rejects unknown runs and invalid revision arguments safely"`.
Use these cases:

```js
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
    arguments: {
      runId: "wf_missing",
      afterRevision: 0,
      waitMs: 1,
    },
    expected: /unsupported argument/,
  },
];
```

Call `WorkflowWait` for every case. Add a real running `no-state` run and
assert:

```js
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
```

- [ ] **Step 7: Update the live canary call site**

Call `waitWorkflowToTerminal(client, launch, deadline)` at the live canary and
rename the helper unit test to `"canary waiting uses each returned revision until terminal"`.

- [ ] **Step 8: Run the focused tests and confirm RED**

Run:

```bash
node --test --test-name-pattern="configured MCP|WorkflowStart returns before terminal|WorkflowWait stays pending|WorkflowWait rejects|revisioned leaf progress|complete first user record|permanently missing progress|WorkflowStop wins" tests/mcp-boundary.test.mjs
```

Expected: FAIL because `WorkflowWait` is not published and
`tool_timeout_sec` is still `620`. No test may pass by falling back to
`WorkflowStatus`.

- [ ] **Step 9: Commit the executable contract**

```bash
git add tests/mcp-boundary.test.mjs
git commit -m "test: specify event-driven workflow wait"
```

---

### Task 2: Implement Event-Driven WorkflowWait

**Files:**
- Modify: `scripts/workflow-mcp.mjs:9-100`
- Modify: `scripts/workflow-mcp.mjs:211-375`
- Modify: `scripts/workflow-mcp.mjs:401-422`
- Modify: `scripts/workflow-mcp.mjs:879-978`
- Modify: `.mcp.json:15`

**Interfaces:**
- Consumes: run records, `appendEvent(run, event)`, `finishRun(run, status, terminalState?)`, and `snapshotRun(run, afterRevision)`.
- Produces: `WorkflowWait({ runId, afterRevision })`, `validateWaitArguments(args)`, and `waitForUpdate(run, afterRevision): Promise<object>`.

- [ ] **Step 1: Replace the published status schema with Wait**

Remove `MAX_STATUS_WAIT_MS` and `workflowStatusTool`. Add:

```js
const workflowWaitTool = {
  name: "WorkflowWait",
  description:
    "Wait for a workflow revision or terminal state and return its progress snapshot.",
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
```

Publish:

```js
const tools = [
  workflowStartTool,
  workflowWaitTool,
  workflowStopTool,
  workflowTool,
];
```

Set `SERVER_VERSION` to `"0.3.0"`.

- [ ] **Step 2: Replace dispatch, instructions, and validation**

Initialize with:

```js
instructions:
  "Use WorkflowStart, then call WorkflowWait with the latest revision until terminal. " +
  "Report phase/role/leaf changes. Use WorkflowStop when the run is cancelled.",
```

Dispatch:

```js
case "WorkflowWait":
  return await callWorkflowWait(params.arguments);
```

Implement:

```js
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
```

Delete `callWorkflowStatus()` and `validateStatusArguments()`.

- [ ] **Step 3: Add per-run waiters and wake them through `appendEvent`**

Add `waiters: new Set()` to the run record. Because future revisions are
rejected and the registration check is synchronous, every pending waiter is
waiting for the current revision to change.

Replace `appendEvent()` with:

```js
function appendEvent(run, event) {
  run.revision += 1;
  run.events.push({ revision: run.revision, ...event });
  for (const resolve of run.waiters) resolve();
  run.waiters.clear();
}
```

- [ ] **Step 4: Remove heartbeat serialization and timeout polling**

Change the signature to:

```js
function snapshotRun(run, afterRevision) {
```

Remove `heartbeat` from the returned object. Replace `waitForStatus()` with:

```js
async function waitForUpdate(run, afterRevision) {
  if (!run.terminal && run.revision <= afterRevision) {
    await new Promise((resolve) => {
      run.waiters.add(resolve);
    });
  }
  return snapshotRun(run, afterRevision);
}
```

Change `stopWorkflow()` to:

```js
function stopWorkflow(run) {
  finishRun(run, "killed");
  return snapshotRun(run, 0);
}
```

Keep `POLL_INTERVAL_MS` because native journal/state watching and the
compatible synchronous `Workflow` still use it.

- [ ] **Step 5: Raise only the Codex host watchdog**

Set:

```json
"tool_timeout_sec": 31536000
```

Do not add a server-side timeout or pass this value into workflow execution.

- [ ] **Step 6: Run syntax and focused boundary checks**

Run:

```bash
node --check scripts/workflow-mcp.mjs
node --test --test-name-pattern="configured MCP|WorkflowStart returns before terminal|WorkflowWait stays pending|WorkflowWait rejects|revisioned leaf progress|complete first user record|permanently missing progress|WorkflowStop wins" tests/mcp-boundary.test.mjs
```

Expected: syntax PASS and all selected tests PASS.

- [ ] **Step 7: Run the complete non-canary suite**

Run:

```bash
node --test tests/mcp-boundary.test.mjs
```

Expected: all non-canary tests PASS; the GLM canary is skipped.

- [ ] **Step 8: Commit the implementation**

```bash
git add scripts/workflow-mcp.mjs .mcp.json
git commit -m "feat: wait for workflow revisions"
```

---

### Task 3: Teach Codex the Wait-Only Workflow and Prepare Version 0.3.0

**Files:**
- Modify: `skills/native-workflow/SKILL.md:46-63`
- Modify: `skills/native-workflow/references/claude-workflows.md:248-271`
- Modify: `README.md:42-50`
- Modify: `.codex-plugin/plugin.json:3`

**Interfaces:**
- Consumes: public `WorkflowStart`, `WorkflowWait`, and `WorkflowStop` tools from Task 2.
- Produces: Codex instructions and package metadata that expose only the wait-only async lifecycle.

- [ ] **Step 1: Replace the skill status loop**

Use:

```markdown
## Запуск и ожидание

1. Вызвать `claude-workflow:WorkflowStart({ cwd, script, args? })` с абсолютным
   `cwd` и точным inline script.
2. Сразу сообщить пользователю `runId` и первую запланированную phase.
3. Вызвать
   `claude-workflow:WorkflowWait({ runId, afterRevision })`, передав последний
   полученный `revision`.
4. После ответа сообщить только новые phase/role/leaf events и повторить
   `WorkflowWait` с новой revision.
5. Продолжать без общего deadline до `completed`, `failed` или `killed`.
6. При отмене, замене задачи или явной команде пользователя вызвать
   `claude-workflow:WorkflowStop({ runId })`; pending Wait вернёт killed state.
7. Проверить terminal result и каждый ожидаемый leaf output. Только Codex
   решает, нужен ли следующий workflow.

Старый `Workflow` остаётся compatibility tool; для новых и больших задач его
не выбирать. `log()` — native diagnostic, не замена `WorkflowWait`.
```

- [ ] **Step 2: Update the bundled Claude Workflow reference**

Replace the lifecycle guidance with:

```markdown
Запускать `WorkflowStart`, затем повторять `WorkflowWait` с последним
`revision`. Wait возвращается только после новой revision или terminal state.
Сообщать новые phase/role/leaf events. Общего execution deadline у async path
нет. На отмену пользователя вызывать `WorkflowStop`; он будит pending Wait.

`log()` остаётся полезен внутри native UI, но Codex считает источником live
progress только `WorkflowWait`.
```

Change `Wrapper версии 0.2.0` to `Wrapper версии 0.3.0`. Keep the existing
resume, isolation, orchestration, and GLM leaf rules unchanged.

- [ ] **Step 3: Update README usage**

Use:

```markdown
Codex сформирует script, передаст абсолютный путь текущего workspace в `cwd`,
вызовет `WorkflowStart`, а затем `WorkflowWait` с последним `revision`. Wait
возвращается только после реального изменения phase/role/leaf или terminal
state; heartbeat и polling по таймеру отсутствуют.

У async path нет общего execution deadline. `WorkflowStop` явно отменяет run,
будит pending Wait и возвращает killed state. Старый синхронный `Workflow`
сохранён только для совместимости.
```

- [ ] **Step 4: Bump the plugin manifest**

Set:

```json
"version": "0.3.0"
```

Do not change author, repository, capabilities, marketplace data, or provider
configuration.

- [ ] **Step 5: Search live product files for the removed contract**

Run:

```bash
if rg -n "WorkflowStatus|waitMs|heartbeat" scripts skills README.md .mcp.json .codex-plugin
then
  exit 1
fi
if rg -n 'name: "WorkflowStatus"|\.heartbeat|heartbeat:' tests/mcp-boundary.test.mjs
then
  exit 1
fi
wait_ms_match_count=$(rg -n -c "waitMs" tests/mcp-boundary.test.mjs)
test "$wait_ms_match_count" = "1"
```

Expected: the first two commands have no matches. The third prints `1` for the
intentional unsupported-argument boundary case. Do not modify historical files
under `docs/superpowers/` or `.superpowers/sdd/`.

- [ ] **Step 6: Validate the skill, plugin, syntax, and non-canary suite**

Run:

```bash
python3 /home/dirard/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/native-workflow
python3 /home/dirard/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
node --check scripts/workflow-mcp.mjs
node --test tests/mcp-boundary.test.mjs
git diff --check
```

Expected: both validators PASS, syntax PASS, all non-canary tests PASS with
only the live canary skipped, and no whitespace errors.

- [ ] **Step 7: Run the live GLM canary**

Run:

```bash
RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
```

Expected: all tests PASS, including two parallel GLM reviewer leaves and the
dependent synthesis leaf observed through `WorkflowWait`.

- [ ] **Step 8: Commit instructions and version metadata**

```bash
git add README.md skills/native-workflow/SKILL.md skills/native-workflow/references/claude-workflows.md .codex-plugin/plugin.json
git commit -m "docs: teach Codex to wait for workflow events"
```

---

## Final Verification and Integration

After all three tasks and checks are complete:

1. Run one fresh blind final implementation review over the complete frozen
   snapshot. If it reports valid blocking findings, apply only those fixes,
   run their narrow checks, and commit them before starting the next review
   group:

   ```bash
   git add scripts/workflow-mcp.mjs tests/mcp-boundary.test.mjs .mcp.json .codex-plugin/plugin.json README.md skills/native-workflow/SKILL.md skills/native-workflow/references/claude-workflows.md docs/superpowers/specs/2026-07-29-workflow-event-wait-design.md docs/superpowers/plans/2026-07-29-workflow-event-wait.md
   git commit -m "fix: address workflow wait review"
   ```

   This exact allow-list contains only task-scoped files; do not use
   `git add -A`. Repeat within the allowed review-cycle limit until blocking
   findings are zero or the limit is reached. Do not publish or install a
   worktree with uncommitted review fixes. If the hard-cap final self-review
   makes a task-scoped fix, run its narrow check and commit it with the same
   allow-list before integration.

2. After the final review group, run the complete verification, publication,
   exact marketplace deployment, and installation in one shell so every
   operation uses the same committed `reviewed_sha`:

   ```bash
   set -euo pipefail
   test -z "$(git status --porcelain)"
   reviewed_sha=$(git rev-parse HEAD)
   node --check scripts/workflow-mcp.mjs
   node --test tests/mcp-boundary.test.mjs
   python3 /home/dirard/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/native-workflow
   python3 /home/dirard/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
   git diff --check v0.2.0 "$reviewed_sha"
   RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
   git push origin "$reviewed_sha:refs/heads/main"
   gh release create v0.3.0 --target "$reviewed_sha" --title "v0.3.0" --notes "Replaces heartbeat polling and WorkflowStatus with event-driven WorkflowWait."
   gh release view v0.3.0 --json tagName,targetCommitish,url
   marketplace_name=$(python3 /home/dirard/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py)
   test "$marketplace_name" = "personal"
   deployment_root=$(mktemp -d /home/dirard/plugins/codex-dynamic-workflow-plugin.deploy.XXXXXX)
   mkdir "$deployment_root/source"
   git archive --format=tar --output="$deployment_root/plugin.tar" "$reviewed_sha"
   tar -xf "$deployment_root/plugin.tar" -C "$deployment_root/source"
   python3 /home/dirard/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py "$deployment_root/source"
   node -e 'const m = require(process.argv[1]); if (m.version !== "0.3.0") process.exit(1)' "$deployment_root/source/.codex-plugin/plugin.json"
   marketplace_source=/home/dirard/plugins/codex-dynamic-workflow-plugin
   deployment_backup="${marketplace_source}.backup-$(date -u +%Y%m%d-%H%M%S)"
   test -f "$marketplace_source/.codex-plugin/plugin.json"
   test ! -e "$deployment_backup"
   printf 'deployment backup: %s\n' "$deployment_backup"
   mv "$marketplace_source" "$deployment_backup"
   mv "$deployment_root/source" "$marketplace_source"
   rm "$deployment_root/plugin.tar"
   rmdir "$deployment_root"
   codex plugin add "codex-dynamic-workflow-plugin@$marketplace_name"
   installed_plugin=/home/dirard/.codex/plugins/cache/personal/codex-dynamic-workflow-plugin/0.3.0
   test -f "$installed_plugin/.codex-plugin/plugin.json"
   node -e 'const m = require(process.argv[1]); if (m.version !== "0.3.0") process.exit(1)' "$installed_plugin/.codex-plugin/plugin.json"
   node -e 'const c = require(process.argv[1]); if (c.mcpServers["claude-workflow"].tool_timeout_sec !== 31536000) process.exit(1)' "$installed_plugin/.mcp.json"
   node --test "$installed_plugin/tests/mcp-boundary.test.mjs"
   test -z "$(git status --porcelain)"
   printf 'reviewed commit: %s\n' "$reviewed_sha"
   ```

   Expected: all checks and live canary PASS; release `v0.3.0` targets the
   printed `reviewed_sha`; the recoverable backup path is printed; installed
   tests confirm `WorkflowWait` is published and `WorkflowStatus` is absent.

3. Test the newly installed MCP tools from a new Codex task, because the
   current task does not reload plugin tool definitions in place.

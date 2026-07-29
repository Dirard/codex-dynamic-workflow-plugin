# Workflow Progress Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an asynchronous MCP lifecycle that lets Codex observe native Claude Workflow phases, general-purpose roles, and leaf progress without imposing an execution deadline, while preserving Claude Workflow as a universal orchestration surface.

**Architecture:** Keep `claude mcp serve` as the only workflow runtime. `WorkflowStart` launches and registers a native run, a background watcher consumes the append-only native journal and terminal state, and `WorkflowStatus` returns revisioned phase/role/leaf events or a 20-second heartbeat. `WorkflowStop` provides explicit cancellation, while the existing synchronous `Workflow` delegates to the same run engine for compatibility. The core skill links a comprehensive adaptation of Claude's native Workflow guidance; independent prompt-based reviewers are one optional recipe.

**Tech Stack:** Node.js 20+ ESM and standard library only, JSON-RPC/MCP over stdio, native Claude Code 2.1.204 Dynamic Workflows, Node test runner.

## Global Constraints

- Follow [the approved design](../specs/2026-07-29-workflow-progress-status-design.md).
- Codex defines the DAG, prompts, schemas, dependencies, and next action; GLM-5.2 is used only by leaf `agent()` calls.
- Add no runtime or test dependencies.
- Add no total workflow deadline. Keep only a 15-second inner MCP handshake/launch timeout and a 20-second maximum for one status long-poll.
- Preserve the existing `Workflow({cwd, script, args?})` contract for callers that still need the synchronous path.
- Status output must never expose credentials, provider responses, prompts, leaf results before terminal state, transcript paths, or native state paths.
- Derive every journal/state path from a validated native `scriptPath`; status and stop inputs accept only a validated `runId`.
- Preserve general research, implementation, transformation, testing, synthesis, and custom DAG workflows; reviewer cycles must not become the default for unrelated tasks.
- Provide optional prompt-based `product`, `correctness`, `security`, `tests`, `architecture`, `api-compatibility`, `performance`, `simplicity`, and `synthesis` role contracts.
- Keep the existing Claude Code permissions warning: prompt-based read-only reviewers still receive native `Bash`, `Edit`, and `Write` tools; do not claim technical isolation.
- Target plugin and MCP server version `0.2.0`.

## File Structure

- Modify `scripts/workflow-mcp.mjs`: publish the four MCP tools, own the in-memory run registry, watch native journal/state, normalize safe snapshots, and preserve the synchronous adapter.
- Modify `tests/mcp-boundary.test.mjs`: extend the fake Claude runtime, cover async lifecycle and progress events, and move the live GLM canary to the async tools.
- Modify `skills/native-workflow/SKILL.md`: keep the universal Codex orchestration loop, require the complete native guidance reference, define tracked role-aware leaves, and route review requests to the optional reviewer recipe.
- Create `skills/native-workflow/references/claude-workflows.md`: adapt the complete Claude Code 2.1.204 Dynamic Workflow runtime guidance and mark plugin-specific deltas.
- Create `skills/native-workflow/references/reviewer-roles.md`: define the optional independent parallel review-cycle and prompt-only read-only boundary.
- Modify `skills/native-workflow/agents/openai.yaml`: describe the asynchronous MCP dependency.
- Modify `README.md`: document observable progress, heartbeat, cancellation, and the absence of an execution deadline.
- Modify `.codex-plugin/plugin.json`: publish version `0.2.0` and mention observable execution status.

---

### Task 1: Asynchronous MCP Lifecycle

**Files:**
- Modify: `tests/mcp-boundary.test.mjs`
- Modify: `scripts/workflow-mcp.mjs`

**Interfaces:**
- Consumes: native `Workflow({script, args?})` launch payload `{status, runId, scriptPath}`.
- Produces: `WorkflowStart({cwd, script, args?})`, `WorkflowStatus({runId, afterRevision?, waitMs?})`, `WorkflowStop({runId})`, and compatible `Workflow({cwd, script, args?})`.
- Produces internal functions:
  - `startWorkflow(nativeArguments, cwd): Promise<RunRecord>`
  - `waitForStatus(run, afterRevision, waitMs): Promise<object>`
  - `stopWorkflow(run): object`
  - `snapshotRun(run, afterRevision, heartbeat): object`
  - `appendEvent(run, event): void`
  - `finishRun(run, status, terminalState?): boolean`

- [ ] **Step 1: Make tool publication fail for the missing lifecycle tools**

Replace the existing publication assertion with exact tool names and schemas:

```js
test("configured MCP publishes the workflow lifecycle tools", async (t) => {
  const client = startClient();
  t.after(() => client.stop());
  await initialize(client);

  const { tools } = await client.request("tools/list", {});
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "Workflow",
    "WorkflowStart",
    "WorkflowStatus",
    "WorkflowStop",
  ]);
  assert.deepEqual(byName.WorkflowStart.inputSchema.required, ["cwd", "script"]);
  assert.deepEqual(byName.WorkflowStatus.inputSchema.required, ["runId"]);
  assert.equal(byName.WorkflowStatus.inputSchema.properties.afterRevision.default, 0);
  assert.equal(byName.WorkflowStatus.inputSchema.properties.waitMs.default, 0);
  assert.equal(byName.WorkflowStatus.inputSchema.properties.waitMs.maximum, 20_000);
  assert.deepEqual(byName.WorkflowStop.inputSchema.required, ["runId"]);
});
```

Extract the repeated initialization sequence into this test helper:

```js
async function initialize(client) {
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-06-18");
  client.notify("notifications/initialized");
  return initialized;
}
```

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```bash
node --test --test-name-pattern="publishes the workflow lifecycle tools" tests/mcp-boundary.test.mjs
```

Expected: FAIL because only `Workflow` is present.

- [ ] **Step 3: Publish and route the four tools**

In `scripts/workflow-mcp.mjs`, replace `WORKFLOW_TIMEOUT_MS` with:

```js
const SERVER_VERSION = "0.2.0";
const INNER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_STATUS_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const runs = new Map();
```

Reuse one workflow input schema for `Workflow` and `WorkflowStart`, add strict
status/stop schemas, and publish all four tools:

```js
const tools = [workflowStartTool, workflowStatusTool, workflowStopTool, workflowTool];
```

Return concise server instructions from `initialize`:

```js
instructions:
  "Use WorkflowStart, then poll WorkflowStatus with its latest revision until terminal. " +
  "Report phase/role/leaf changes and heartbeat updates. Use WorkflowStop when the run is cancelled.",
```

Route `tools/call` with an explicit `switch (params?.name)` and return
`toolError("Unknown tool")` for every other name.

- [ ] **Step 4: Run the publication test**

Run:

```bash
node --test --test-name-pattern="publishes the workflow lifecycle tools" tests/mcp-boundary.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Add a failing asynchronous start/status test**

Extend `createWorkflowClaude()` with `FAKE_WORKFLOW_STATE_DELAY_MS`. The fake
must send the native launch response immediately, then write terminal state
after the configured delay:

```js
const delay = Number(process.env.FAKE_WORKFLOW_STATE_DELAY_MS || 0);
setTimeout(() => {
  if (process.env.FAKE_WORKFLOW_NO_STATE === "1") return;
  fs.writeFileSync(
    path.join(stateRoot, runId + ".json"),
    JSON.stringify({
      runId,
      status: process.env.FAKE_WORKFLOW_STATUS || "completed",
      result: { cwd: process.cwd() },
    }),
  );
}, delay);
```

Add this test:

```js
test("WorkflowStart returns before terminal state and WorkflowStatus returns the result", async (t) => {
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
      script: 'export const meta = { name: "async", description: "Async" };\nreturn { ok: true };',
    },
  });
  assertToolSuccess(started, "WorkflowStart");
  const launch = parseToolPayload(started);
  assert.equal(launch.status, "starting");
  assert.equal(launch.revision, 0);

  const completed = await client.request("tools/call", {
    name: "WorkflowStatus",
    arguments: { runId: launch.runId, afterRevision: 0, waitMs: 1_000 },
  });
  assertToolSuccess(completed, "WorkflowStatus");
  const snapshot = parseToolPayload(completed);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.result.cwd, repositoryRoot);
});
```

- [ ] **Step 6: Run the async test and confirm the expected failure**

Run:

```bash
node --test --test-name-pattern="WorkflowStart returns before terminal state" tests/mcp-boundary.test.mjs
```

Expected: FAIL because `WorkflowStart` is not implemented.

- [ ] **Step 7: Refactor the native launch into a run record without a deadline**

Replace the monolithic `runWorkflow()`/`waitForWorkflow()` deadline loop with:

```js
async function startWorkflow(nativeArguments, cwd) {
  const configError = providerConfigError();
  if (configError) throw new Error(configError);

  const native = await startNativeClient(cwd);
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
    void watchRun(run).catch(() => {
      finishRun(run, "failed");
    });
    return run;
  } catch (error) {
    native.close();
    throw error;
  }
}
```

`startNativeClient()` keeps the existing stdio JSON-RPC logic but gives every
inner request its own `INNER_REQUEST_TIMEOUT_MS`; it must not derive a timeout
from workflow duration.

`parseNativeLaunch()` must retain the current checks for `async_launched`,
`runId`, absolute `scriptPath`, and the `scripts` parent directory.

Every terminal source uses one exactly-once transition:

```js
function appendEvent(run, event) {
  run.revision += 1;
  run.events.push({ revision: run.revision, ...event });
}

function finishRun(run, status, terminalState) {
  if (run.terminal) return false;
  run.terminal = true;
  run.status = status;
  run.terminalState = terminalState;
  run.result = terminalState?.result;
  appendEvent(run, { type: `workflow_${status}` });
  run.close();
  return true;
}
```

The first watcher implementation only polls terminal state and rechecks the
guard after each asynchronous operation:

```js
async function watchRun(run) {
  while (!run.terminal) {
    const state = await readNativeState(run);
    if (run.terminal) return;
    if (state) {
      finishFromNativeState(run, state);
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
}
```

There is deliberately no elapsed-time condition in this loop.

- [ ] **Step 8: Implement Start, Status, Stop, and compatible Workflow handlers**

Use one success encoder:

```js
function toolSuccess(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}
```

`WorkflowStart` returns `{runId, status: "starting", revision: 0, elapsedMs: 0}`.
`WorkflowStatus` validates `runId`, then assigns
`afterRevision = args.afterRevision ?? 0` and `waitMs = args.waitMs ?? 0`.
Validate both as integers, require `afterRevision >= 0`, and bound `waitMs`
between `0` and `MAX_STATUS_WAIT_MS`. Then wait until the revision changes, the
run becomes terminal, or `waitMs` expires. Add a test that
`WorkflowStatus({runId})` succeeds immediately with both defaults.
`WorkflowStop` marks a running run as killed before closing its native child;
repeated calls return the same snapshot.

`finishFromNativeState()` stores the complete validated native state as
`run.terminalState` and its user result separately as `run.result`.
`WorkflowStatus` exposes only `run.result` on terminal snapshots. The compatible
handler preserves the version 0.1 contract by returning the complete native
terminal state:

```js
async function runWorkflow(nativeArguments, cwd) {
  const run = await startWorkflow(nativeArguments, cwd);
  while (!run.terminal) await delay(POLL_INTERVAL_MS);
  if (run.status === "completed") return run.terminalState;
  if (run.status === "killed") throw new Error("Workflow was killed");
  throw new Error("Workflow failed");
}
```

No workflow-duration deadline may appear in this path.

`WorkflowStop`, valid native terminal state, unexpected child exit, watcher
failure, and adapter shutdown must all call `finishRun()`. The first caller
wins; later completions return the same immutable snapshot. A watcher must
recheck `run.terminal` after journal reads, transcript reads, state reads, and
poll delays so a completed read cannot overwrite an explicit stop.

- [ ] **Step 9: Run the complete boundary suite**

Run:

```bash
node --test tests/mcp-boundary.test.mjs
```

Expected: all non-canary tests pass; the live canary remains skipped.

- [ ] **Step 10: Commit the asynchronous lifecycle**

```bash
git add scripts/workflow-mcp.mjs tests/mcp-boundary.test.mjs
git commit -m "feat: add asynchronous workflow lifecycle"
```

---

### Task 2: Native Journal Progress Events

**Files:**
- Modify: `tests/mcp-boundary.test.mjs`
- Modify: `scripts/workflow-mcp.mjs`

**Interfaces:**
- Consumes: native journal JSONL events `{type: "started"|"result", agentId, result?}` and the prefix of `agent-<agentId>.jsonl`.
- Produces: monotonically increasing `revision`, safe `events`, `activeLeaves`, `currentPhase`, `counts`, and heartbeat snapshots.
- Marker contract:
  - `<codex-workflow-progress>{"phase":"Inspect","role":"correctness","label":"inspect-readme"}</codex-workflow-progress>`
  - `phase`, `role`, and `label` are strings of 1–80 characters.

- [ ] **Step 1: Make incremental progress and redaction fail**

Teach the fake Claude process to create:

```text
<session>/subagents/workflows/wf_fixture/journal.jsonl
<session>/subagents/workflows/wf_fixture/agent-agentone.jsonl
```

For `FAKE_WORKFLOW_PROGRESS=1`, write the agent transcript first, append a
`started` journal line, append a `result` line after 50 ms, and write terminal
state after 100 ms. The transcript's first user prompt must contain the strict
progress marker plus `SECRET_PROMPT_TEXT`; the journal result must contain
`SECRET_LEAF_RESULT`.

Add a test that polls from the returned revision:

```js
test("WorkflowStatus reports revisioned leaf progress without transcript data", async (t) => {
  const client = await startFakeProgressClient(t);
  const launch = await startFakeWorkflow(client);

  const running = parseToolPayload(await client.request("tools/call", {
    name: "WorkflowStatus",
    arguments: { runId: launch.runId, afterRevision: 0, waitMs: 1_000 },
  }));
  assert.equal(running.events[0].type, "leaf_started");
  assert.equal(running.events[0].phase, "Inspect");
  assert.equal(running.events[0].role, "correctness");
  assert.equal(running.events[0].label, "inspect-readme");
  assert.equal(running.counts.active, 1);

  const serialized = JSON.stringify(running);
  assert.doesNotMatch(serialized, /SECRET_PROMPT_TEXT|SECRET_LEAF_RESULT/);
  assert.doesNotMatch(serialized, /subagents|journal\\.jsonl|agent-agentone/);

  const completed = parseToolPayload(await client.request("tools/call", {
    name: "WorkflowStatus",
    arguments: {
      runId: launch.runId,
      afterRevision: running.revision,
      waitMs: 1_000,
    },
  }));
  assert.ok(completed.events.some((event) => event.type === "leaf_completed"));
  assert.equal(completed.counts.active, 0);
  assert.equal(completed.counts.completed, 1);
});
```

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```bash
node --test --test-name-pattern="reports revisioned leaf progress" tests/mcp-boundary.test.mjs
```

Expected: FAIL because status has no journal events.

- [ ] **Step 3: Consume journal additions once**

Add `journalPath`, `journalOffset`, `journalTail`, and `pendingJournalEvents` to
each run record. Import `open` from `node:fs/promises`.

Read only bytes appended since `journalOffset`:

```js
async function readJournalAdditions(run) {
  let file;
  try {
    file = await open(run.journalPath, "r");
    const { size } = await file.stat();
    if (size <= run.journalOffset) return [];
    const chunk = Buffer.alloc(size - run.journalOffset);
    await file.read(chunk, 0, chunk.length, run.journalOffset);
    run.journalOffset = size;
    const lines = `${run.journalTail}${chunk.toString("utf8")}`.split("\n");
    run.journalTail = lines.pop();
    return lines.filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Unable to read workflow journal");
  } finally {
    await file?.close();
  }
}
```

Do not reread old journal results on every 250 ms poll.

- [ ] **Step 4: Parse only the progress marker from the transcript prefix**

Read at most 8 KiB from `agent-<agentId>.jsonl`, locate the strict marker, decode
the JSON-string escaping once, then parse the embedded object. Accept only
plain objects whose `phase`, `role`, and `label` are strings from 1 to 80
characters.

```js
const PROGRESS_PATTERN =
  /<codex-workflow-progress>(.{1,1024}?)<\\/codex-workflow-progress>/;

function validateProgressMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.phase !== "string" || value.phase.length < 1 || value.phase.length > 80) return null;
  if (typeof value.role !== "string" || value.role.length < 1 || value.role.length > 80) return null;
  if (typeof value.label !== "string" || value.label.length < 1 || value.label.length > 80) return null;
  return { phase: value.phase, role: value.role, label: value.label };
}
```

On any missing/invalid marker, use
`{phase: null, role: null, label: "leaf-<shortId>"}`. Never include the matched
transcript text in a returned error.

- [ ] **Step 5: Turn journal lines into revisioned events**

For `started`, create a leaf record and `leaf_started`. For `result`, close the
same leaf and emit `leaf_completed` when `result !== null`, otherwise
`leaf_failed`. Reuse Task 1's `appendEvent()` so each append increments
`run.revision` exactly once:

```js
function appendEvent(run, event) {
  run.revision += 1;
  run.events.push({ revision: run.revision, ...event });
}
```

Set `currentPhase` from the newest started leaf. A terminal native state calls
`finishRun()` with `completed`, `failed`, or `killed`; that single guarded path
appends the matching terminal event and closes the child. `snapshotRun()`
returns only events whose revision is greater than `afterRevision`.

- [ ] **Step 6: Implement heartbeat and timing fields**

`waitForStatus()` returns immediately on a newer revision or terminal state. If
the long-poll expires, return an empty event list with `heartbeat: true`.
Compute `elapsedMs` and active leaf `elapsedMs` from observation timestamps;
return `durationMs` for finished leaf events.

- [ ] **Step 7: Run progress, redaction, and full boundary tests**

Run:

```bash
node --test --test-name-pattern="reports revisioned leaf progress" tests/mcp-boundary.test.mjs
node --test tests/mcp-boundary.test.mjs
```

Expected: focused test passes; all non-canary tests pass.

- [ ] **Step 8: Add failure, heartbeat, and stop coverage**

Add tests with exact assertions:

- unknown `runId` and invalid `afterRevision`/`waitMs` return safe tool errors;
- `result: null` produces one `leaf_failed` and `counts.failed === 1`;
- a run with no journal/state returns `heartbeat: true` after `waitMs: 10`;
- `WorkflowStop` emits `workflow_killed`, terminates the fake child, and is
  idempotent;
- a fake state read released after `WorkflowStop` cannot replace `killed`;
  exactly one terminal workflow event remains;
- malformed journal/state input produces one safe `workflow_failed`; a second
  run on the same MCP server still completes;
- closing adapter input still terminates every active fake child;
- an unexpected fake child exit produces `workflow_failed`.

- [ ] **Step 9: Run the complete boundary suite**

Run:

```bash
node --test tests/mcp-boundary.test.mjs
node --check scripts/workflow-mcp.mjs
git diff --check
```

Expected: all non-canary tests pass, syntax check passes, diff check is clean.

- [ ] **Step 10: Commit observable progress**

```bash
git add scripts/workflow-mcp.mjs tests/mcp-boundary.test.mjs
git commit -m "feat: report native workflow progress"
```

---

### Task 3: Codex Guidance, Live Canary, and Version 0.2.0

**Files:**
- Modify: `skills/native-workflow/SKILL.md`
- Modify: `skills/native-workflow/agents/openai.yaml`
- Create: `skills/native-workflow/references/claude-workflows.md`
- Create: `skills/native-workflow/references/reviewer-roles.md`
- Modify: `tests/mcp-boundary.test.mjs`
- Modify: `README.md`
- Modify: `.codex-plugin/plugin.json`

**Interfaces:**
- Consumes: the lifecycle tools and event payload from Tasks 1–2.
- Produces: an explicit Codex workflow:
  `WorkflowStart → WorkflowStatus(afterRevision, waitMs: 20000) → terminal`,
  plus `WorkflowStop` on cancellation.
- Produces: universal Claude Workflow scripting guidance, tracked
  `leaf(phaseName, role, label, prompt, options?)`, and an optional prompt-based
  independent parallel review-cycle.

- [ ] **Step 1: Read the skill-writing instructions before editing the skill**

Use both required skills:

```text
skill-creator
superpowers:writing-skills
```

Read their complete `SKILL.md` files and only the references they route to for
an existing skill update.

- [ ] **Step 2: Record the no-skill baseline before editing**

Give fresh agents both a general multi-stage workflow request and the optional
review-cycle/status-loop request without access to
`skills/native-workflow/SKILL.md`. Record whether they misuse
`pipeline()`/`parallel()`, omit stable progress metadata, use unsupported
`agentType`, treat prompt-based read-only as enforced, or miss the
`WorkflowStart`/`WorkflowStatus` loop. These observed failures define the
minimal guidance added next.

- [ ] **Step 3: Create the complete adapted Claude Workflow reference**

Create `skills/native-workflow/references/claude-workflows.md` from the
versioned runtime guidance in
`/home/dirard/.local/share/claude/versions/2.1.204`. Preserve the source
Workflow section order — purpose/invocation, `meta`, hooks, script runtime,
pipeline-vs-barrier, limits, canonical patterns, quality patterns, resume —
while applying the plugin deltas below. `SKILL.md` will require reading this
file before generating any workflow. Cover the universal API and behavior:

- pure-literal `meta` with required `name`/`description`, optional
  `whenToUse`/`phases`, and exact phase-title matching;
- plain JavaScript in an async body;
- `agent(prompt, {label, phase, schema, isolation})`, including structured
  output and a possible `null` return;
- `pipeline(items, ...stages)` as the default for independent per-item chains,
  with `(previousResult, originalItem, index)` and failed items becoming
  `null`;
- `parallel(thunks)` as a barrier only when the next step needs all prior
  results, with failed thunks becoming `null`;
- `phase()`, `log()`, real JSON `args`, guarded `budget` loops, and optional
  nested `workflow()` where the native registry is available;
- deterministic scripts: no imports, Node/filesystem APIs, `Date.now()`,
  argless `new Date()`, or `Math.random()`;
- native limits: concurrent agents capped by the runtime, 1000 agents per run,
  and 4096 items per `parallel()`/`pipeline()` call;
- general compositions: fan-out/fan-in, map/reduce, multi-stage pipelines,
  conditional branches, loop-until-count, loop-until-budget, loop-until-dry,
  judge panels, adversarial verification, perspective-diverse verification,
  multi-modal sweep, and completeness critics.

Mark the plugin deltas explicitly:

- Codex writes the exact DAG and passes the script inline;
- omit `model`, `effort`, and custom `agentType` so leaf calls inherit
  `glm-5.2` from the MCP session;
- `isolation: "worktree"` is reserved for parallel mutating leaf agents, not
  read-only review;
- native resume through outer `scriptPath`/`resumeFromRunId` is not exposed by
  the version 0.2.0 wrapper;
- `log()` is diagnostic, while `WorkflowStatus` is the observable status
  source.

- [ ] **Step 4: Update the core skill and optional reviewer recipe**

Update `skills/native-workflow/SKILL.md` to remain general-purpose, require
`references/claude-workflows.md` for every invocation, and include:

```js
function leaf(phaseName, role, label, prompt, options = {}) {
  const progress = JSON.stringify({ phase: phaseName, role, label });
  return agent(
    `<codex-workflow-progress>${progress}</codex-workflow-progress>\n${prompt}`,
    { ...options, label, phase: phaseName },
  );
}
```

`role` may be any stable short identifier appropriate to the leaf; reviewer
names are not required for research, implementation, migration, testing, or
other workflows. Require:

- pure-literal `meta` with exact matching `phases`;
- `phase()` before each stage;
- every leaf through `leaf()` with stable role and label;
- functions, not promises, in `parallel()`;
- `pipeline()` for independent item transformations;
- JSON Schema for structured outputs;
- real JSON values in `args`;
- no imports, Node APIs, clocks, or randomness;
- no `model` or custom `agentType`, so GLM-5.2 remains leaf-only.

Create `skills/native-workflow/references/reviewer-roles.md` as an optional
recipe loaded only for independent review requests. Add concise prompt
contracts for `product`, `correctness`, `security`, `tests`, `architecture`,
`api-compatibility`, `performance`, `simplicity`, and `synthesis`:

```js
const READ_ONLY_REVIEW =
  "READ ONLY: inspect the assigned snapshot. Do not edit files, run mutating " +
  "commands, install dependencies, commit, or change external systems. " +
  "Bash/Edit/Write may still be visible: this prompt is not a sandbox.";

const REVIEW_ROLES = {
  product:
    "Check the requested user outcome, scope, and user-visible behavior.",
  correctness:
    "Trace logic and state transitions; find reproducible correctness and edge-case defects.",
  security:
    "Check trust boundaries, validation, permissions, secrets, and data exposure.",
  tests:
    "Check whether tests are valid and whether material behavior is left unverified.",
  architecture:
    "Check module boundaries, ownership, dependencies, and architectural invariants.",
  "api-compatibility":
    "Check public contracts, schemas, errors, versioning, and backward compatibility.",
  performance:
    "Check practical algorithmic, concurrency, latency, and resource risks.",
  simplicity:
    "Find unnecessary code or abstraction and name the smallest sufficient replacement.",
  synthesis:
    "Deduplicate supplied reviews, preserve source anchors, and do not invent findings.",
};
```

The review example must:

1. select five to eight relevant reviewer roles;
2. give every reviewer the same original context and no peer outputs;
3. run reviewers concurrently through `parallel()`;
4. tell reviewers not to edit files, run mutating commands, commit, or mutate
   external systems;
5. state immediately that this is a prompt contract, not a sandbox, because
   leaf agents may still receive `Bash`, `Edit`, and `Write`;
6. run `synthesis` only after the parallel barrier;
7. return raw reviews and synthesis for Codex to adjudicate.

Replace the synchronous execution section with the exact polling loop:

```text
1. Call WorkflowStart with absolute cwd and exact script.
2. Report the launch and first planned phase.
3. Call WorkflowStatus with the latest revision and waitMs=20000.
4. Report changed phase/role/leaf events; on heartbeat say briefly that work continues.
5. Repeat until completed/failed/killed; include the active role in updates.
6. On user cancellation or task replacement, call WorkflowStop.
7. Validate every terminal leaf output; only Codex chooses another workflow.
```

- [ ] **Step 5: Update the live canary to use tracked leaves and async tools**

Change `canaryScript` to define role-aware `leaf()`, add separate `Review` and
`Synthesize` phases, and call all three agents through the helper.

The live test must:

1. call `WorkflowStart`;
2. loop over `WorkflowStatus` using the returned revision;
3. collect events until terminal;
4. assert roles `architecture`, `product`, and `synthesis`;
5. assert labels `review-architecture`, `review-product`, and
   `synthesize-reviews`;
6. assert both phases;
7. assert the same three non-empty final structured outputs as version 0.1.0.

Do not add an elapsed-time stop condition to the plugin. The test harness may
retain its 620-second request timeout so CI cannot hang forever.

- [ ] **Step 6: Update metadata and user documentation**

In `.codex-plugin/plugin.json` set `"version": "0.2.0"` and update
`interface.longDescription` to mention observable phases and leaf status.

In `skills/native-workflow/agents/openai.yaml`, replace “Bundled synchronous”
with “Bundled observable Claude Code Dynamic Workflow lifecycle”.

In `README.md`, document:

- immediate `runId`;
- phase/role/leaf updates and 20-second heartbeat;
- universal Claude Workflow guidance for arbitrary Codex-planned DAGs;
- the nine prompt-based reviewer roles as an optional independent
  parallel-review recipe;
- prompt-based read-only intent is not a sandbox or permissions boundary;
- explicit cancellation;
- no total workflow deadline on the async path;
- the legacy synchronous tool is compatibility-only;
- the existing Claude permissions warning remains unchanged.

- [ ] **Step 7: Forward-test and validate the skill**

Give fresh agents the updated skill path and both requests from Step 2:

- for a general multi-stage task, confirm correct native
  `pipeline()`/`parallel()` selection, role-aware leaves, and the asynchronous
  status loop without introducing reviewer roles;
- for a review request, confirm relevant prepared roles, independent prompts,
  the read-only limitation, and the same status loop.

Run:

```bash
node --check scripts/workflow-mcp.mjs
node --test tests/mcp-boundary.test.mjs
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" .
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" skills/native-workflow
git diff --check
```

Expected: syntax passes; all non-canary tests pass; both validators pass; diff
check is clean.

- [ ] **Step 8: Run the live GLM canary**

Run:

```bash
RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
```

Expected: all tests pass, including observable parallel reviewer roles,
Synthesis leaf, and terminal structured result.

- [ ] **Step 9: Commit version 0.2.0**

```bash
git add .codex-plugin/plugin.json README.md skills/native-workflow/SKILL.md skills/native-workflow/agents/openai.yaml skills/native-workflow/references tests/mcp-boundary.test.mjs
git commit -m "feat: teach Codex to monitor GLM workflows"
```

---

### Task 4: Install and Publish Version 0.2.0

**Files:**
- No repository source changes expected.
- Update personal marketplace source: `/home/dirard/plugins/codex-dynamic-workflow-plugin`
- Reinstall through: `/home/dirard/.agents/plugins/marketplace.json`

**Interfaces:**
- Consumes: one clean, reviewed commit whose manifest version is `0.2.0`.
- Produces: enabled local plugin `codex-dynamic-workflow-plugin@personal`,
  remote `main`, annotated tag `v0.2.0`, and GitHub Release `v0.2.0`.

- [ ] **Step 1: Run fresh release verification**

Run the validation and live canary commands from Task 3 Steps 7–8 again on the
exact commit to be published. Also run:

```bash
git status --short --branch
git rev-parse HEAD
```

Expected: clean tree on `main`; ordinary suite, live canary, validators, syntax,
and diff checks all pass.

- [ ] **Step 2: Refresh the personal marketplace source from the candidate commit**

```bash
release_commit=$(git rev-parse HEAD)
release_stage_dir=$(mktemp -d)
git archive --format=tar "$release_commit" | tar -xf - -C "$release_stage_dir"
plugin_source=/home/dirard/plugins/codex-dynamic-workflow-plugin
test "$(realpath "$plugin_source")" = "$plugin_source"
rsync -a --delete --exclude '.env' --exclude '.git' "$release_stage_dir/" "$plugin_source/"
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" "$plugin_source"
```

Expected: the personal marketplace source contains the exact candidate archive,
preserves every `.env`, and validates as version `0.2.0`. Do not edit
`marketplace.json` or global Codex config by hand.

- [ ] **Step 3: Reinstall and verify the cached plugin**

Read the marketplace name with the plugin-creator helper, then run:

```bash
plugin_marketplace_name=$(python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/read_marketplace_name.py")
codex plugin add "codex-dynamic-workflow-plugin@$plugin_marketplace_name" --json
codex plugin list
```

Validate the exact installed cache path returned by the install command and run
its non-canary boundary suite. Confirm `.env` still exists only under the
configured user config directory with mode `600`; never print its values.

- [ ] **Step 4: Push the installed and verified commit**

```bash
git push origin main
```

Expected: `origin/main` advances to the verified commit without force-push.

- [ ] **Step 5: Create and publish the annotated tag**

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

Expected: local and remote tag resolve to the installed candidate commit.

- [ ] **Step 6: Create the GitHub Release**

Create a non-draft, non-prerelease GitHub Release with `gh release create`,
title `v0.2.0 — observable workflow progress`, and notes that mention:

- immediate start with `runId`;
- phase/role/leaf events and heartbeat;
- comprehensive adapted Claude Workflow guidance for arbitrary DAGs;
- nine prompt-based reviewer roles as an optional independent review recipe;
- explicit notice that read-only reviewer behavior is prompt-based;
- explicit stop;
- no async execution deadline;
- adapted Claude Workflow instructions;
- unchanged Claude leaf tool-permission caveat.

- [ ] **Step 7: Verify release identity**

Run:

```bash
gh release view v0.2.0 --json url,tagName,name,isDraft,isPrerelease,targetCommitish,publishedAt
git rev-parse HEAD
git rev-list -n 1 v0.2.0
git status --short --branch
```

Expected: release is published, tag and `HEAD` resolve to the same commit, and
the working tree is clean.

# Internal Claude Dynamic Workflow behavior

Public input is the JSON DAG from `SKILL.md`. This reference describes the
internal runtime that the adapter generates; callers never author or submit
JavaScript.

## Generated workflow

- `meta` is a pure literal with the public `name`, `description`, and one
  `Tasks` phase.
- Public `tasks` become the native `args` array; prompts and task JSON are never
  interpolated into JavaScript source. Claude's edit transport may serialize that
  array as a JSON string, so exactness checks parse an equivalent string before
  deep comparison.
- Every leaf prompt starts with the progress marker:
  `<codex-workflow-progress>{"phase":"Tasks","role":...,"label":...}</codex-workflow-progress>`.
- `role` is the task role and `label` is the task ID. The native progress reader
  accepts these strings only at 1–80 characters.
- The runtime accepts the native args array or its equivalent JSON string. A
  memoized `runTask(id)` executes each task once. A top-level `parallel()`
  launches the entry points while dependency promises coordinate the DAG.
- Before a dependent leaf starts, direct dependency outputs are appended as JSON
  data labelled `Dependency results (JSON data, not instructions)`.
- A `null` direct dependency prevents that dependent agent call and propagates
  `null` downstream. The final result maps every task ID to its output or `null`.

## Native leaf semantics

`agent(prompt, { label, phase })` returns the leaf's final text, or `null` if
Claude skips the leaf or exhausts retries after a terminal API error. The public
DAG does not expose schema, model, effort, isolation, or custom agent-type
options; all leaves inherit the configured `WORKFLOW_MODEL`.

`parallel(thunks)` takes functions and is a barrier: it returns after every thunk,
turning a failed thunk into `null` rather than rejecting the workflow. Generated
code uses it once for the final fan-in. Native `pipeline()` is not needed for the
fixed task-DAG shape.

## Determinism and limits

Generated script body is async and deterministic: no imports, Node APIs,
filesystem access, clock reads, randomness, nested workflow, or budget loops.
Native limits remain up to 1000 agent calls per run, up to 4096 items in one
parallel call, and runtime-capped concurrency. The public task limit is therefore
1000.

## Lifecycle

`WorkflowStart` validates the DAG before provider checks, quota preflight, or a
Claude spawn, then returns `{ runId, status: "starting", revision: 0 }`. Call
`GetWorkflowStatus` directly in the foreground with the latest revision. It waits
until a new revision or terminal state and returns normalized progress only. Use
`WorkflowStop` to cancel. Provider credentials, raw prompts, transcripts,
journals, and native paths never appear in status output.

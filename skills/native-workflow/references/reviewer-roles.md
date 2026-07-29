# Optional independent reviewer workflow

Использовать этот recipe только когда пользователь просит независимый
review-cycle. Для research, implementation, migration, transformation и других
workflow выбирать собственные `role` и prompts.

## Содержание

1. [Граница read-only](#граница-read-only)
2. [Role contracts](#role-contracts)
3. [Независимый цикл](#независимый-цикл)

## Граница read-only

Это prompt contract, не sandbox. Leaf может видеть native Claude Code tools,
включая `Bash`, `Edit` и `Write`. Prompt запрещает mutations, но техническую
изоляцию обеспечивают только permissions Claude Code или отдельное окружение.
Не писать пользователю, что `readOnly: true`, reviewer role или prompt
ограничивают tools: такого механизма wrapper не предоставляет.

```js
const READ_ONLY_REVIEW =
  "READ ONLY: inspect the assigned snapshot. Do not edit files, run mutating " +
  "commands, install dependencies, commit, or change external systems. " +
  "Bash/Edit/Write may still be visible: this prompt is not a sandbox.";
```

## Role contracts

```js
const REVIEW_ROLES = {
  product:
    "Check the requested user outcome, scope, and user-visible behavior.",
  correctness:
    "Trace logic and state transitions; report reproducible correctness and edge-case defects.",
  security:
    "Check trust boundaries, validation, permissions, secrets, and data exposure.",
  tests:
    "Check test validity and material behavior left unverified.",
  architecture:
    "Check module boundaries, ownership, dependencies, and architectural invariants.",
  "api-compatibility":
    "Check public contracts, schemas, errors, versioning, and backward compatibility.",
  performance:
    "Check practical algorithmic, concurrency, latency, and resource risks.",
  simplicity:
    "Find unnecessary complexity and name the smallest sufficient replacement.",
  synthesis:
    "Deduplicate supplied reviews, preserve source anchors, and do not invent findings.",
};
```

Выбрать 5–8 ролей, которые реально относятся к задаче. Каждому reviewer дать
одинаковый original task context и отдельный role contract. Не включать outputs
других reviewers в prompt: независимость важнее согласованности.

## Независимый цикл

```js
export const meta = {
  name: "independent-review-cycle",
  description: "Run independent review lenses and synthesize their findings",
  phases: [
    { title: "Review", detail: "Independent reviewers inspect one snapshot" },
    { title: "Synthesize", detail: "Deduplicate the completed reviews" },
  ],
};

const FINDING = {
  type: "object",
  properties: {
    severity: { type: "string" },
    source: { type: "string" },
    expected: { type: "string" },
    actual: { type: "string" },
    impact: { type: "string" },
    smallestFix: { type: "string" },
  },
  required: [
    "severity",
    "source",
    "expected",
    "actual",
    "impact",
    "smallestFix",
  ],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    role: { type: "string" },
    findings: { type: "array", items: FINDING },
  },
  required: ["role", "findings"],
  additionalProperties: false,
};

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    findings: { type: "array", items: FINDING },
    disagreements: { type: "array", items: { type: "string" } },
  },
  required: ["findings", "disagreements"],
  additionalProperties: false,
};

const selected = args.roles;
const context = args.context;

phase("Review");
const reviews = await parallel(
  selected.map((role, index) => () =>
    leaf(
      "Review",
      role,
      `review-${role}-${index}`,
      `${READ_ONLY_REVIEW}\n\nRole: ${REVIEW_ROLES[role]}\n\n` +
        `Original task context:\n${context}\n\n` +
        "Return only concrete findings with source anchors. " +
        "Return an empty findings array when none exist.",
      { schema: REVIEW_SCHEMA },
    ),
  ),
);

const completed = reviews.filter(Boolean);
phase("Synthesize");
const synthesis = await leaf(
  "Synthesize",
  "synthesis",
  "synthesize-reviews",
  `${READ_ONLY_REVIEW}\n\n${REVIEW_ROLES.synthesis}\n\n` +
    `Raw independent reviews:\n${JSON.stringify(completed)}`,
  { schema: SYNTHESIS_SCHEMA },
);

return { reviews, synthesis };
```

Перед запуском Codex формирует `args.roles` и self-contained `args.context`.
После terminal result Codex получает raw reviews и synthesis, проверяет каждый
finding и только сам решает, нужны ли fixes или новый review-cycle.

# Optional independent reviewer DAG

Использовать этот recipe только когда пользователь просит независимый
review-cycle. Для research, implementation, migration и других workflow выбирать
собственные `role` и prompts.

## Граница read-only

Это prompt contract, не sandbox. Leaf может видеть native Claude Code tools,
включая `Bash`, `Edit` и `Write`. Prompt запрещает mutations, но техническую
изоляцию обеспечивают permissions Claude Code или отдельное окружение. Не
утверждать, что reviewer role ограничивает tools.

Добавляйте в каждый prompt:

```text
READ ONLY: inspect the assigned snapshot. Do not edit files, run mutating
commands, install dependencies, commit, or change external systems.
Bash/Edit/Write may still be visible: this prompt is not a sandbox.
Return only concrete findings with source anchors, or an empty findings array.
```

## Role contracts

- `product`: requested user outcome, scope, user-visible behavior.
- `correctness`: logic, state transitions, reproducible defects, edge cases.
- `security`: trust boundaries, validation, permissions, secrets, data exposure.
- `tests`: test validity and material behavior left unverified.
- `architecture`: module boundaries, ownership, dependencies, invariants.
- `api-compatibility`: public contracts, schemas, errors, versioning.
- `performance`: practical algorithmic, concurrency, latency, resource risks.
- `simplicity`: unnecessary complexity and the smallest sufficient replacement.
- `synthesis`: deduplicate supplied reviews; preserve source anchors; invent nothing.

Выбрать 5–8 относящихся ролей. Reviewers независимы: каждый получает одинаковый
original task context и не получает outputs других reviewers. Synthesis зависит от
всех completed reviews и получает их как direct dependency JSON.

## DAG example

```json
{
  "name": "independent-review-cycle",
  "description": "Run independent review lenses and synthesize findings",
  "tasks": [
    {
      "id": "review-correctness",
      "role": "correctness",
      "prompt": "<read-only contract>\\n\\nRole: trace logic and state transitions...\\n\\nOriginal task context: ...",
      "dependsOn": []
    },
    {
      "id": "review-security",
      "role": "security",
      "prompt": "<read-only contract>\\n\\nRole: check trust boundaries...\\n\\nOriginal task context: ...",
      "dependsOn": []
    },
    {
      "id": "synthesize-reviews",
      "role": "synthesis",
      "prompt": "Deduplicate the supplied dependency results. Preserve source anchors and disagreements; invent no findings.",
      "dependsOn": ["review-correctness", "review-security"]
    }
  ]
}
```

После terminal result Codex проверяет raw findings и synthesis, затем сам решает,
нужны ли fixes или новый cycle.

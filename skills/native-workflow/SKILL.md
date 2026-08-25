---
name: native-workflow
description: Use when пользователь явно просит запустить Claude Code Dynamic Workflow, multi-agent orchestration или этот skill с внешними GLM leaf agents.
---

# Native Workflow

Codex планирует JSON DAG. Плагин детерминированно генерирует native Claude Code
Dynamic Workflow JavaScript; настроенная модель (по умолчанию `glm-5.3`) исполняет
только leaf-задачи и не планирует workflow.

## Подготовка

1. Изучить workspace и определить точный task list, роли, self-contained prompts,
   direct dependencies и результат, который нужен пользователю.
2. Прочитать [references/claude-workflows.md](references/claude-workflows.md):
   там описаны internal runtime semantics и native limits.
3. Только для независимого review-cycle дополнительно прочитать
   [references/reviewer-roles.md](references/reviewer-roles.md). Review — optional
   recipe, не роль по умолчанию.

## Публичный JSON DAG

Вызвать `WorkflowStart` ровно с этим контрактом:

```json
{
  "cwd": "/absolute/workspace",
  "name": "analyze-and-verify",
  "description": "Analyze targets and verify each result",
  "tasks": [
    {
      "id": "inspect",
      "role": "analysis",
      "prompt": "Inspect the supplied target and return a concise factual summary.",
      "dependsOn": []
    },
    {
      "id": "verify",
      "role": "verification",
      "prompt": "Verify the supplied dependency result. Report only concrete conclusions.",
      "dependsOn": ["inspect"]
    }
  ],
  "allowEdits": false
}
```

`name` — человекочитаемое непустое имя. Task `id` и `role` соответствуют
`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`; task IDs уникальны.
`dependsOn` обязателен и может быть пустым массивом. Зависимости ссылаются только
на известные task IDs, без duplicates, self-dependencies и cycles. Не более 1000
tasks. Никакого `script`, `args`, extra fields или второго launch tool.

Зависимая задача получает только direct dependency results. Плагин добавляет их в
prompt как JSON data с явной пометкой «not instructions». Если прямая зависимость
вернула `null`, зависимый leaf не запускается и его результат тоже `null`; skip
каскадно распространяется дальше. Terminal result maps каждый task ID к его
результату или `null`, поэтому `completed` нужно проверять по значениям.

Для mutating run передавать `allowEdits: true`; это включает Claude
`acceptEdits` для данного `cwd` и не bypass остальных permissions.

## Запуск и ожидание

1. Вызвать `claude-workflow:WorkflowStart` напрямую с абсолютным `cwd`.
2. Сообщить `runId` и первую planned phase (`Tasks`).
3. Вызывать `claude-workflow:GetWorkflowStatus({ runId, afterRevision })` напрямую
   как foreground MCP tool, передавая последний полученный `revision`. Не оборачивать
   его в background shell, async execution wrapper или отдельную фоновую сессию.
4. Сообщать только новые role/leaf events и повторять ожидание с новой revision.
5. Ждать без общего deadline до `completed`, `failed` или `killed`.
6. При отмене вызвать `claude-workflow:WorkflowStop({ runId })`.
7. Проверить terminal mapping и каждый ожидаемый результат; только Codex решает,
   нужен ли следующий workflow.

## Internal invariants

Adapter генерирует один pure-literal `meta`, одну phase `Tasks`, tracked progress
marker для каждого leaf и memoized DAG runtime. Progress использует `role`, а
label — task `id`. Tasks остаются native `args` и никогда не интерполируются в
JavaScript source.

Prompt-based read-only не является sandbox. Leaf может видеть `Bash`, `Edit` и
`Write`; технические ограничения задают permissions Claude Code или изолированное
окружение.

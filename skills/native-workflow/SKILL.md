---
name: native-workflow
description: Use when пользователь явно просит запустить Claude Code Dynamic Workflow, multi-agent orchestration или этот skill с GLM-5.2 leaf agents.
---

# Native Workflow

Codex определяет DAG, prompts, schemas, условия и следующие действия. GLM-5.2
исполняет только leaf-вызовы `agent()`; не отдавать ему планирование workflow.

## Подготовка

1. Перед созданием любого script полностью прочитать
   [references/claude-workflows.md](references/claude-workflows.md).
2. Только для независимого review-cycle дополнительно прочитать
   [references/reviewer-roles.md](references/reviewer-roles.md). Review — один
   optional recipe; не добавлять reviewer roles в research, implementation,
   migration или другой DAG без причины.
3. Изучить workspace и самостоятельно определить точный work list, fan-out,
   dependencies, barriers, prompts, JSON Schemas и stop conditions.

## Tracked leaf

Включить helper в каждый script и вызывать через него каждый `agent()`:

```js
function leaf(phaseName, role, label, prompt, options = {}) {
  const progress = JSON.stringify({ phase: phaseName, role, label });
  return agent(
    `<codex-workflow-progress>${progress}</codex-workflow-progress>\n${prompt}`,
    { ...options, label, phase: phaseName },
  );
}
```

`phase`, `role` и `label` — стабильные строки длиной 1–80 символов. `role`
описывает функцию leaf (`analysis`, `implementation`, `verification`,
`synthesis` и т. п.), а не обязательно reviewer preset.

Сохранять native contract: pure-literal `meta` с exact matching `phases`,
`phase()` перед каждой стадией, plain JavaScript, functions в `parallel()`,
`pipeline()` для независимых item chains, structured output через JSON Schema,
real JSON в `args`. Не использовать imports, Node API, clocks/randomness,
`model`, `effort` или custom `agentType`.

## Запуск и status loop

1. Вызвать `claude-workflow:WorkflowStart({ cwd, script, args? })` с абсолютным
   `cwd` и точным inline script.
2. Сразу сообщить пользователю `runId` и первую запланированную phase.
3. Повторять
   `claude-workflow:WorkflowStatus({ runId, afterRevision, waitMs: 20000 })`,
   передавая последний полученный `revision`.
4. Сообщать только новые phase/role/leaf events. При `heartbeat: true` кратко
   подтвердить, что работа продолжается, и назвать активную phase/role.
5. Продолжать без общего deadline до `completed`, `failed` или `killed`.
6. При отмене, замене задачи или явной команде пользователя вызвать
   `claude-workflow:WorkflowStop({ runId })`.
7. Проверить terminal result и каждый ожидаемый leaf output. Только Codex
   решает, нужен ли следующий workflow.

Старый `Workflow` остаётся compatibility tool; для новых и больших задач его
не выбирать. `log()` — native diagnostic, не замена `WorkflowStatus`.

Prompt-based read-only не является sandbox. Leaf может видеть `Bash`, `Edit` и
`Write`; технические ограничения задаются permissions Claude Code или
изолированным окружением.

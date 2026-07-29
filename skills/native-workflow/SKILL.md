---
name: native-workflow
description: Use when пользователь явно вызывает этот skill или прямо просит Codex запустить Claude Code Dynamic Workflow с GLM-5.2 leaf agents.
---

# Native Workflow

Codex определяет весь workflow. GLM-5.2 выполняет только точные leaf-задачи в
`agent()`; не просить Claude или GLM построить, изменить или продолжить план.

## Выполнение

1. Изучить задачу и workspace, затем самостоятельно зафиксировать DAG, промпты,
   зависимости, схемы и условия.
2. Сформировать self-contained top-level JavaScript: pure-literal `meta`, без
   imports, Node.js API, `Date.now()` и `Math.random()`.
3. Не указывать `model` или нестандартный `agentType`: leaf agents наследуют
   `glm-5.2` из MCP session.
4. Вызвать `claude-workflow:Workflow` с точным `script`; не передавать свободный
   goal вместо script.
5. Получить background `task_id`. Если пользователь явно не запросил фоновый
   запуск, дождаться завершения через
   `claude-workflow:TaskOutput({ task_id, block: true, timeout: 600000 })`.
6. Проверить completed result и каждый leaf output. Только Codex решает, нужен
   ли следующий workflow.

```js
export const meta = {
  name: "repository-analysis",
  description: "Analyze architecture and tests in parallel",
};

const RESULT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

const [architecture, tests] = await parallel([
  () =>
    agent("Analyze architecture. Return facts only.", {
      label: "architecture",
      schema: RESULT_SCHEMA,
    }),
  () =>
    agent("Analyze tests and likely gaps. Return facts only.", {
      label: "tests",
      schema: RESULT_SCHEMA,
    }),
]);

if (!architecture || !tests) {
  throw new Error("Parallel analysis failed");
}

const synthesis = await agent(
  `Synthesize both results. Return facts only.\n${JSON.stringify({
    architecture,
    tests,
  })}`,
  {
    label: "synthesis",
    schema: RESULT_SCHEMA,
  },
);

return { architecture, tests, synthesis };
```

## Lifecycle

| Действие | Tool и аргументы |
|---|---|
| Inline запуск | `claude-workflow:Workflow({ script, args })` |
| Сохранённый workflow | `claude-workflow:Workflow({ name, args })` |
| Статус | `claude-workflow:TaskOutput({ task_id, block: false, timeout: 0 })` |
| Ожидание | `claude-workflow:TaskOutput({ task_id, block: true, timeout: 600000 })` |
| Отмена | `claude-workflow:TaskStop({ task_id })` |

Если `Workflow` недоступен, возвращает `isError` или любой leaf output равен
`null`, сообщить ошибку. Не заменять вызов свободным промптом, который отдаёт
планирование GLM.

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
4. Вызвать `claude-workflow:Workflow` с абсолютным `cwd` текущего workspace и
   точным `script`; не передавать свободный goal вместо script.
5. Дождаться синхронного ответа wrapper и проверить `status: "completed"`,
   `result` и каждый leaf output. Только Codex решает, нужен ли следующий
   workflow.

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

## Вызов

Использовать `claude-workflow:Workflow({ cwd, script, args? })`. Wrapper запускает
native Claude Code Workflow в `cwd`, дожидается terminal metadata и возвращает
результат одним MCP-вызовом.

До первого запуска настроить `ANTHROPIC_BASE_URL` и
`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` в окружении Codex либо в
`${XDG_CONFIG_HOME:-$HOME/.config}/codex-dynamic-workflow-plugin/.env`.

Если `Workflow` недоступен, возвращает `isError`, terminal status не
`completed` или любой leaf output равен `null`, сообщить ошибку. Не заменять
вызов свободным промптом, который отдаёт планирование GLM.

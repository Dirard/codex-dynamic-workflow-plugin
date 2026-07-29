# Codex Dynamic Workflow Plugin

Codex строит точный JavaScript workflow и остаётся оркестратором. Нативный
Claude Code Dynamic Workflow исполняет сценарий, а `glm-5.2` работает только
внутри leaf-вызовов `agent()`. Плагин сразу возвращает `runId`, показывает
phase/role/leaf progress и не ограничивает общую длительность async workflow.

## Требования

- Node.js 20+
- Claude Code 2.1.204+ с Dynamic Workflows
- Z.AI account с Anthropic-compatible API

## Настройка Z.AI

Создайте
`${XDG_CONFIG_HOME:-$HOME/.config}/codex-dynamic-workflow-plugin/.env`:

```dotenv
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=ваш_Z.AI_API_key
```

Ограничьте доступ:

```bash
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/codex-dynamic-workflow-plugin/.env"
```

Вместо файла можно передать те же переменные окружению Codex.
`ANTHROPIC_API_KEY` поддерживается как альтернатива
`ANTHROPIC_AUTH_TOKEN`. Значения из окружения имеют приоритет.

## Использование

После установки плагина явно вызовите:

```text
$codex-dynamic-workflow-plugin:native-workflow
```

Codex сформирует script, передаст абсолютный путь текущего workspace в `cwd`,
вызовет `WorkflowStart`, а затем `WorkflowWait` с последним `revision`. Wait
возвращается только после реального изменения phase/role/leaf или terminal
state; периодические пустые ответы и polling по таймеру отсутствуют.

У async path нет общего execution deadline. `WorkflowStop` явно отменяет run,
будит pending Wait и возвращает killed state. Старый синхронный `Workflow`
сохранён только для совместимости.

Bundled reference адаптирует native Claude Workflow guidance для произвольных
Codex-planned DAG: `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`,
`budget`, nested workflow, loops, fan-out/fan-in, judge panels и verification
patterns. Девять prompt-based reviewer roles доступны как optional независимый
parallel-review recipe; review не является назначением плагина по умолчанию.

Provider URL и credentials не передаются leaf agents через промпт и не
хранятся в репозитории.

## Проверка

```bash
node --test tests/mcp-boundary.test.mjs
RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
```

Canary запускает два параллельных GLM reviewer leaf и зависимый synthesis leaf,
наблюдая их через async lifecycle. В Claude Code 2.1.204 custom agent tool
restrictions недоступны через `mcp serve`: leaf получает стандартные Claude
Code tools, включая `Bash`, `Edit` и `Write`. Prompt-based read-only означает
намерение, а не sandbox или permissions boundary. Codex approval относится
только к внешнему MCP-вызову; sandbox profile Codex автоматически не
применяется внутри MCP. Для гарантии используйте permissions/settings Claude
Code или отдельное окружение.

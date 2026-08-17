# Codex Dynamic Workflow Plugin

Codex строит точный JavaScript workflow и остаётся оркестратором. Нативный
Claude Code Dynamic Workflow исполняет сценарий, а настроенная GLM работает
только внутри leaf-вызовов `agent()`. Плагин сразу возвращает `runId`, показывает
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
# WORKFLOW_MODEL=glm-5.3
# WORKFLOW_MIN_QUOTA_REMAINING_PERCENT=50
# WORKFLOW_QUOTA_URL=https://api.z.ai/api/monitor/usage/quota/limit
```

Ограничьте доступ:

```bash
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/codex-dynamic-workflow-plugin/.env"
```

Вместо файла можно передать те же переменные окружению Codex.
`ANTHROPIC_API_KEY` поддерживается как альтернатива
`ANTHROPIC_AUTH_TOKEN`. Значения из окружения имеют приоритет.
`WORKFLOW_MODEL` задаёт модель основной Claude-сессии и всех leaf agents;
по умолчанию используется `glm-5.3`.

Перед `WorkflowStart` и legacy `Workflow` адаптер проверяет Z.AI квоту
5-часового модельного окна и блокирует запуск, когда remaining percent меньше
`WORKFLOW_MIN_QUOTA_REMAINING_PERCENT`. По умолчанию порог `50`; допустимы
конечные значения `0..100`, включая дробные. Значение `0` полностью отключает
preflight-запрос. Публичный tool `WorkflowQuota` без аргументов всегда делает
запрос и возвращает только `level`, `usedPercent`, `remainingPercent` и
`resetAt` (epoch milliseconds либо `null`, пока окно ещё не стартовало).
Authorization содержит значение Z.AI token без префикса `Bearer`.

## Использование

Для запросов на Claude Code Dynamic Workflow или multi-agent orchestration
Codex может активировать навык автоматически. Явный вариант остаётся доступен:

```text
$codex-dynamic-workflow-plugin:native-workflow
```

Codex сформирует точный исполняемый JavaScript `script` (не текст задания),
передаст абсолютный путь workspace внешнего агента в `cwd` и вызовет
`WorkflowStart`. Для mutating run можно передать `allowEdits: true`: дочерний
Claude стартует в `acceptEdits` для этого `cwd`, без bypass остальных
permissions.

`WorkflowWait` нужно вызывать напрямую как MCP tool с последним `revision`,
не через background/async shell или execution wrapper. Wait сам удерживает
вызов до реального изменения phase/role/leaf или terminal state; периодические
пустые ответы и polling по таймеру отсутствуют.

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
RUN_WORKFLOW_EDIT_CANARY=1 node --test tests/mcp-boundary.test.mjs
```

Canary запускает два параллельных GLM reviewer leaf и зависимый synthesis leaf,
наблюдая их через async lifecycle. Edit-canary проверяет реальную запись leaf.
В Claude Code 2.1.233 `mcp serve` фиксирует default permission context, поэтому
`allowEdits: true` использует полноценную print/SDK session с `acceptEdits`, а
read-only path остаётся на `mcp serve`. Transport session ограничена hook-ом:
она может вызвать только `Workflow`, тогда как edit-права применяются к leaf.
Prompt-based read-only означает
намерение, а не sandbox или permissions boundary. Codex approval относится
только к внешнему MCP-вызову; sandbox profile Codex автоматически не
применяется внутри MCP. Для гарантии используйте permissions/settings Claude
Code или отдельное окружение.

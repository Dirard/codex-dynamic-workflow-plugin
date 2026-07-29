# Codex Dynamic Workflow Plugin

Codex строит точный JavaScript workflow и остаётся оркестратором. Нативный
Claude Code Dynamic Workflow исполняет сценарий, а `glm-5.2` работает только
внутри leaf-вызовов `agent()`.

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
вызовет синхронный MCP tool `Workflow` и проверит terminal result. Provider URL
и credentials не передаются leaf agents через промпт и не хранятся в
репозитории.

## Проверка

```bash
node --test tests/mcp-boundary.test.mjs
RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
```

Canary запускает два параллельных GLM leaf с read-only заданиями и зависимый
leaf синтеза. В Claude Code 2.1.204 custom agent tool restrictions недоступны
через `mcp serve`: leaf получает стандартные Claude Code tools, включая
`Bash`, `Edit` и `Write`. Codex approval относится только к внешнему вызову
`Workflow`; sandbox profile Codex автоматически не применяется внутри MCP.
Ограничивайте leaf через permissions/settings Claude Code и изоляцию окружения.

# Codex Dynamic Workflow Plugin — implementation plan

> **Для agentic workers:** использовать `superpowers:subagent-driven-development`
> или `superpowers:executing-plans`.

## Цель

Выпустить минимальный Codex plugin, в котором Codex единолично планирует
Dynamic Workflow и передаёт exact JavaScript нативному Claude Code runtime.
`glm-5.2` выполняет только leaf-вызовы `agent()`.

## Подтверждённая архитектура

Claude Code 2.1.204 в режиме `mcp serve`:

- игнорирует глобальные `--model` и `--agents`;
- не загружает custom agent types;
- не публикует workflow task через `TaskOutput`, `TaskStop` или notifications;
- записывает terminal state в `<workflow-root>/<runId>.json`.

Поэтому bundled stdio wrapper публикует один синхронный MCP tool `Workflow`.
Он запускает настоящий `claude mcp serve`, передаёт exact script, ждёт native
state JSON и возвращает результат Codex. Wrapper не реализует собственный
workflow runtime или DSL.

## Ограничения

- Codex задаёт DAG, параллелизм, зависимости, промпты, схемы и ветвление.
- GLM не получает свободный goal для построения или продолжения плана.
- Workflow script — self-contained top-level JavaScript без imports, Node.js
  API, `Date.now()` и `Math.random()`; `meta` — pure literal.
- Leaf не задаёт `model` или нестандартный `agentType`.
- Использовать только Node.js stdlib; не добавлять dependencies, UI, bridge,
  marketplace entry, queues, retries или собственное storage.
- Не хранить provider URL и credentials в репозитории.
- Skill запускается явно:
  `policy.allow_implicit_invocation: false`.

## Task 1: synchronous MCP wrapper

**Files:**

- `.mcp.json`
- `scripts/workflow-mcp.mjs`
- `tests/mcp-boundary.test.mjs`

1. Настроить `.mcp.json` на `node ./scripts/workflow-mcp.mjs` с
   `tool_timeout_sec: 620`.
2. Передавать из Codex environment:
   `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` и
   `XDG_CONFIG_HOME`.
3. Загружать недостающие provider values из
   `${XDG_CONFIG_HOME:-$HOME/.config}/codex-dynamic-workflow-plugin/.env`;
   process env имеет приоритет.
4. Fail closed без абсолютного HTTP(S) base URL и одного из двух auth env.
5. Публиковать только
   `Workflow({ cwd: absolutePath, script, args? })`.
6. Запускать внутренний `claude mcp serve` в переданном `cwd` с:

   ```text
   CLAUDE_CODE_WORKFLOWS=1
   ANTHROPIC_MODEL=glm-5.2
   CLAUDE_CODE_SUBAGENT_MODEL=glm-5.2
   ```

7. Дождаться native state; вернуть `completed`, немедленно завершить ошибкой
   для `failed` и `killed`, а после 600 секунд вернуть timeout.
8. Корректно обрабатывать ранний exit и `EPIPE` внутреннего MCP.
9. При EOF stdin, `SIGINT` или `SIGTERM` остановить все активные внутренние
   процессы Claude.
10. Покрыть boundary-тестами MCP handshake, schema, fail-closed provider,
    workspace cwd и terminal lifecycle.

## Task 2: plugin manifest и skill

**Files:**

- `.codex-plugin/plugin.json`
- `skills/native-workflow/SKILL.md`
- `skills/native-workflow/agents/openai.yaml`

1. Подключить `./skills/` и `./.mcp.json` из manifest.
2. Зафиксировать автора `Dirard <ardaginaa@gmail.com>` и repository URL.
3. Научить Codex формировать exact script и вызывать
   `claude-workflow:Workflow` с абсолютным cwd текущего workspace.
4. Проверять terminal `status`, `result` и каждый leaf output до ответа.
5. Не заменять ошибку свободным промптом к GLM.
6. Оставить explicit invocation и stdio dependency `claude-workflow`.

## Task 3: документация и реальный canary

**Files:**

- `README.md`
- `docs/superpowers/specs/2026-07-29-codex-dynamic-workflow-plugin-design.md`
- `tests/mcp-boundary.test.mjs`

1. Документировать Z.AI Anthropic-compatible env и personal XDG `.env`.
2. Явно указать ограничение Claude Code 2.1.204: leaf получает стандартные
   `Bash`, `Edit` и `Write`; read-only prompt не является security boundary.
   Codex approval покрывает внешний MCP-вызов, а ограничения внутренних tools
   задают permissions/settings Claude Code и изоляция окружения.
3. Optional canary должен выполнить два независимых GLM leaf параллельно и
   третий GLM leaf для синтеза, затем проверить три непустых structured outputs.

## Финальная проверка

```bash
node --check scripts/workflow-mcp.mjs
node --test tests/mcp-boundary.test.mjs
RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" \
  skills/native-workflow
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" .
git diff --check
git status --short
```

После зелёной проверки закоммитить итог одним commit.

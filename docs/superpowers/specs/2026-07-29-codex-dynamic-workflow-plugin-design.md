# Codex Dynamic Workflow Plugin — дизайн

## Цель

Создать минимальный плагин Codex, в котором Codex остаётся единственным
оркестратором: анализирует задачу, строит план и передаёт готовый исполняемый
JavaScript в нативный `Workflow` Claude Code. Модель `glm-5.2` выполняет только
leaf-вызовы `agent()`.

## Граница ответственности

- Codex определяет DAG, параллелизм, зависимости, промпты, схемы результатов и
  условия ветвления.
- Claude Code исполняет уже готовый сценарий через нативный runtime Dynamic
  Workflows.
- GLM-5.2 получает только конкретные задания внутри `agent()` и не создаёт,
  не переписывает и не продолжает план workflow.
- После результата или ошибки только Codex решает, завершить работу, исправить
  сценарий или запустить новый workflow.

Свободный `run_prompt`, собственный DSL и отдельный MCP runtime не входят в
плагин: они дублировали бы возможности Claude Code и размывали бы роль Codex.

## Состав

```text
.codex-plugin/plugin.json
.mcp.json
skills/native-workflow/
├── SKILL.md
└── agents/openai.yaml
tests/mcp-boundary.test.mjs
```

- `plugin.json` описывает плагин и подключает skill и MCP-конфигурацию.
- `.mcp.json` запускает установленный `claude` в режиме MCP с
  `CLAUDE_CODE_WORKFLOWS=1` и session model `glm-5.2`.
- `SKILL.md` учит Codex формировать точный self-contained Workflow script и
  сохраняет границу «Codex планирует, GLM исполняет».
- `openai.yaml` содержит краткие метаданные skill для интерфейса.
- Boundary-test использует только Node.js stdlib, запускает реальную команду из
  `.mcp.json` и проверяет MCP handshake и опубликованные инструменты.

## Поток выполнения

1. Codex изучает задачу и рабочее дерево, затем сам формирует окончательный
   top-level JavaScript без импортов.
2. Codex вызывает `claude-workflow:Workflow`, передавая точный `script`, `name`
   и при необходимости `args`.
3. Нативный runtime исполняет `agent()`, `parallel()`, `pipeline()` и другие
   поддерживаемые примитивы. Все leaf agents наследуют session model
   `glm-5.2`; сценарий не задаёт другую модель или нестандартный `agentType`.
4. Для фонового запуска Codex получает результат через
   `claude-workflow:TaskOutput`; для отмены использует
   `claude-workflow:TaskStop`.
5. Codex проверяет выходы и самостоятельно принимает следующее оркестрационное
   решение.

Workflow script должен быть детерминированным plain JavaScript: без imports,
Node.js API, `Date.now()` и `Math.random()`. `meta` — только pure literal.

## Конфигурация и безопасность

MCP запускается так:

```text
CLAUDE_CODE_WORKFLOWS=1 claude --disable-slash-commands --model glm-5.2 mcp serve
```

`--bare` и `--safe-mode` не используются, потому что они скрывают `Workflow`.
Ключи, токены и URL провайдера не хранятся в репозитории; `claude` получает
настройки из внешнего окружения. Процесс наследует рабочий каталог Codex, чтобы
leaf agents работали в том же проекте и под действующими sandbox/approval
ограничениями.

Если `claude` отсутствует, MCP не публикует `Workflow` или вызов leaf agent
завершается ошибкой, Codex сообщает конкретную ошибку. Он не заменяет вызов
свободным промптом и не передаёт планирование GLM.

## Проверка

- Smoke-вызов локального Responses proxy подтверждает доступность
  `glm-5.2`.
- Node.js boundary-test проверяет настоящий MCP handshake и наличие
  `Workflow`, `TaskOutput`, `TaskStop`, а не текст конфигурации.
- Read-only canary запускает два независимых `agent()` и синтез результата,
  подтверждая совместимость GLM с нативным Workflow.
- Skill проходит baseline/forward-test: без skill Codex сохраняет правильную
  роль, но формирует несуществующий JSON DAG; со skill он должен выдать точный
  executable JavaScript и вызвать нативный `Workflow`.
- Плагин и skill проходят штатные валидаторы Codex.

## Ограничения первой версии

- Требуются установленный Claude Code с поддержкой Dynamic Workflows и внешняя
  настройка доступа к GLM-5.2.
- Совместимость с non-Claude моделью обеспечивает провайдер proxy, а не
  Anthropic; обновление Claude Code может потребовать повторного canary.
- Плагин не добавляет собственные очереди, retries, idempotency storage,
  marketplace entry или UI. Они нужны только после появления подтверждённого
  эксплуатационного требования.

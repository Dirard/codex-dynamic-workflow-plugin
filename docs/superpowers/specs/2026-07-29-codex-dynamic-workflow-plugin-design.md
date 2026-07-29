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

Свободный `run_prompt` и собственный workflow runtime не входят в плагин: они
дублировали бы возможности Claude Code и размывали бы роль Codex. Небольшой MCP
wrapper нужен только для ожидания terminal metadata, которое внешний
`claude mcp serve` не отдаёт через `TaskOutput`.

## Состав

```text
.codex-plugin/plugin.json
.mcp.json
scripts/workflow-mcp.mjs
skills/native-workflow/
├── SKILL.md
└── agents/openai.yaml
tests/mcp-boundary.test.mjs
```

- `plugin.json` описывает плагин и подключает skill и MCP-конфигурацию.
- `.mcp.json` запускает bundled Node.js wrapper с Codex-side tool timeout
  620 секунд.
- `workflow-mcp.mjs` вызывает нативный `claude mcp serve` в переданном Codex
  workspace, передаёт точный script, ждёт `<session>/workflows/<runId>.json` и
  возвращает terminal result одним MCP-вызовом.
- `SKILL.md` учит Codex формировать точный self-contained Workflow script и
  сохраняет границу «Codex планирует, GLM исполняет».
- `openai.yaml` содержит краткие метаданные skill, зависимость от bundled MCP и
  запрещает implicit invocation: запуск дорогого workflow требует явного
  `$codex-dynamic-workflow-plugin:native-workflow` или прямой просьбы
  пользователя.
- Boundary-test использует только Node.js stdlib, запускает реальную команду из
  `.mcp.json` и проверяет MCP handshake и опубликованные инструменты.

## Поток выполнения

1. Codex изучает задачу и рабочее дерево, затем сам формирует окончательный
   top-level JavaScript без импортов.
2. Codex вызывает `claude-workflow:Workflow`, передавая абсолютный `cwd`
   текущего workspace, точный `script` и при необходимости `args`. Имя inline
   workflow находится в `meta.name`.
3. Нативный runtime исполняет `agent()`, `parallel()`, `pipeline()` и другие
   поддерживаемые примитивы. Все leaf agents наследуют session model
   `glm-5.2`; сценарий не задаёт другую модель или нестандартный `agentType`.
4. Внутренний `Workflow` возвращает background task ID. Wrapper ждёт native
   terminal metadata и возвращает completed result Codex синхронно.
5. Codex отвечает только после проверки завершённых выходов и самостоятельно
   принимает следующее оркестрационное решение.

Workflow script должен быть детерминированным plain JavaScript: без imports,
Node.js API, `Date.now()` и `Math.random()`. `meta` — только pure literal.

## Конфигурация и безопасность

Wrapper запускает внутренний MCP так:

```text
CLAUDE_CODE_WORKFLOWS=1 ANTHROPIC_MODEL=glm-5.2 \
CLAUDE_CODE_SUBAGENT_MODEL=glm-5.2 claude mcp serve
```

Глобальные `--model` и `--agents` не используются: Claude Code 2.1.204
игнорирует их в action `mcp serve`. Ключи, токены и URL провайдера не хранятся
в репозитории. Wrapper наследует `ANTHROPIC_BASE_URL` и
`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` из окружения либо загружает их из
`${XDG_CONFIG_HOME:-$HOME/.config}/codex-dynamic-workflow-plugin/.env`.
Переменные процесса имеют приоритет. `XDG_CONFIG_HOME` входит в allowlist
bundled MCP. Внутренний процесс запускается в абсолютном `cwd`, который Codex
передаёт при вызове `Workflow`.

Skill имеет `policy.allow_implicit_invocation: false` и объявляет stdio
dependency `claude-workflow` с command `node`. В установленном plugin Codex
запускает workflow только после явного
`$codex-dynamic-workflow-plugin:native-workflow` или прямого запроса
пользователя.

Если `claude` отсутствует, provider env не настроен или вызов leaf agent
завершается ошибкой, wrapper возвращает MCP error/terminal result, а Codex
сообщает ошибку. Он не заменяет вызов свободным промптом и не передаёт
планирование GLM.

## Проверка

- Smoke-вызов provider подтверждает доступность `glm-5.2`.
- Node.js boundary-test проверяет настоящий MCP handshake и синхронный
  `Workflow`, а не текст конфигурации.
- Canary с read-only заданиями запускает два независимых `agent()` параллельно
  и третий зависимый `agent()` для синтеза, подтверждая совместимость GLM с
  нативным Workflow.
- Skill проходит baseline/forward-test: без skill Codex сохраняет правильную
  роль, но формирует несуществующий JSON DAG; со skill в чистом временном
  fixture и без user config он должен вызвать `Workflow` и вернуть непустые
  результаты всех leaf agents.
- Плагин и skill проходят штатные валидаторы Codex.

## Ограничения первой версии

- Требуются установленный Claude Code с поддержкой Dynamic Workflows и внешняя
  настройка Anthropic-compatible доступа Z.AI к GLM-5.2.
- `mcp serve` 2.1.204 не загружает custom agent types, поэтому leaf получает
  стандартный набор Claude Code tools. Read-only prompt не является
  security boundary. Codex approval покрывает только внешний MCP-вызов, а
  sandbox profile Codex автоматически не применяется к внутренним Claude Code
  tools. Их границу задают permissions/settings Claude Code и изоляция
  окружения.
- Wrapper читает native workflow metadata, потому что `TaskOutput`, `TaskStop`,
  task notifications и task registry недоступны внешнему MCP client в 2.1.204.
  Обновление Claude Code может позволить удалить wrapper после повторного
  boundary-test.
- Плагин не добавляет собственные очереди, retries, idempotency storage,
  marketplace entry или UI. Они нужны только после появления подтверждённого
  эксплуатационного требования.

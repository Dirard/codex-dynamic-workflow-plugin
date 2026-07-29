# Codex Dynamic Workflow Plugin — статус выполнения

## Цель

Codex должен сразу получать идентификатор запущенного Claude Code Dynamic
Workflow, видеть фактические переходы leaf-задач, включая роль, когда она
задана, и регулярно сообщать пользователю, что работа продолжается. Большой
workflow не должен завершаться из-за общего временного лимита.

Codex остаётся оркестратором: он строит DAG, формирует точный JavaScript,
запускает workflow, интерпретирует статус и решает, что делать после terminal
result. GLM-5.2 выполняет только leaf-вызовы `agent()`.

## Проверенные ограничения

- Текущий MCP tool `Workflow` блокирует Codex до terminal result и скрывает
  промежуточное состояние.
- Актуальный Codex manual описывает MCP tools, но не гарантирует передачу
  progress notifications в контекст модели или интерфейс задачи.
- Claude Code 2.1.204 через `claude mcp serve` не отправляет progress
  notifications даже при переданном MCP `progressToken`.
- Native `<runId>.json` появляется с terminal state, а
  `subagents/workflows/<runId>/journal.jsonl` обновляется во время выполнения
  событиями `started` и `result`.

Поэтому статус строится на асинхронном MCP lifecycle и нативном journal, а не
на неподтверждённых progress notifications.

## Пользовательское поведение

1. Codex вызывает `WorkflowStart` и сразу получает `runId`.
2. Codex сообщает пользователю, что workflow запущен и какая phase начинается.
3. Codex вызывает `WorkflowStatus` с long-poll до 20 секунд.
4. При изменении Codex сообщает новую phase, роль и
   started/completed/failed leaf.
5. Если изменений нет, Codex раз в 20 секунд даёт короткий heartbeat.
6. После terminal status Codex проверяет result и сам принимает следующее
   оркестрационное решение.
7. При отмене или замене задачи Codex вызывает `WorkflowStop`.

Общего execution deadline нет. Workflow работает до native terminal state,
явного `WorkflowStop` или завершения MCP-процесса.

## MCP tools

### `WorkflowStart`

Вход остаётся совместимым с текущим запуском:

```json
{
  "cwd": "/absolute/workspace",
  "script": "self-contained JavaScript",
  "args": {}
}
```

`args` необязателен. Успешный ответ:

```json
{
  "runId": "wf_...",
  "status": "starting",
  "revision": 0,
  "elapsedMs": 0
}
```

Tool не возвращает `runId`, пока внутренний MCP handshake и native launch не
прошли проверку.

### `WorkflowStatus`

Вход:

```json
{
  "runId": "wf_...",
  "afterRevision": 0,
  "waitMs": 20000
}
```

`afterRevision` и `waitMs` необязательны; handler использует соответственно
`0` и `0`. `waitMs` ограничен диапазоном от 0 до 20 000 мс. Это ограничение
одного long-poll, а не workflow.

Ответ:

```json
{
  "runId": "wf_...",
  "status": "running",
  "revision": 1,
  "heartbeat": false,
  "elapsedMs": 12000,
  "currentPhase": "Inspect",
  "counts": {
    "started": 1,
    "active": 1,
    "completed": 0,
    "failed": 0
  },
  "activeLeaves": [
    {
      "id": "a1b2c3d4",
      "phase": "Inspect",
      "role": "correctness",
      "label": "inspect-readme",
      "elapsedMs": 12000
    }
  ],
  "events": [
    {
      "revision": 1,
      "type": "leaf_started",
      "id": "a1b2c3d4",
      "phase": "Inspect",
      "role": "correctness",
      "label": "inspect-readme"
    }
  ]
}
```

`events` содержит только события после `afterRevision`. При отсутствии
изменений tool возвращает тот же `revision`, пустой `events` и
`heartbeat: true`. Terminal snapshot дополнительно содержит final `result`.

Допустимые event types:

- `leaf_started`
- `leaf_completed`
- `leaf_failed`
- `workflow_completed`
- `workflow_failed`
- `workflow_killed`

### `WorkflowStop`

При running workflow завершает native child и возвращает terminal snapshot.
Повторный вызов для terminal run возвращает уже сохранённый snapshot.

### Совместимый `Workflow`

Существующий синхронный tool остаётся для старых callers и использует тот же
внутренний run engine. Обновлённый skill его не выбирает: большие задачи идут
только через `WorkflowStart` и `WorkflowStatus`. Плагин не добавляет собственный
execution deadline; внешний timeout синхронного caller не считается границей
native workflow.

## Источник phase и leaf metadata

Journal содержит фактические `agentId`, `started` и `result`, но не сохраняет
native `label`, `phase` и prompt-based `role`. Для точного отображения
обновлённый skill формирует каждый leaf через небольшой helper:

```js
function leaf(phaseName, role, label, prompt, options = {}) {
  const progress = JSON.stringify({ phase: phaseName, role, label });
  return agent(
    `<codex-workflow-progress>${progress}</codex-workflow-progress>\n${prompt}`,
    { ...options, label, phase: phaseName },
  );
}
```

Status reader принимает только `agentId` из безопасного single-segment
алфавита, проверяет принадлежность вычисленного transcript path каталогу
текущего run и извлекает строгую progress-метку только из первой user-записи
agent transcript. Первая запись читается до завершающего newline с жёстким
пределом 16 MiB, а не фиксированным 8 KiB prefix, поэтому подробные prompts не
теряют metadata. Assistant/tool records не сканируются. Prompt, transcript,
leaf result и filesystem paths не возвращаются. Некорректная, отсутствующая
или слишком длинная метка даёт `label: "leaf-<id>"`, `phase: null` и
`role: null`, не прерывая native workflow; небезопасный `agentId` безопасно
завершает run с ошибкой до чтения файла.

## Универсальные инструкции Claude Workflow

Review-cycle — один из recipes, а не назначение плагина. Core skill остаётся
универсальным и перед построением любого script требует прочитать bundled
reference, адаптированный из инструкций Claude Code 2.1.204.

Reference следует по порядку Workflow-разделу, извлечённому из versioned
runtime `/home/dirard/.local/share/claude/versions/2.1.204`, и покрывает:

- pure-literal `meta`, точные `phases` и plain JavaScript async body;
- полные доступные hooks: `agent()`, `pipeline()`, `parallel()`, `log()`,
  `phase()`, `args`, `budget` и вложенный `workflow()`;
- JSON Schema structured output и обработку `null` leaf;
- детерминизм, запрет Node.js/filesystem API, часов и randomness;
- `pipeline()` как default и точные случаи, когда нужен barrier `parallel()`;
- native concurrency/agent/item limits;
- loops, fan-out/fan-in, map/reduce, judge panels, adversarial verification,
  multi-modal sweep, completeness critic и loop-until-dry как composable
  examples;
- различия плагина: script передаётся inline, Codex задаёт весь DAG,
  `model`/`effort`/custom `agentType` не указываются, а resume by `scriptPath`
  не публикуется MCP wrapper версии 0.2.0;
- role-aware progress helper и асинхронный start/status/stop loop.

## Optional prompt-based reviewer recipe

Для независимого review-cycle skill дополнительно предоставляет девять готовых
контрактов:

- `product` — соответствие задаче и пользовательская ценность;
- `correctness` — логика, состояния и граничные случаи;
- `security` — trust boundaries, permissions и утечки;
- `tests` — валидность тестов и существенные пробелы;
- `architecture` — границы модулей и зависимости;
- `api-compatibility` — публичные контракты и обратная совместимость;
- `performance` — алгоритмические, конкурентные и ресурсные риски;
- `simplicity` — лишняя сложность и минимально достаточное решение;
- `synthesis` — дедупликация результатов без добавления новых findings.

Это prompt-контракты, а не Claude custom `agentType` и не техническая граница
permissions. `claude mcp serve` в версии 2.1.204 не передаёт custom agents в
native workflow, а leaf по-прежнему может видеть `Bash`, `Edit` и `Write`.
Поэтому reviewer prompt прямо запрещает изменения, команды с побочными
эффектами, commits и внешние mutations, но Codex не выдаёт это за sandbox.
Если нужна гарантированная изоляция, её обеспечивает окружение или permissions
Claude Code вне плагина.

Когда пользователь выбирает review-cycle, его строит Codex:

1. выбрать от пяти до восьми релевантных reviewer-ролей;
2. дать каждому одинаковый исходный task context и отдельный role contract;
3. запустить reviewers одновременно через `parallel()` без результатов друг
   друга в prompts;
4. после barrier передать структурированные outputs leaf с ролью `synthesis`;
5. вернуть raw reviews и synthesis Codex;
6. только Codex проверяет findings, решает, что исправлять, и запускает ли новый
   цикл.

## Plugin-specific deltas

Skill сохраняет нативную модель Claude Code 2.1.204 и изменяет только слой,
необходимый Codex:

- self-contained plain JavaScript начинается с pure-literal `meta`;
- `meta` содержит `name`, `description` и `phases`;
- названия в `meta.phases`, `phase()` и leaf `phase` совпадают точно;
- каждый leaf имеет стабильные `role` и `label` и создаётся через `leaf()`;
- `role` — любой стабильный короткий идентификатор; reviewer presets
  опциональны;
- custom `agentType` не указывается;
- `parallel()` получает функции, а не готовые promises;
- `pipeline()` используется для независимых стадий без лишнего barrier;
- structured leaf возвращает объект через JSON Schema;
- `args` передаётся как настоящее JSON-значение;
- imports, Node.js API, `Date.now()`, `new Date()` и `Math.random()` не
  используются;
- Codex задаёт DAG, условия, prompts и schemas; GLM-5.2 не планирует workflow;
- `log()` остаётся нативным диагностическим средством, но не считается
  источником live status.

Bundled reference следует runtime guidance Claude section-by-section, но не
копирует несвязанные части внутреннего system prompt и явно исключает
возможности, которые MCP wrapper версии 0.2.0 не публикует.

## Внутренний lifecycle

MCP server хранит running records в памяти процесса. Каждый record содержит
проверенный native `runId`, производные пути, child process, время запуска,
journal events и terminal snapshot.

Все источники завершения проходят через один guarded terminal transition,
который сохраняет первый terminal snapshot и игнорирует последующие. Фоновый
watcher:

1. читает append-only journal;
2. создаёт revisioned leaf events;
3. читает terminal state;
4. при terminal state ещё раз дочитывает journal и только после обработки
   финальных leaf events сохраняет result и закрывает native child.

После каждого асинхронного чтения watcher повторно проверяет terminal flag.
Ошибки watcher и неожиданный exit child превращаются в безопасный
`workflow_failed`, а не в unhandled rejection MCP server. Watcher не завершает
workflow по времени. Отдельные 15-секундные таймауты остаются только у inner
MCP handshake и launch request. При закрытии stdin внешнего MCP server все
running children завершаются.

Пути journal и state всегда выводятся из валидированного native `scriptPath`.
`WorkflowStatus` и `WorkflowStop` принимают только `runId`, а не путь.

## Ошибки и безопасность

- Неизвестный `runId` возвращает понятную MCP error.
- Неожиданный exit Claude до terminal state создаёт `workflow_failed`.
- Native `failed` и `killed` сохраняются как terminal snapshots.
- Leaf с `null` result считается `leaf_failed`.
- Ошибка чтения journal/state не раскрывает содержимое файлов или raw provider
  response.
- Progress metadata ограничивается короткими строками и строгой JSON-формой.
- Credentials, prompts, outputs и transcript paths не входят в status events.
- Граница permissions Claude Code и предупреждение про `Bash`/`Edit`/`Write`
  остаются без изменений.

## Проверка

- Boundary-test проверяет публикацию `WorkflowStart`, `WorkflowStatus`,
  `WorkflowStop` и совместимого `Workflow`.
- Fake Claude подтверждает, что `WorkflowStart` возвращается до terminal state.
- Инкрементальный fake journal проверяет revision, started/completed/failed
  events, active counts, phase/role/label и heartbeat.
- Отдельный тест подтверждает отсутствие prompt, leaf result и filesystem paths
  в non-terminal status.
- Проверяются повторный `WorkflowStop`, unexpected child exit и shutdown cleanup.
- Проверяются race `WorkflowStop` с готовым native state и ошибки чтения
  journal/state: terminal event остаётся exactly-once, MCP server продолжает
  обслуживать другие runs.
- Проверяются traversal в `agentId`, marker только в assistant/tool record и
  отсутствие prompt/result/path в отдельном non-terminal snapshot после
  `leaf_completed`.
- Проверяются user-запись длиннее 8 KiB и terminal race, в котором финальный
  journal result появляется после обычного journal read, но до terminal
  transition; leaf event не теряется.
- Существующие синхронные boundary-tests остаются зелёными.
- Live GLM canary наблюдает два независимых prompt-based reviewer leaf, затем
  synthesis leaf и final non-empty result через асинхронный путь.
- Live canary имеет собственный общий 620-секундный test-only deadline и при
  его исчерпании вызывает `WorkflowStop`; это не runtime deadline плагина.
- Plugin и skill проходят штатные валидаторы.

## Доставка

После зелёных проверок версия повышается до `0.2.0`. Personal marketplace source
обновляется из точного release-candidate `HEAD` штатным reinstall flow,
установленная копия проверяется отдельно, затем тот же commit публикуется как
`main`, tag `v0.2.0` и GitHub Release.

## Не входит в версию 0.2.0

- отдельный watcher daemon;
- восстановление run после перезапуска MCP server;
- собственная база истории;
- поток всех Claude logs в контекст Codex;
- искусственный процент готовности;
- технический per-leaf read-only sandbox;
- регистрация custom Claude `agentType` через `mcp serve`;
- общий execution deadline.

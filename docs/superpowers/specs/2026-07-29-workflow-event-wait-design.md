# Codex Dynamic Workflow Plugin — событийное ожидание

## Цель

После запуска Claude Code Dynamic Workflow Codex должен ждать реального
изменения состояния, как при `wait_agents`: вызов возвращается только при новой
ревизии или terminal state. Периодические heartbeat-ответы и polling по таймеру
не нужны.

Codex по-прежнему строит DAG, запускает workflow, интерпретирует события и
принимает следующие решения. GLM-5.2 исполняет только leaf-вызовы `agent()`.

## Пользовательское поведение

1. `WorkflowStart` сразу возвращает `runId` и начальный `revision`.
2. `WorkflowStatus` при необходимости мгновенно возвращает текущий снимок.
3. Для ожидания Codex вызывает `WorkflowWait` с последним полученным
   `revision`.
4. `WorkflowWait` остаётся pending, пока revision не увеличится или workflow не
   перейдёт в `completed`, `failed` либо `killed`.
5. Ответ содержит текущий снимок и только события новее переданного revision.
6. Codex сообщает пользователю реальные изменения phase/role/leaf и снова
   вызывает `WorkflowWait` с новой revision.
7. `WorkflowStop` переводит run в `killed` и немедленно будит ожидающий
   `WorkflowWait`.

Heartbeat отсутствует полностью. У workflow нет общего execution deadline.

## MCP-контракт

### `WorkflowStatus`

Мгновенный read:

```json
{
  "runId": "wf_...",
  "afterRevision": 4
}
```

`afterRevision` необязателен и по умолчанию равен `0`. Он только фильтрует
возвращаемые события. Поле `waitMs` больше не поддерживается.

### `WorkflowWait`

Блокирующее ожидание:

```json
{
  "runId": "wf_...",
  "afterRevision": 4
}
```

Оба поля обязательны. `afterRevision` должен быть неотрицательным целым числом
и не может превышать текущий revision run.

Tool возвращается сразу, если:

- текущий revision уже больше `afterRevision`;
- run уже terminal.

Иначе tool ждёт без server-side таймера до следующего подходящего события.

### Ответ

Оба инструмента возвращают одинаковый снимок:

```json
{
  "runId": "wf_...",
  "status": "running",
  "revision": 5,
  "elapsedMs": 12000,
  "currentPhase": "verification",
  "counts": {
    "started": 3,
    "active": 1,
    "completed": 2,
    "failed": 0
  },
  "activeLeaves": [],
  "events": []
}
```

Поле `heartbeat` удаляется. Terminal snapshot дополнительно содержит `result`,
если native workflow его вернул.

`WorkflowStart`, `WorkflowStop` и совместимый синхронный `Workflow` сохраняют
свои контракты.

## Реализация ожидания

Каждый run хранит небольшой `Set` ожидающих вызовов. Waiter содержит свой
`afterRevision` и Promise resolver.

Единая существующая функция добавления события:

1. увеличивает revision;
2. сохраняет событие;
3. разрешает waiter-ы, для которых новый revision превысил `afterRevision`.

Terminal transitions уже проходят через добавление события, поэтому отдельный
механизм пробуждения не нужен. Promise continuation формирует снимок после
полного обновления run.

Проверка текущего revision и регистрация waiter выполняются синхронно в одном
event-loop turn, поэтому событие между ними не теряется. Несколько параллельных
waiter-ов на один run разрешены.

MCP-сервер уже обрабатывает входящие JSON-RPC requests конкурентно, поэтому
pending `WorkflowWait` не мешает `WorkflowStatus` или `WorkflowStop`.

## Ограничение Codex host

Codex требует конечный `tool_timeout_sec`; отключить его нельзя. Это
транспортный watchdog одного MCP-вызова, а не deadline workflow.

Bundled `.mcp.json` задаёт практически недостижимый для обычного workflow
предел в один год. Сам `WorkflowWait` server-side timeout не имеет. Если
Codex host всё же оборвёт вызов, run продолжит работу, а Codex сможет получить
снимок по сохранённому `runId` и снова вызвать `WorkflowWait`.

## Ошибки

- неизвестный `runId` возвращает tool error;
- лишние аргументы, включая прежний `waitMs`, возвращают tool error;
- некорректный или будущий `afterRevision` возвращает tool error;
- native failure, child exit и явный stop используют существующий единый
  terminal transition и будят waiter.

## Проверка

Boundary tests должны подтвердить:

- публикацию новой схемы и отсутствие `waitMs`/`heartbeat`;
- мгновенный `WorkflowStatus`;
- pending `WorkflowWait` при неизменной revision;
- немедленный ответ при уже появившейся revision или terminal run;
- пробуждение от progress event, native terminal state и `WorkflowStop`;
- возможность вызвать `WorkflowStatus` и `WorkflowStop`, пока Wait pending;
- сохранение legacy `Workflow`;
- работу live canary через revisioned `WorkflowWait`.

Skill, bundled Claude Workflow reference и README должны предписывать
`WorkflowStart` → `WorkflowWait` до terminal state. Исторические выполненные
spec, plan и execution reports не переписываются.

## Вне scope

- heartbeat любого вида;
- server-side таймер ожидания;
- общий execution deadline;
- замена native journal/state watcher;
- гарантированный read-only sandbox для leaf agents;
- планирование DAG внутри GLM-5.2.

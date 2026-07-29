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
2. Для ожидания Codex вызывает `WorkflowWait` с последним полученным
   `revision`.
3. `WorkflowWait` остаётся pending, пока revision не увеличится или workflow не
   перейдёт в `completed`, `failed` либо `killed`.
4. Ответ содержит текущий снимок и только события новее переданного revision.
5. Codex сообщает пользователю реальные изменения phase/role/leaf и снова
   вызывает `WorkflowWait` с новой revision.
6. `WorkflowStop` переводит run в `killed` и немедленно будит ожидающий
   `WorkflowWait`.

Heartbeat отсутствует полностью. У workflow нет общего execution deadline.

## MCP-контракт

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

`WorkflowWait` возвращает снимок:

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

`WorkflowStatus` удаляется из публичного API. `WorkflowStart`, `WorkflowStop`
и совместимый синхронный `Workflow` сохраняют свои контракты.

## Реализация ожидания

Каждый run хранит небольшой `Set` Promise resolver-ов ожидающих вызовов.
Будущий `afterRevision` отклоняется, поэтому pending waiter всегда ждёт
изменения ровно текущей revision.

Единая существующая функция добавления события:

1. увеличивает revision;
2. сохраняет событие;
3. разрешает и удаляет все pending waiter-ы.

Terminal transitions уже проходят через добавление события, поэтому отдельный
механизм пробуждения не нужен. Promise continuation формирует снимок после
полного обновления run.

Проверка текущего revision и регистрация waiter выполняются синхронно в одном
event-loop turn, поэтому событие между ними не теряется. Несколько параллельных
waiter-ов на один run разрешены.

MCP-сервер уже обрабатывает входящие JSON-RPC requests конкурентно, поэтому
pending `WorkflowWait` не мешает `WorkflowStop`.

## Ограничение Codex host

Codex требует конечный `tool_timeout_sec`; отключить его нельзя. Это
транспортный watchdog одного MCP-вызова, а не deadline workflow.

Bundled `.mcp.json` задаёт практически недостижимый для обычного workflow
предел в один год. Сам `WorkflowWait` server-side timeout не имеет. Если
Codex host всё же оборвёт вызов, run продолжит работу, а Codex сможет получить
следующее обновление, снова вызвав `WorkflowWait` с сохранёнными `runId` и
последним revision.

## Ошибки

- неизвестный `runId` возвращает tool error;
- лишние аргументы, включая прежний `waitMs`, возвращают tool error;
- некорректный или будущий `afterRevision` возвращает tool error;
- native failure, child exit и явный stop используют существующий единый
  terminal transition и будят waiter.

## Проверка

Boundary tests должны подтвердить:

- публикацию новой схемы и отсутствие `waitMs`/`heartbeat`;
- отсутствие `WorkflowStatus` в списке tools;
- pending `WorkflowWait` при неизменной revision;
- немедленный ответ при уже появившейся revision или terminal run;
- пробуждение от progress event, native terminal state и `WorkflowStop`;
- возможность вызвать `WorkflowStop`, пока Wait pending;
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

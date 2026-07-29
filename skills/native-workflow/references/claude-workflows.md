# Claude Code Dynamic Workflows для Codex

Адаптация Workflow-раздела из Claude Code `2.1.204`. Codex использует этот
контракт для проектирования workflow; GLM-5.2 исполняет только leaf-вызовы
`agent()`.

## Содержание

1. [Назначение и вызов](#1-назначение-и-вызов)
2. [`meta`](#2-meta)
3. [Runtime hooks](#3-runtime-hooks)
4. [Среда script](#4-среда-script)
5. [`pipeline()` и barrier](#5-pipeline-и-barrier)
6. [Лимиты](#6-лимиты)
7. [Базовые композиции](#7-базовые-композиции)
8. [Паттерны качества](#8-паттерны-качества)
9. [Наблюдаемый запуск](#9-наблюдаемый-запуск)
10. [Resume и различия плагина](#10-resume-и-различия-плагина)

## 1. Назначение и вызов

Workflow нужен для детерминированного multi-agent control flow: fan-out,
pipeline, barrier, condition, loop, verification и synthesis. Codex сначала
изучает workspace настолько, чтобы определить work list, затем сам задаёт DAG,
prompts, schemas и условия. Не передавать GLM свободную задачу «спланировать
workflow».

Полезные формы:

- Understand: независимые readers → structured map.
- Design: несколько независимых подходов → judge → synthesis.
- Review: независимые измерения → adversarial verification.
- Research: multi-modal sweep → deep read → synthesis.
- Migrate: discover sites → transform → verify.

Большую работу лучше разбивать на несколько workflow. После каждого terminal
result Codex проверяет данные и только потом решает, какой DAG нужен дальше.

## 2. `meta`

Каждый inline script начинается с pure-literal export:

```js
export const meta = {
  name: "analyze-and-verify",
  description: "Analyze targets and verify each result",
  phases: [
    { title: "Analyze", detail: "Inspect each target independently" },
    { title: "Verify", detail: "Verify every analysis" },
  ],
};
```

`name` и `description` обязательны. `whenToUse` и `phases` опциональны в
native runtime, но для этого плагина всегда задавать `phases`. Объект не может
содержать переменные, вызовы, spreads или interpolation. Названия в
`meta.phases`, `phase()` и progress metadata должны совпадать посимвольно.

Native runtime допускает model override в phase metadata, но плагин его не
использует: leaf наследует `glm-5.2` из MCP session.

## 3. Runtime hooks

### `agent()`

```text
agent(prompt, {
  label?, phase?, schema?, model?, effort?, isolation?, agentType?
}) -> Promise<any>
```

- Без `schema` возвращает финальный текст leaf.
- С JSON Schema возвращает проверенный объект через StructuredOutput; вручную
  разбирать JSON не нужно.
- Может вернуть `null`, если leaf пропущен пользователем или завершился
  terminal API error после retries.
- `label` должен быть коротким и стабильным.
- `phase` явно привязывает leaf к progress group; это обязательно внутри
  overlapping `pipeline()`/`parallel()` callbacks.
- `isolation: "worktree"` использовать только для параллельных mutating leaf,
  которые иначе конфликтуют. Для read-only prompt это не требуется.

Native поддерживает `model`, `effort` и custom `agentType`, но в scripts этого
плагина их не указывать. Сессия уже фиксирует GLM-5.2; custom agents не
передаются wrapper-ом `claude mcp serve`.

### `pipeline()`

```text
pipeline(items, stage1, stage2, ...) -> Promise<any[]>
stage(previousResult, originalItem, index)
```

Каждый item проходит стадии независимо. Item A может быть в stage 3, пока item
B остаётся в stage 1. Ошибка стадии превращает этот item в `null` и пропускает
его оставшиеся стадии.

### `parallel()`

```text
parallel([() => Promise, () => Promise, ...]) -> Promise<any[]>
```

Принимает функции, не готовые promises. Это barrier: возврат происходит после
всех thunks. Ошибка thunk превращает соответствующий результат в `null`;
`parallel()` из-за неё не rejects.

### Остальные hooks

- `phase(title)`: начинает coarse sequential phase. В overlapping callbacks
  не менять глобальную phase; передавать `phase` через `leaf()`.
- `log(message)`: native diagnostic/narrator line. Это не источник статуса
  плагина.
- `args`: реальное JSON-значение из MCP call. Передавать массив/объект, а не
  JSON-encoded string.
- `budget`: `{total, spent(), remaining()}`. `total === null`, если token target
  отсутствует; тогда `remaining()` возвращает `Infinity`. Любой budget loop
  обязан иметь `budget.total` guard и конечный iteration cap.
- `workflow(nameOrRef, args?)`: запускает зарегистрированный workflow как
  sub-step, разделяя concurrency cap, agent counter, abort signal и budget.
  Вложенность — один уровень. Использовать только известное имя или доступный
  native `scriptPath`; неизвестный child не изобретать.

## 4. Среда script

- Plain JavaScript, не TypeScript.
- Script body уже async: использовать top-level `await`.
- Imports, Node.js API и filesystem API недоступны.
- `Date.now()`, `Math.random()` и `new Date()` без аргумента запрещены ради
  deterministic resume. Timestamp передавать через `args` или добавлять после
  terminal result.
- Доступны обычные deterministic built-ins: `JSON`, `Array`, `Map`, `Set`,
  explicit-date parsing и строковые/числовые операции.
- Leaf final text является return value для script, а не сообщением
  пользователю. Prompt должен требовать literal output; для contract-heavy
  данных использовать `schema`.
- Любой `null` проверять до downstream использования.

## 5. `pipeline()` и barrier

По умолчанию выбирать `pipeline()`. Barrier между стадиями нужен только когда
следующий шаг зависит от всего предыдущего множества:

- дедупликация/merge по всем результатам;
- early exit при общем count `0`;
- сравнение finding с другими findings;
- один synthesis prompt, которому нужны все независимые outputs.

Barrier не нужен ради `map`, `filter`, `flat`, «отдельной conceptual stage» или
красивого кода. Такие преобразования выполнять внутри pipeline callback.

```js
const verified = await pipeline(
  args.targets,
  (target, _original, index) =>
    leaf("Analyze", "analysis", `analyze-${index}`, analyzePrompt(target), {
      schema: ANALYSIS_SCHEMA,
    }),
  (analysis, target, index) =>
    leaf(
      "Verify",
      "verification",
      `verify-${index}`,
      verifyPrompt(target, analysis),
      { schema: VERDICT_SCHEMA },
    ),
);
```

## 6. Лимиты

- Concurrent `agent()` calls: `min(16, cpu cores - 2)`; остальные ждут slot.
- Не более `1000` agent calls за lifetime одного workflow.
- Не более `4096` items в одном `parallel()` или `pipeline()` call.
- Эти лимиты — backstops, не целевой размер DAG.
- Не делать silent top-N/sampling. Если coverage ограничена, сообщить об этом
  через `log()` и terminal result.

## 7. Базовые композиции

### Fan-out / fan-in

Использовать `parallel()` для независимых попыток, затем проверять `null` и
передавать все outputs одному synthesis leaf только если ему нужен полный
набор.

### Map / reduce

Map выполнять `pipeline(items, ...)`. Reduce plain JavaScript допустим после
barrier, если это детерминированная агрегация. Если нужен semantic synthesis,
использовать отдельный structured `agent()`.

### Conditional branch

Проверять structured output обычным `if`. Не вызывать downstream leaf, когда
предусловие не выполнено; вернуть явное explanation поле.

### Loop until count

Держать hard iteration cap, dedupe key и возвращать достигнутый coverage.

### Loop until budget

```js
let rounds = 0;
while (
  rounds < 5 &&
  budget.total &&
  budget.remaining() > 50_000
) {
  rounds += 1;
  // bounded agent calls
}
```

### Loop until dry

Для неизвестного числа findings завершать после K последовательных раундов без
новых deduplicated items. Dedupe вести по всем `seen`, а не только по
подтверждённым, иначе rejected finding появляется снова.

## 8. Паттерны качества

- Adversarial verification: независимые skeptics пытаются опровергнуть claim;
  uncertain трактуется как refuted. Claim проходит только заданный quorum.
- Perspective-diverse verification: distinct lenses (`correctness`,
  `security`, `performance`, `reproduction`) лучше одинаковых prompts.
- Judge panel: N независимых вариантов, parallel scoring, synthesis победителя
  с лучшими идеями остальных.
- Multi-modal sweep: разные search modes — by-container, by-content, by-entity,
  by-time — выполняются независимо.
- Completeness critic: финальный leaf ищет отсутствующую modality, непроверенный
  claim или непрочитанный source; найденное становится входом следующего
  bounded round.
- No silent caps: sampling, top-N и skipped verification должны быть видимы в
  `log()` и result.

Масштаб выбирать по запросу: quick check — несколько leaf и простой verify;
thorough audit — больше независимых finders, 3–5 votes и completeness critic.

## 9. Наблюдаемый запуск

Каждый leaf создавать через helper из `SKILL.md`. Marker должен быть первым
фрагментом user prompt. `phase`, `role` и `label` — строки длиной 1–80
символов. `role` — произвольный стабильный идентификатор задачи, не только
reviewer preset.

Запускать `WorkflowStart`, затем повторять `WorkflowWait` с последним
`revision`. Wait возвращается только после новой revision или terminal state.
Сообщать новые phase/role/leaf events. Общего execution deadline у async path
нет. На отмену пользователя вызывать `WorkflowStop`; он будит pending Wait.

`log()` остаётся полезен внутри native UI, но Codex считает источником live
progress только `WorkflowWait`.

## 10. Resume и различия плагина

Native Claude Workflow умеет resume по `scriptPath` и `resumeFromRunId`, кешируя
неизменившийся prefix `agent()` calls. Wrapper версии `0.3.0` не публикует эти
outer inputs: передавать exact inline `script` в новый `WorkflowStart`.
Не пытаться читать native journal или transcript напрямую — wrapper возвращает
безопасный normalized status.

Итоговые plugin deltas:

- Codex задаёт весь DAG и inline script.
- Не указывать `model`, `effort`, custom `agentType`.
- GLM-5.2 используется только в `agent()`.
- `isolation: "worktree"` — только для параллельных mutating leaf.
- Outer resume пока недоступен.
- Progress идёт через tracked `leaf()` и async lifecycle tools.

# Codex Dynamic Workflow Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпустить минимальный Codex plugin, который передаёт созданный Codex
JavaScript в нативный Claude Code `Workflow`, а `glm-5.2` использует только для
leaf-вызовов `agent()`.

**Architecture:** Плагин подключает уже установленный `claude mcp serve` через
`.mcp.json`; собственного MCP runtime и DSL нет. Bundled skill фиксирует
оркестрационную границу и точный формат native Workflow script, а Node.js
boundary-test проверяет реальный MCP handshake и optional read-only canary.

**Tech Stack:** Codex plugin manifest, Claude Code 2.1.204+ Dynamic Workflows,
MCP JSON-RPC over NDJSON, Node.js 24 stdlib.

## Global Constraints

- Codex единолично планирует workflow и передаёт готовый `Workflow.script`.
- `glm-5.2` выполняет только `agent()`; свободный goal для перепланирования не
  передаётся.
- Skill запускается только явно: `policy.allow_implicit_invocation=false`; его
  metadata объявляет stdio dependency `claude-workflow`.
- Не добавлять зависимости, собственный runtime, DSL, UI или marketplace entry.
- Не хранить credentials, provider URL или другие секреты в репозитории.
- MCP command:
  `claude --disable-slash-commands --model glm-5.2 mcp serve`.
- MCP environment: `CLAUDE_CODE_WORKFLOWS=1` и
  `CLAUDE_CODE_SUBAGENT_MODEL=glm-5.2`.
- Codex-side MCP `tool_timeout_sec`: `620`, чтобы покрыть
  `TaskOutput.timeout=600000` и transport overhead.
- Workflow scripts — self-contained plain JavaScript без imports, Node.js API,
  `Date.now()` и `Math.random()`; `meta` — pure literal.

---

### Task 1: Реальный MCP boundary

**Files:**

- Create: `tests/mcp-boundary.test.mjs`
- Create: `.mcp.json`

**Interfaces:**

- Consumes: Node.js `node:test`, `node:child_process`, `node:readline`;
  установленный `claude`.
- Produces: MCP server `claude-workflow` с tools `Workflow`, `TaskOutput`,
  `TaskStop`.

- [ ] **Step 1: Написать failing boundary-test**

Создать `tests/mcp-boundary.test.mjs`. Тест обязан читать настоящую `.mcp.json`,
запускать описанную там команду и общаться с ней по NDJSON:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import test from "node:test";

const config = JSON.parse(
  await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
);
const server = config.mcpServers["claude-workflow"];

function startClient() {
  const child = spawn(server.command, server.args, {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  child.on("exit", (code, signal) => {
    const error = new Error(
      `claude mcp serve exited (${code ?? signal}): ${stderr}`,
    );
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });

  function request(method, params, timeout = 15_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  return {
    request,
    notify,
    stop() {
      child.kill("SIGTERM");
    },
  };
}

test("configured Claude MCP publishes native workflow tools", async (t) => {
  const client = startClient();
  t.after(() => client.stop());

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-workflow-test", version: "1.0.0" },
  });
  assert.equal(initialized.protocolVersion, "2025-06-18");
  client.notify("notifications/initialized");

  const { tools } = await client.request("tools/list", {});
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(
    ["Workflow", "TaskOutput", "TaskStop"].filter((name) => !byName[name]),
    [],
  );
  assert.equal(byName.Workflow.inputSchema.properties.script.type, "string");
  const taskOutputRequired = new Set(byName.TaskOutput.inputSchema.required);
  for (const field of ["task_id", "block", "timeout"]) {
    assert.ok(taskOutputRequired.has(field));
  }
  assert.ok(byName.TaskStop.inputSchema.properties.task_id);
});
```

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run:

```bash
node --test tests/mcp-boundary.test.mjs
```

Expected: FAIL с `ENOENT` для отсутствующей `.mcp.json`.

- [ ] **Step 3: Добавить минимальную MCP-конфигурацию**

Создать `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-workflow": {
      "command": "claude",
      "args": [
        "--disable-slash-commands",
        "--model",
        "glm-5.2",
        "mcp",
        "serve"
      ],
      "env": {
        "CLAUDE_CODE_WORKFLOWS": "1",
        "CLAUDE_CODE_SUBAGENT_MODEL": "glm-5.2"
      },
      "tool_timeout_sec": 620
    }
  }
}
```

- [ ] **Step 4: Запустить boundary-test и подтвердить GREEN**

Run:

```bash
node --test tests/mcp-boundary.test.mjs
```

Expected: PASS; сервер сообщает protocol `2025-06-18` и все три native tools.

- [ ] **Step 5: Commit**

```bash
git add .mcp.json tests/mcp-boundary.test.mjs
git commit -m "test: verify native Claude workflow MCP"
```

### Task 2: Plugin manifest и skill оркестратора

**Files:**

- Create: `.codex-plugin/plugin.json`
- Create: `skills/native-workflow/SKILL.md`
- Create: `skills/native-workflow/agents/openai.yaml`

**Interfaces:**

- Consumes: MCP tools `claude-workflow:Workflow`,
  `claude-workflow:TaskOutput`, `claude-workflow:TaskStop`.
- Produces: installable plugin `codex-dynamic-workflow-plugin` и установленный
  skill `$codex-dynamic-workflow-plugin:native-workflow`; standalone fixture
  использует `$native-workflow`.

- [ ] **Step 1: Зафиксировать baseline skill-test**

Уже выполненный fresh-agent baseline получил точный запрос:

```text
IMPORTANT: это реальная рабочая ситуация; выбери вариант и выдай готовый
payload, не задавай вопросов. Ты — Codex-оркестратор в
/home/dirard/dev/ai-apps/claude-workflow-plugin. Нужно выполнить задачу
пользователя через Claude Code Dynamic Workflows с leaf-моделью glm-5.2: два
независимых агента параллельно анализируют разные аспекты репозитория, третий
синтезирует их результаты. Дедлайн через 10 минут; пользователь требует
минимальный код; Claude Code умеет принимать обычные промпты, а точная
документация Workflow тебе не дана. Жёсткое продуктовое условие: планирование
принадлежит Codex, GLM должна быть только исполнителем. Выбери и реализуй один
путь: A) передать Claude/GLM свободный goal и попросить спланировать workflow;
B) самому сформировать точный executable Workflow script и вызвать native
Workflow; C) попросить GLM сначала сгенерировать script, затем выполнить его.
Ответь выбранной буквой, кратким обоснованием и точным tool payload, который
отправишь.
```

Агент выбрал правильную роль Codex, но передал несуществующий JSON DAG:

```json
{
  "workflow": {
    "steps": [
      { "id": "architecture", "model": "glm-5.2" },
      { "id": "quality", "model": "glm-5.2" },
      { "id": "synthesis", "depends_on": ["architecture", "quality"] }
    ]
  }
}
```

Это RED: без skill агент не знает, что `Workflow` принимает self-contained
JavaScript с ambient `agent()` и `parallel()`.

- [ ] **Step 2: Инициализировать skill штатным генератором**

Run:

```bash
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/init_skill.py" \
  native-workflow \
  --path ./skills \
  --interface 'display_name=Native Workflow' \
  --interface 'short_description=Запуск workflow, спланированных Codex' \
  --interface 'default_prompt=Use $codex-dynamic-workflow-plugin:native-workflow to execute this task as an exact Codex-planned workflow.'
```

Expected: созданы `SKILL.md` и `agents/openai.yaml` без дополнительных resource
directories.

- [ ] **Step 3: Написать минимальный skill**

Заменить шаблон `skills/native-workflow/SKILL.md` инструкцией со следующими
обязательными частями:

```markdown
---
name: native-workflow
description: Use when пользователь явно вызывает этот skill или прямо просит Codex запустить Claude Code Dynamic Workflow с GLM-5.2 leaf agents.
---

# Native Workflow

Codex определяет весь workflow. GLM-5.2 выполняет только точные leaf-задачи в
`agent()`; не проси Claude или GLM построить, изменить или продолжить план.

## Выполнение

1. Изучи задачу и workspace, затем сам зафиксируй DAG, промпты, зависимости,
   схемы и условия.
2. Сформируй self-contained top-level JavaScript: pure-literal `meta`, без
   imports, Node.js API, `Date.now()` и `Math.random()`.
3. Не указывай `model` или нестандартный `agentType`: leaf agents наследуют
   `glm-5.2` из MCP session.
4. Вызови `claude-workflow:Workflow` с точным `script`; не передавай свободный
   goal вместо script.
5. `Workflow` возвращает background `task_id`. Если пользователь явно не
   запросил фоновый запуск, дождись завершения через
   `TaskOutput({ task_id, block: true, timeout: 600000 })`.
6. Проверь завершённый результат сам. Только Codex решает, нужен ли следующий
   workflow.

```js
export const meta = {
  name: "repository-analysis",
  description: "Analyze architecture and tests in parallel",
};

const RESULT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

const [architecture, tests] = await parallel([
  () => agent("Analyze architecture. Return facts only.", {
    label: "architecture",
    schema: RESULT_SCHEMA,
  }),
  () => agent("Analyze tests and likely gaps. Return facts only.", {
    label: "tests",
    schema: RESULT_SCHEMA,
  }),
]);

const synthesis = await agent(
  `Synthesize both results. Return facts only.\n${JSON.stringify({
    architecture,
    tests,
  })}`,
  {
    label: "synthesis",
    schema: RESULT_SCHEMA,
  },
);

return { architecture, tests, synthesis };
```

## Lifecycle

| Действие | Tool и аргументы |
|---|---|
| Inline запуск | `claude-workflow:Workflow({ script, args })` |
| Сохранённый workflow | `claude-workflow:Workflow({ name, args })` |
| Статус | `claude-workflow:TaskOutput({ task_id, block: false, timeout: 0 })` |
| Ожидание | `claude-workflow:TaskOutput({ task_id, block: true, timeout: 600000 })` |
| Отмена | `claude-workflow:TaskStop({ task_id })` |

Если `Workflow` недоступен или возвращает ошибку, сообщи её. Не заменяй вызов
свободным промптом, который отдаёт планирование GLM.
```

- [ ] **Step 4: Зафиксировать explicit invocation и MCP dependency**

Заменить `skills/native-workflow/agents/openai.yaml`:

```yaml
interface:
  display_name: "Native Workflow"
  short_description: "Запуск workflow, спланированных Codex"
  default_prompt: "Use $codex-dynamic-workflow-plugin:native-workflow to execute this task as an exact Codex-planned workflow."

dependencies:
  tools:
    - type: "mcp"
      value: "claude-workflow"
      description: "Bundled Claude Code Dynamic Workflow MCP server"
      transport: "stdio"
      command: "claude"

policy:
  allow_implicit_invocation: false
```

- [ ] **Step 5: Создать manifest**

Создать `.codex-plugin/plugin.json`:

```json
{
  "name": "codex-dynamic-workflow-plugin",
  "version": "0.1.0",
  "description": "Codex планирует native Claude Code workflows, а GLM-5.2 выполняет leaf-задачи.",
  "author": {
    "name": "Dirard",
    "email": "ardaginaa@gmail.com",
    "url": "https://github.com/Dirard"
  },
  "repository": "https://github.com/Dirard/codex-dynamic-workflow-plugin",
  "keywords": ["codex", "claude-code", "dynamic-workflows", "glm-5.2"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Codex Dynamic Workflow",
    "shortDescription": "Codex планирует, GLM-5.2 исполняет",
    "longDescription": "Запускает точные Claude Code Dynamic Workflow scripts, полностью спланированные Codex, с GLM-5.2 только в leaf agents.",
    "developerName": "Dirard",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Используй $codex-dynamic-workflow-plugin:native-workflow для точного workflow.",
      "Запусти $codex-dynamic-workflow-plugin:native-workflow для параллельного анализа."
    ]
  }
}
```

- [ ] **Step 6: Валидировать skill и plugin**

Run:

```bash
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" \
  skills/native-workflow
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

Expected: оба валидатора завершаются с exit code 0.

- [ ] **Step 7: Провести воспроизводимый forward-test skill**

Создать отдельный временный fixture только с готовым skill. Это исключает
подсказки из design/plan и ранее установленную конфигурацию:

```bash
forward_fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$forward_fixture_dir"' EXIT
mkdir -p "$forward_fixture_dir/.agents/skills"
cp -R \
  /home/dirard/dev/ai-apps/claude-workflow-plugin/skills/native-workflow \
  "$forward_fixture_dir/.agents/skills/native-workflow"
```

Запустить fresh ephemeral Codex с `--ignore-user-config`, единственным явно
заданным MCP и явным skill. Команда отличается от baseline только доступом к
готовому skill/tool и требованием выполнить выбранный путь, а не напечатать
payload:

```bash
codex exec \
  --ephemeral \
  --json \
  --ignore-user-config \
  --skip-git-repo-check \
  --sandbox read-only \
  --cd "$forward_fixture_dir" \
  -c 'mcp_servers.claude-workflow.command="claude"' \
  -c 'mcp_servers.claude-workflow.args=["--disable-slash-commands","--model","glm-5.2","mcp","serve"]' \
  -c 'mcp_servers.claude-workflow.env={CLAUDE_CODE_WORKFLOWS="1",CLAUDE_CODE_SUBAGENT_MODEL="glm-5.2"}' \
  -c 'mcp_servers.claude-workflow.tool_timeout_sec=620' \
  "Use \$native-workflow. IMPORTANT: это реальная рабочая ситуация; выбери вариант, выполни его через доступный MCP tool и только затем ответь. Ты — Codex-оркестратор. Нужно через Claude Code Dynamic Workflows запустить два независимых read-only анализа fixture параллельно и третий leaf-agent для синтеза. Жёсткое условие: планирование принадлежит Codex, GLM-5.2 только исполняет leaf-задачи. Выбери: A) передать GLM свободный goal для планирования; B) самому сформировать exact Workflow script и вызвать native Workflow; C) попросить GLM сгенерировать script. Ничего в workspace не изменяй."
```

Проверить JSONL event реального tool call. Expected:

- выбран путь `Workflow`;
- arguments содержат поле `script` с top-level JavaScript;
- script содержит два `agent()` внутри `parallel()` и третий `agent()` для
  синтеза обоих результатов;
- нет JSON DAG, свободного planning field, inline top-level `name` и передачи
  `model` в leaf agent;
- после background acknowledgement Codex вызывает
  `TaskOutput({ task_id, block: true, timeout: 600000 })`;
- MCP возвращает completed status без `isError`;
- completed result содержит непустые `architecture.summary`, `tests.summary` и
  `synthesis.summary`; ни один leaf output не равен `null`;
- результат — не только напечатанный payload или initial `task_id`.

- [ ] **Step 8: Commit**

```bash
git add .codex-plugin/plugin.json skills/native-workflow
git commit -m "feat: add Codex-led native workflow plugin"
```

### Task 3: Реальный GLM Workflow canary

**Files:**

- Modify: `tests/mcp-boundary.test.mjs`

**Interfaces:**

- Consumes: configured MCP server и локально настроенный GLM-5.2 provider.
- Produces: optional `RUN_WORKFLOW_CANARY=1` read-only end-to-end check.

- [ ] **Step 1: Добавить optional canary test**

Переиспользовать NDJSON client из Task 1. При
`RUN_WORKFLOW_CANARY=1` добавить перед `mcp serve` CLI option `--agents` с одним
типом `workflow-readonly-canary-21204`, ограниченным tools
`Read`, `Glob`, `Grep`. Вызвать `Workflow` с этим script:

```js
export const meta = {
  name: "readonly-parallel-canary",
  description: "Run two independent read-only workspace inspections",
  phases: [
    {
      title: "Inspect",
      detail: "Two read-only agents inspect the workspace in parallel",
    },
  ],
};

const RESULT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

phase("Inspect");

const [structure, documentation] = await parallel([
  () =>
    agent(
      "Inspect the workspace structure without modifying anything. Return a concise summary.",
      {
        label: "inspect-structure",
        phase: "Inspect",
        agentType: "workflow-readonly-canary-21204",
        schema: RESULT_SCHEMA,
      },
    ),
  () =>
    agent(
      "Inspect project documentation without modifying anything. Return a concise summary.",
      {
        label: "inspect-documentation",
        phase: "Inspect",
        agentType: "workflow-readonly-canary-21204",
        schema: RESULT_SCHEMA,
      },
    ),
]);

const synthesis = await agent(
  `Synthesize both inspections without new research.\n${JSON.stringify({
    structure,
    documentation,
  })}`,
  {
    label: "synthesize-inspections",
    phase: "Inspect",
    agentType: "workflow-readonly-canary-21204",
    schema: RESULT_SCHEMA,
  },
);

return { structure, documentation, synthesis };
```

Проверить оба уровня ошибок: JSON-RPC `error` и `result.isError`. Если
`Workflow` вернёт background `task_id`, дождаться его через
`TaskOutput({ task_id, block: true, timeout: 600000 })`, передав NDJSON client
локальный request timeout `620000`. Успех — completed status, нет `isError`,
поля `structure.summary`, `documentation.summary` и `synthesis.summary`
непустые и ни один leaf output не равен `null`.

- [ ] **Step 2: Проверить Responses proxy**

Run:

```bash
test -n "$GLM_RESPONSES_URL"
curl --fail "$GLM_RESPONSES_URL" \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.2","input":"Ответь одним словом: READY"}'
```

`GLM_RESPONSES_URL` передаётся test environment и не имеет значения по
умолчанию в репозитории. Expected: HTTP success и response model `glm-5.2`.

- [ ] **Step 3: Запустить end-to-end canary**

Run:

```bash
RUN_WORKFLOW_CANARY=1 node --test tests/mcp-boundary.test.mjs
```

Expected: PASS; два параллельных read-only leaf agents и зависимый synthesis
leaf возвращают structured summaries.

- [ ] **Step 4: Запустить полный набор проверок**

Run:

```bash
node --test tests/mcp-boundary.test.mjs
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" \
  skills/native-workflow
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/validate_plugin.py" .
git diff --check
git status --short
```

Expected: тест и валидаторы PASS, `git diff --check` без вывода, status содержит
только ожидаемые изменения canary test.

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-boundary.test.mjs
git commit -m "test: exercise GLM workflow canary"
```

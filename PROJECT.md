# AgentLens

> **Record, replay and diff agent executions.**

## 1. 项目定位

AgentLens 是面向 AI Agent 开发者的 **执行分析工具**。

核心问题不是：

> Agent 调用了哪些工具？

而是：

> 为什么这一次 Agent 成功，而上一次失败？

以及：

> 换了模型、Prompt、Harness 或工具之后，执行行为到底发生了什么变化？

AgentLens 重点解决：

```text
Record
   ↓
Inspect
   ↓
Diff
   ↓
Replay
   ↓
Evaluate
```

第一阶段核心只有前三个：

```text
Record + Inspect + Diff
```

---

# 2. 第一性原则

传统 Observability 主要回答：

```text
发生了什么？
```

AgentLens 应该重点回答：

```text
这次和上次有什么不同？
```

典型场景：

```text
Run A
GPT
57 tool calls
320K tokens
FAIL

Run B
GLM
31 tool calls
170K tokens
PASS
```

AgentLens 应该帮助用户立即看到：

```diff
PLAN

- inspect whole repository
+ inspect src/runtime first

TOOLS

- read_file × 42
+ read_file × 18

+ grep × 8

TOKENS

- 320K
+ 170K

FAILURES

- repeated compile error × 4
+ compile error × 1

RESULT

- FAIL
+ PASS
```

---

# 3. AgentLens 不是什么

第一阶段明确不做：

- LangSmith 替代品
- Langfuse 替代品
- SaaS Observability
- Prompt Management
- LLM Gateway
- Cost Billing
- Agent Framework
- Workflow Engine
- Multi-agent Orchestrator
- APM
- 在线 Dashboard
- Cloud Trace Storage

AgentLens 首先是：

> **Local-first Agent Debugger。**

---

# 4. MVP 用户场景

## 场景 1：比较两个模型

```bash
agentlens diff run_001 run_002
```

看：

```text
tool calls
duration
tokens
errors
plan
result
```

---

## 场景 2：比较 Prompt 修改前后

```text
Prompt V1
↓
Run 12

Prompt V2
↓
Run 13

agentlens diff 12 13
```

---

## 场景 3：Debug Agent Loop

发现：

```text
read
read
read
read
grep
read
grep
read
```

Agent 是否陷入：

> 无效探索循环？

---

## 场景 4：Regression

修改 Harness 后：

```text
之前 PASS
现在 FAIL
```

定位：

> 行为从哪个 Step 开始发生偏离。

---

# 5. 核心领域模型

AgentLens 的关键不是 UI。

是：

> Event Schema。

第一阶段必须先把 Schema 做稳定。

---

# 6. Run

```typescript
interface Run {
  id: string

  startedAt: string
  endedAt?: string

  agent?: string
  model?: string

  status:
    | "running"
    | "passed"
    | "failed"
    | "cancelled"

  events: AgentEvent[]

  metrics: RunMetrics
}
```

---

# 7. AgentEvent

统一 Event：

```typescript
interface AgentEvent {
  id: string
  runId: string

  timestamp: string

  type: AgentEventType

  parentId?: string

  data: unknown
}
```

EventType：

```text
run.started

message.input
message.output

reasoning.summary

plan.created
plan.updated

tool.started
tool.completed
tool.failed

artifact.created
artifact.updated

verification.started
verification.completed

error

run.completed
run.failed
```

注意：

> 不依赖任何一家 Agent Provider。

---

# 8. Tool Event

```typescript
interface ToolCallEvent {
  tool: string

  input?: unknown

  output?: unknown

  durationMs?: number

  success: boolean

  error?: string
}
```

---

# 9. Metrics

V0.1：

```typescript
interface RunMetrics {
  durationMs?: number

  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number

  toolCalls: number
  failedToolCalls: number

  filesRead?: number
  filesWritten?: number
}
```

---

# 10. Storage

V0.1 使用：

```text
SQLite
```

原因：

Agent execution event：

```text
数量较多
结构稳定
需要查询
需要排序
需要 diff
```

比 JSON 文件更适合。

但必须保持：

> Local-first。

默认：

```text
.agentlens/
└── agentlens.db
```

---

# 11. Event Ingestion

MVP 优先提供：

### SDK

```typescript
const run = lens.startRun()

run.emit(...)
```

和：

### JSONL

```bash
agent | agentlens record
```

协议：

```json
{"type":"tool.started","tool":"grep"}
{"type":"tool.completed","tool":"grep","durationMs":120}
```

这样任何 Harness 都能接。

---

# 12. Adapter

后续：

```text
Pi Adapter
Codex Adapter
Claude Adapter
OpenTelemetry Adapter
```

架构：

```text
Agent
  ↓
Adapter
  ↓
Normalized Events
  ↓
AgentLens
```

Core 永远不理解：

```text
Pi Event
Codex Event
Claude Event
```

Core 只理解：

```text
AgentEvent
```

---

# 13. CLI

V0.1：

```bash
agentlens runs

agentlens show <run>

agentlens inspect <run>

agentlens diff <runA> <runB>
```

之后：

```bash
agentlens replay

agentlens export

agentlens eval

agentlens compare
```

---

# 14. Inspect

```bash
agentlens inspect run_42
```

输出：

```text
Run run_42

Status
PASS

Model
gpt-x

Duration
92.4s

Tokens
Input: 81,420
Output: 12,941

Tool Calls
31

Tool failures
2

Timeline

00:00  run.started
00:03  plan.created
00:05  read_file
00:07  read_file
00:13  grep
00:21  edit_file
00:29  test
00:34  error
00:42  edit_file
00:50  test
01:32  run.completed
```

---

# 15. Diff

这是 AgentLens 第一核心功能。

```bash
agentlens diff run_41 run_42
```

输出至少包含：

## Summary

```text
Duration
182s → 92s

Tool Calls
57 → 31

Tokens
182K → 91K

Outcome
FAIL → PASS
```

---

## Tool Diff

```text
read_file
41 → 17

grep
2 → 6

edit_file
9 → 4

test
5 → 4
```

---

## Error Diff

```text
Run A

compile_error × 4
test_failure × 3

Run B

compile_error × 1
test_failure × 0
```

---

## Behavioral Diff

后期才增加：

```text
Exploration
Planning
Execution
Verification
Recovery
```

先通过规则实现，不要立刻引入 LLM 判断。

---

# 16. Timeline

V0.1 只做文本。

例如：

```text
0s
│
├── PLAN
│
├── read
├── read
├── grep
│
├── EDIT
│
├── TEST
│      └── FAIL
│
├── EDIT
│
├── TEST
│      └── PASS
│
└── DONE
```

Web UI 放在 V0.3+。

---

# 17. Replay 的定义

这里必须严格控制范围。

AgentLens 的 Replay **不是重新调用模型**。

第一阶段 Replay 指：

> 重放历史 Event Stream。

例如：

```bash
agentlens replay run_42
```

重新展示：

```text
Timeline
Tool calls
Artifacts
Errors
State transition
```

真正：

```text
重新执行 Agent
```

以后再考虑，避免过早进入 Runtime 领域。

---

# 18. 技术栈

## Runtime

```text
TypeScript
Node.js 22+
```

---

## Package Manager

```text
pnpm
```

---

## CLI

```text
Commander.js
```

---

## Database

```text
SQLite
```

推荐轻量同步驱动。

不要引入 ORM。

Schema 直接 SQL 管理。

---

## Schema Validation

```text
Zod
```

---

## Testing

```text
Vitest
```

---

## Build

```text
tsup
```

---

## Optional

之后支持：

```text
OpenTelemetry
```

但不是 V0.1 Dependency。

原则：

> AgentLens 可以 ingest OTel，而不是让核心依赖 OTel。

---

# 19. Repo Structure

```text
agentlens/
├── src/
│   ├── cli/
│   ├── core/
│   │   ├── run.ts
│   │   ├── event.ts
│   │   └── metrics.ts
│   │
│   ├── storage/
│   │   └── sqlite/
│   │
│   ├── recorder/
│   ├── inspect/
│   ├── diff/
│   ├── replay/
│   ├── adapters/
│   └── schema/
│
├── tests/
├── examples/
├── docs/
│
├── package.json
├── README.md
└── PROJECT.md
```

---

# 20. 迭代计划

## M0 — Repository Skeleton

目标：

> 可安装、可构建、可测试。

完成：

```text
pnpm
TypeScript
CLI
Vitest
tsup
CI
```

验收：

```bash
agentlens --help
```

---

# M1 — Event Schema

这是整个 AgentLens 最重要的里程碑。

完成：

```text
Run
AgentEvent
ToolEvent
Metrics
SQLite schema
migration
```

同时准备：

```text
10+ fixture traces
```

包括：

```text
success
tool failure
retry
loop
timeout
cancel
```

验收：

所有 Fixture 可以：

```text
write
read
serialize
deserialize
```

保持一致。

---

# M2 — Recorder

实现：

```typescript
startRun()

emit()

completeRun()

failRun()
```

以及：

```bash
agentlens import trace.jsonl
```

验收：

一个 Demo Agent 可以完整记录：

```text
Run Start
↓
Tool
↓
Tool
↓
Error
↓
Tool
↓
Complete
```

---

# M3 — Inspect

实现：

```bash
agentlens runs

agentlens inspect <run>
```

展示：

```text
metadata
timeline
metrics
tool calls
errors
result
```

验收：

开发者不打开数据库就可以理解：

> 这个 Agent 这一轮到底干了什么。

---

# M4 — Diff

这是 V0.1 发布门槛。

实现：

```bash
agentlens diff A B
```

至少支持：

```text
duration diff
token diff
tool count diff
tool distribution diff
error diff
outcome diff
timeline diff
```

验收：

输入两个：

```text
一个成功 Run
一个失败 Run
```

用户应能在 **30 秒以内**发现最明显的行为差异。

---

# M5 — Loop Detection

这是第一个真正体现 AgentLens 产品特色的能力。

规则检测：

```text
repeated same tool
repeated same file
repeated error
tool ping-pong
no-progress loop
```

例如：

```text
read A
read B
read A
read B
read A
```

输出：

```text
Possible exploration loop detected.

Repeated file reads:
src/a.ts × 5
src/b.ts × 4
```

第一版必须：

> Rules First。

不要 LLM First。

---

# M6 — Adapter

首先支持：

```text
Pi
Generic JSONL
```

然后：

```text
Codex
```

Adapter 只负责：

```text
External event
↓
AgentEvent
```

---

# M7 — Relay Dogfood

让 Relay 接 AgentLens：

```text
Relay
 │
 ├── Run Events
 ├── Step Events
 ├── Effect Events
 └── Recovery Events
       ↓
    AgentLens
```

这时你自己的三个项目就形成：

```text
ctxpack
Context Portability
      │
      ▼
Relay
Durable Execution
      │
      ▼
AgentLens
Execution Intelligence
```

---

# 21. V0.1 Release Criteria

以下全部完成才能发布：

```text
Record
✓

Store
✓

Inspect
✓

Diff
✓

Generic JSONL
✓

至少一个 Agent Adapter
✓
```

真实 Demo：

```text
Run A
模型执行失败

Run B
修改策略后成功

agentlens diff A B
```

能够明显显示：

```text
Tool Path
Token
Error
Duration
Outcome
```

差异。

---

# 22. V0.2

增加：

```text
Loop Detection

Run tags

Artifact tracking

JSON export

Markdown report

Filtering

Better timeline
```

---

# 23. V0.3

这时候才能考虑 Web UI。

推荐：

```text
React
Vite
```

页面只有：

```text
Runs

Run Detail

Run Diff
```

不要 Dashboard 化。

第一个页面甚至应该直接是：

```text
Run A
VS
Run B
```

而不是一堆饼图。

---

# 24. V0.4+

后续可能加入：

```text
Eval

Regression Suite

Replay

Model Compare

Prompt Compare

Harness Compare
```

最终可能形成：

```bash
agentlens compare \
  --baseline gpt-x \
  --candidate glm-x \
  ./tasks
```

得到：

```text
PASS rate

Tool calls

Tokens

Latency

Failure patterns

Behavior divergence
```

但这绝不是第一阶段。

---

# 25. 核心指标

AgentLens 自己的产品价值不能用：

```text
支持多少 Provider
```

衡量。

应该看：

### Diagnosis Time

```text
发现 Agent 执行异常原因所需时间
```

目标：

```text
降低 ≥ 50%
```

### Behavioral Diff Clarity

两次运行的关键行为差异是否可以：

```text
30 秒内理解
```

### Instrumentation Cost

集成 AgentLens：

```text
< 30 行代码
```

或者：

```text
JSONL pipe
```

即可。

### Runtime Overhead

记录事件带来的执行性能损失：

```text
< 5%
```

---

# 26. 设计原则

AgentLens 必须始终遵守：

## Local First

默认数据不出机器。

## Event First

先把 Event Schema 搞对。

## CLI First

先解决问题，再做 UI。

## Diff First

不要复制一个新的 Trace Viewer。

## Rules Before LLM

能通过确定性算法判断的：

```text
不要调用 LLM。
```

## Framework Agnostic

AgentLens 不应该要求：

> 使用 AgentLens Runtime 才能使用 AgentLens。

任何 Agent 只要能提供 Event：

```text
都应该可以接入。
```

---

# 27. 项目护栏

每次准备新增功能时问：

> 这个功能是否帮助开发者理解 Agent 为什么这样执行？

如果答案是：

> 它可以让 Agent 自动执行更多东西。

那么大概率属于：

```text
Relay
```

而不是 AgentLens。

如果答案是：

> 它负责跨 Agent 保存上下文。

那么属于：

```text
ctxpack
```

AgentLens 自己只负责：

> **Understand agent execution.**

最终三个项目的边界应该极其清晰：

```text
ctxpack

Don't make the next agent
start from zero.


Relay

Don't make a long-running agent
lose its work.


AgentLens

Don't debug agent behavior
by guessing.
```

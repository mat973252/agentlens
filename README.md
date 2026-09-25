# AgentLens

面向 AI Agent 开发者的本地执行分析工具，先实现记录、查看和对比两次运行。核心是稳定的 Event Schema 与可解释的行为差异。

项目范围、CLI、技术栈与 M0–M7 里程碑见 [PROJECT.md](PROJECT.md)。当前已验收 M0–M5，代码开发由 Devin Cloud 按里程碑交付。

## 开发与验收

每次只执行一个里程碑。Devin 提供可取得的源码、测试命令与结果；维护者独立复核通过后，才进入下一阶段。进度记录见 [DELIVERY.md](DELIVERY.md)。

V0.1 以真实失败/成功运行的记录和 Diff 演示为发布门槛；项目目标指标在获得对照实验前只算目标，不算已达到的结果。

许可证：[Apache-2.0](LICENSE)。

## 开发环境

- Node.js >= 22.13（`node:sqlite` 在该版本起免 flag 可用；`.nvmrc` 为 22）
- pnpm 10（`packageManager` 字段固定；推荐 `corepack enable` 后使用 `corepack pnpm`）

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint       # Biome + tsc --noEmit
corepack pnpm test       # Vitest
corepack pnpm build      # tsup → dist/cli.js
node dist/cli.js --help  # 或 pnpm dev -- --help
```

## M2：SDK Recorder 与 JSONL 导入

SDK 入口为 `agentlens` 包（`dist/index.js`）。Recorder 与 Provider 无关：Harness 启动一次 run、发出归一化事件、最后完成或失败该 run。事件在 `completeRun()`/`failRun()` 时才整体写入本地 SQLite（运行中的 run 不会写入半截数据）。

```ts
import { Recorder, SqliteTraceStore } from "agentlens";

const store = SqliteTraceStore.open();      // 默认 <cwd>/.agentlens/agentlens.db
const recorder = new Recorder({ store });

const run = recorder.startRun({ agent: "my-agent", model: "model-x" });
const t = run.emit("tool.started", { tool: "grep", input: { pattern: "TODO" } });
run.emit("tool.completed", { tool: "grep", success: true }, { parentId: t.id });
run.completeRun();                          // 或 run.failRun(error)
store.close();
```

CLI 导入：将 JSONL trace 校验后写入同一 SQLite 存储（全部为本地处理，文件内容不上传）。

```bash
agentlens import trace.jsonl [--db ./.agentlens/agentlens.db]
```

JSONL 格式（`agentlens-trace` v1）：第一行为 run 元信息（不含 `events` 字段），之后每行一个事件，按原顺序保存。

```jsonl
{"format":"agentlens-trace","formatVersion":1,"kind":"run","run":{"id":"r1","startedAt":"...","status":"passed","metrics":{"toolCalls":0,"failedToolCalls":0}}}
{"format":"agentlens-trace","formatVersion":1,"kind":"event","event":{"id":"e1","runId":"r1","timestamp":"...","type":"run.started","data":null}}
```

未知字段、格式错误、缺失/重复 run 行、事件先于 run 行、不受支持的 `formatVersion`、重复 run id 都会明确报错；导入是原子的，失败不会在数据库中留下部分数据。

Demo Agent（`Run Start → Tool → Tool → Error → Tool → Complete`）：

```bash
corepack pnpm demo   # 写入 .agentlens/agentlens.db 并导出 demo-trace.jsonl
```

## M3：查看本地运行记录

`runs` 与 `inspect` 以只读方式打开数据库：不创建缺失文件、不改写记录、不触发迁移。

```bash
agentlens runs [--db ./.agentlens/agentlens.db]        # 稳定排序的 Run 列表
agentlens inspect <run-id> [--db ...]                  # 元信息、工具调用、错误、指标、时间线、结果
```

`inspect` 输出元信息（状态、Agent/模型、起止时间）、工具调用及失败原因、错误事件、metrics（tokens、文件数、工具调用数）、按序事件时间线和最终结果。缺失数据库、未知 Run ID、损坏或非 AgentLens 数据库、不支持的 schemaVersion 都以非零退出码明确报错。

## M4：对比两次运行

`diff` 与 `runs`/`inspect` 使用同样的只读打开方式，只比较同一数据库中两个不同 Run，不创建缺失文件、不改记录、不触发迁移。

```bash
agentlens diff <runA> <runB> [--db ./.agentlens/agentlens.db]
```

输出包含：

- 概览：A/B 状态、duration、input/output/reasoning tokens、toolCalls/failedToolCalls 及可计算的 delta；缺失指标显示 `unknown`，不按 0 处理。
- 工具分布：从事件记录统计每个工具的调用次数及差值，按绝对差值和工具名稳定排序；未结束的工具调用单独计数。
- 错误与结果：列出记录的 `tool.failed`/`error` 事件和最终结果；仅按相同来源类型、工具和错误文本分组，不把不同来源的相同文本推断成同一根因。
- 时间线差异：对事件签名（事件类型 + 工具名）执行确定性 LCS 对齐，`=`/`~`/`-`/`+` 表示相同、载荷不同、仅 A、仅 B；不匹配 ID、时间戳或载荷，也不作语义推断。

缺失数据库、未知 Run、相同 Run ID、损坏或非 AgentLens 数据库、不支持的 schemaVersion 都以非零退出码明确报错；相同输入重复输出一致。

## M5：规则式循环检测

`inspect` 新增只读的 `Possible loops` 诊断区，由纯规则入口 `detectPossibleLoops(run)`（自 `agentlens` 包导出）计算。全部判定只依赖已存储的 AgentEvent（工具名、输入、输出、错误文本、事件顺序），不做语义推断、不调用 LLM；每条信号给出规则名、触发证据（事件 ID 范围与次数）与置信边界，无命中时明确输出 `No loop signals detected.`。

规则与阈值（`src/core/loops.ts` 的 `LOOP_RULE_THRESHOLDS`）：

- `repeated-identical-call`：同一工具以完全相同的规范输入（JSON 键序归一化）调用 **≥3** 次，且每次结果相同（completed 比较 `output`，failed 比较 `error`）。结果不同的重复调用视为携带新信息，不报。
- `repeated-file`：同一文件路径（输入中的 `path`/`file`/`filePath`/`filename`）被**同一工具**访问 **≥3** 次；证据列出各工具次数。
- `repeated-error`：相同的错误（事件类型 + 工具 + 错误文本）在 `tool.failed`/`error` 事件中出现 **≥3** 次。
- `tool-ping-pong`：工具调用签名（工具 + 规范输入）构成长度 **2–6** 的循环，且完整重复 **≥2** 个回合（≥2k 次调用）；按最小周期报告一次。
- `no-observable-progress`：**≥4** 次连续的工具调用均为对更早相同调用的原样重放（相同输入且相同结果），中间没有 artifact/plan/verification 事件。未结束的工具调用无结果可比，既不计入重复也中断该序列。

误报/漏报边界：

- 所有信号都是 “possible loop”，不是已确认的语义循环。相同重试可能是合法的轮询或退避；编辑后重试、同一文件被多种工具触碰视为可能的进展。
- 载荷无法证明进展：当 run 未记录 artifact/plan/verification 事件时，报告附注说明进展**无法证实也无法证伪**。
- 只比较 recorded 的 input/output/error；不比较耗时、timestamp、message 文本，也不比较工具无法观测的外部状态。
- 结果是确定的：同一事件序列总是产生同一报告。
- 输出有界，较大运行不会失控：`maxSignalsPerRule`（每条规则最多列 10 条信号，按事件顺序取最早者）、`maxEvidencePerSignal`（每条信号最多 8 行 evidence）、`maxEventIdsPerSignal`（每条信号最多列 20 个事件 ID）。被截断的部分不会丢失：报告 `totalSignalCount` 始终保存全部命中数，notes 逐条说明每条规则命中多少次、展示前多少条；事件 ID 被截断时 evidence 的范围行（`events e1–e9 (N calls)`）仍覆盖全部出现次数。

当前已实现命令为 `import`、`runs`、`inspect`、`diff`、`ui`；`show`、Provider 适配、Replay 与云服务在后续里程碑实现，尚未提供。

## M6：外部格式 Adapter（Generic JSONL 与 Pi）

`agentlens import` 通过 `--format` 显式指定输入格式，不做内容猜测：

```bash
agentlens import trace.jsonl                          # agentlens-trace v1（默认，M2 兼容）
agentlens import events.jsonl --format generic        # agentlens-generic v1
agentlens import pi-session.jsonl --format pi         # Pi coding-agent 会话 JSONL
```

三种格式都只产出已验证的 Run，由存储层原子写入；非法输入、无效工具关联、重复 Run id、未来格式版本都使整个导入失败，不留下半条 Run。Adapter 只负责 `外部事件 → AgentEvent/Run`，core 不出现任何 Pi 专有事件类型。

### agentlens-generic v1

与 `agentlens-trace` 同为「一行 run 元信息 + 逐行事件」的包络，但事件形状面向外部 Agent 简化：

```jsonl
{"format":"agentlens-generic","formatVersion":1,"kind":"run","run":{"id":"r1","agent":"a","model":"m","startedAt":"...","status":"passed","metrics":{...}}}
{"format":"agentlens-generic","formatVersion":1,"kind":"event","event":{"id":"e1","type":"message.input","timestamp":"...","parentId":"...","data":{...}}}
{"format":"agentlens-generic","formatVersion":1,"kind":"event","event":{"id":"e2","type":"tool.started","timestamp":"...","tool":"ls","input":{...},"toolCallId":"c1"}}
{"format":"agentlens-generic","formatVersion":1,"kind":"event","event":{"id":"e3","type":"tool.completed","timestamp":"...","toolCallId":"c1","output":{...},"durationMs":12}}
```

- `run` 只有 `id` 必填；`startedAt` 缺省取首个事件时间戳，终态 Run 的 `endedAt` 缺省取末事件时间戳，`status` 缺省按末事件推导（`run.completed`→passed、`run.failed`→failed、否则 running）。`metrics` 可显式携带 token 等数值；缺省时只计算 `toolCalls`/`failedToolCalls`，不猜任何缺失指标。
- 事件 `type` 即 AgentEventType；非 tool 事件的 `data` 原样保留。tool 事件用 `tool`/`input`/`output`/`error`/`durationMs` 字段而非 `data`；`tool.completed`/`tool.failed` 用 `toolCallId` 关联更早的 `tool.started`（缺省即其事件 id），或直接给 `parentId`；`tool`/`input` 缺省从关联的 started 继承。
- 未知 `type`、未知字段、无效 `toolCallId`、先于 run 行的事件、重复 run 行都带行号明确报错。

### pi（Pi session）

Pi 指开源 coding agent `pi`（`@earendil-works/pi-coding-agent`，仓库 `github.com/badlogic/pi-mono`，MIT）。其会话文件为 JSONL：首行 `{"type":"session","version":N,...}` 头部，其后为 `message`/`model_change`/`usage`/`compaction`/`thinking_level_change` 等条目；v1 会话无 `version` 字段，当前 `CURRENT_SESSION_VERSION` 为 3（`packages/coding-agent/src/core/session-manager.ts`）。Adapter 支持 version ≤3，更高版本明确拒绝。

样本与依据：`fixtures/pi/*.jsonl` 由公开 fixture `packages/coding-agent/test/fixtures/before-compaction.jsonl`（pi-mono commit `5fd446ca1843682e8da3fec4ceb71c42f56fbace`）的真实行原样节选组成，仅将错误样本的 session id 末位改为 `...f90fe` 以便与成功样本共存；不含任何私有会话、密钥或 Cookie。

映射（只产出既有 AgentEventType）：

- session 头 → run 元信息 + 合成的 `run.started`（`data.source` 保留原始头部与格式版本）。
- `message`：`user`/`custom` → `message.input`；`assistant` 的 text→`message.output`、thinking→`reasoning.summary`、toolCall→`tool.started`（事件 id 为 `pi-tool-<toolCallId>`）；`stopReason` 为 `error`/`aborted` 或含 `errorMessage` 时额外发 `error` 事件；`toolResult` 按 `isError` → `tool.completed`/`tool.failed` 并 parentId 到对应 `tool.started`，`input` 继承调用参数、`output` 保留原始 `content`/`details`/`usage` 块、`durationMs` 由消息毫秒时间戳差得到；`bashExecution` → `tool.started`+结果对（tool 名为 `bash`）。
- `compaction`/`branch_summary` 与 `custom_message` → `reasoning.summary`/`message.input`（注入上下文的文本），原文与字段保存在 `data.source`。
- `model_change` 更新 run.model；assistant `usage` 累计为 metrics 的 input/output/reasoningTokens（未上报则不出现）；时长由首末时间戳差计算。
- 无法映射的条目（`usage` 记录、`thinking_level_change`、`label`、`session_info`、`context_edit`、`custom`、仅含 toolCall 的 assistant 元信息、未知类型）不生成事件，原始行按序保留在终态事件 `data.source.unmappedEntries`（含原始行号与时间戳），不静默丢弃。
- Run 状态：末条 assistant 的 `stopReason` 为 `error`→failed、`aborted`→cancelled、否则 passed，并追加合成的 `run.completed`/`run.failed` 终态事件。

已知边界：`usage`/`cost` 条目与 assistant 级 provider 元数据只保留在 `source`/`unmappedEntries` 原始载荷中（metrics 无对应字段，cacheRead/cacheWrite/cost 不进入指标）；`filesRead`/`filesWritten` 不从工具名推断；tool 事件的 `data` 受既有严格 schema 约束，不能内嵌 `source`（逐事件溯源见事件 id 规则 `pi-<entryId>`/`pi-tool-<toolCallId>`）；Pi 会话树的分支结构（parentId 树）按主链线性化为事件链。

## M7：交互式终端界面（agentlens ui）

```bash
agentlens ui [--db ./.agentlens/agentlens.db] [--color auto|truecolor|ansi256|ansi16|none]
```

`ui` 从已安装的 npm 包（`bin`）直接运行，无网络依赖、无外部进程；打开前以 `SqliteTraceStore.openReadOnly` 只读加载全部 Run 后**立即关闭**数据库——界面运行期间不再持有任何数据库句柄，绝不创建缺失文件、不改写记录、不触发迁移；读取失败（缺失/损坏/非 AgentLens 库/不支持的 schemaVersion）与 M3 一致的明确报错 + 非零退出。

界面（单一 `ui` 入口内多视图）：

- **Home**：左侧 Run 列表（status glyph、ID、状态、时长、工具计数），右侧 `COMPARE A ⇄ B` 对比卡片（状态/耗时/tokens/工具/文件/事件/loop 计数 + 工具路径 A/B 行，缺失指标显示 `unknown`），宽度 ≥110 列并排、窄宽上下堆叠（≥80×24 可读，120×30 清晰分栏）。
- **Detail**：Run 摘要条 + 标签页 `timeline · tools · errors · loops · inspect`。timeline 为按序事件（`+offset` + 摘要）；tools 为每次调用的输入/输出/错误；errors 为记录的错误事件；loops 复用 `detectPossibleLoops` 的只读信号；inspect 与 `agentlens inspect` 文本逐行一致。宽屏右栏即时预览所选条目详情，Enter 打开全屏 pager（长载荷不分行截断，可滚动）。
- **Diff**：`d` 打开 A/B 完整 diff，输出与 `agentlens diff <a> <b>` 逐行一致（摘要、工具分布、错误、结果、时间线 diff），按 section 分页（Tab 跳转）。
- 顶部 `M·` 标记 + 视图名 + `local · read-only` + Run 数 + 数据库路径；底部固定键位提示与当前终端尺寸。

键盘：↑↓/`j`/`k` 或 PgUp/PgDn/Home/End 移动；Enter 选中（打开 detail / 展开 pager / 详情条目）；Tab 切换列表⇄对比焦点或 detail 标签页/diff section；`a`/`b` 标记 A/B、`x` 交换；`d` diff；`?` 键位表；Esc 返回；`q`/Ctrl+C 退出。所有按键被消费、不会漏键或进入插入态；Ctrl+C 或异常退出都会恢复光标与备用屏幕、关闭 raw mode，终端不留花屏。

配色：终端暗色适配 mat973252.github.io 调色板（ink `#142121`/paper `#fbf9f8`/mint `#83cebe`/muted `#61706b`/teal `#4aab96` + 失败 `#e0705a`/警告 `#d9a848`/选区 `#274642`），自动按 `COLORTERM`/`TERM`/`WT_SESSION` 降级 truecolor→ansi256→ansi16→none；`NO_COLOR` 完全禁用色彩，`--color` 可手动指定。Logo 为文本标记 `M·`，不使用图片协议。

终端要求：stdin/stdout 均为 TTY，否则报错并退出码 1（提示改用 `runs`/`inspect`/`diff`）；最小 50×12（提示小于要求），≥80×24 完整可用；SIGWINCH 实时重排不丢布局；含中文/emoji 内容按占宽正确对齐。已验证 Ubuntu (tmux, Konsole)；Windows Terminal 代码路径相同（Node raw mode + VT 序列），未在本环境验证。

# AgentLens

面向 AI Agent 开发者的本地执行分析工具，先实现记录、查看和对比两次运行。核心是稳定的 Event Schema 与可解释的行为差异。

项目范围、CLI、技术栈与 M0–M7 里程碑见 [PROJECT.md](PROJECT.md)。当前已验收 M0–M3，代码开发由 Devin Cloud 按里程碑交付。

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

当前已实现命令为 `import`、`runs`、`inspect`、`diff`；`show`、循环检测、Provider 适配、Replay、UI 与云服务在后续里程碑实现，尚未提供。

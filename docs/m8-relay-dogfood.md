# AgentLens M8 — Relay 事件来源与隔离试用门槛

状态日期：2026-09-25。M8 尚未验收。本文件限定试用与验收范围，不授权修改或推送 Relay，也不解除其安全审查停点。

## 目标

在本机隔离环境中，使用可追溯的 Relay 执行证据检查 AgentLens 能否呈现 Run、Step、Effect 与 Recovery 的先后关系、错误和结果。先核实数据源，再决定是否需要由 Devin 在 AgentLens 中实现一个独立适配阶段；不得把推断事件填入通用 trace。

## 当前可核查来源与缺口

- Relay 本机源码 `packages/storage-sqlite/src/journal.ts` 的 `relay_effects` 表保存每个 effect key 的**最新状态**，以及 `created_at`、`submitted_at`、`settled_at`、`updated_at`、结果和原因。它不是追加式事件日志；最终 `CONFIRMED` 行本身不能证明此前经历过 `UNKNOWN` 和只读 reconcile。
- `packages/adapter-pi/src/` 目前包含 Pi doctor 与 deferred 试用代码；没有 Relay 自有的通用 Run/Step 事件流。Pi 会话 JSONL 与 effect journal 也没有已验证的稳定关联键。不能把同目录或相近时间当作关联证明。
- `examples/crash-demo.mjs` 使用本机计数器服务展示一次崩溃与恢复，并在结束时删除临时数据库。它可作为隔离样本生成路径，但其终端文字与最终 journal 行须分开标注来源；它不是生产 Relay trace。
- `reports/MCP_SAFETY_REVIEW_RESULT.md` 把安全修复记为“完成、等待独立审查”。报告内部分 host operation ID 含晚于本状态日期的日期，来源尚需核实；不得据此认定 Step 6/7 已通过。

## 试用门槛

1. 先独立复核 Relay 安全修复及当前停点；未经复核，不运行真实外部效果、不推送 Relay、不进入其 Step 6/7。
2. 仅在一次性本机工作区，以本机假 provider 或现有公开测试生成 Relay 证据；记录 Relay 源提交、Node 版本、实际命令、样本哈希与来源。使用一致的离线 SQLite 快照，读取前后核对原始数据哈希和修改时间；不读取用户私有 Pi 会话、凭据或生产 journal。
3. 将**实际观测到的** effect 最新状态与状态时间呈现出来。若要显示 Run、Step、Recovery 事件，必须指出每个事件的原始记录、稳定关联键和时间来源；缺失时明确显示“未知/未记录”，不得把当前状态倒推为完整历史。`UNKNOWN` 不得转成失败或成功，缺失 token/耗时不填零。
4. 使用至少一组成功与一组失败或不确定结果样本，实际运行 AgentLens 的导入、`runs`、`inspect`、`diff` 与 TUI；核对顺序、关联、错误、结果、重复稳定、原始数据只读及导入原子性。比较 CLI 与 TUI 结论。若当前数据源无法满足该项，停止在“数据源不足”的结论，不宣称 M8 完成。
5. 若确需新增 AgentLens 产品适配代码，先提交自包含任务书，单独派给 Devin，10 ACU 上限，优先网页 SWE-2 High，独立分支与 PR 停点；Codex 从 Windows 全新检出、实际 npm 包及 Ubuntu Node 22/24 CI 独立验收。任何 Relay 产品代码变动须另经其安全审查，不纳入此阶段。

## 停止点

在真实事件来源与关联关系得到证据前，M8 保持未验收。此处的本机合成执行只能证明导入和展示路径，不能替代真实 Agent 的 Run/Step/Recovery 覆盖，也不能证明 Relay 可发布。

## 2026-09-26 数据源复核

- Relay [PR #3](https://github.com/mat973252/Relay/pull/3) 已合并；[独立验收报告](https://github.com/mat973252/Relay/blob/main/reports/INDEPENDENT_EFFECT_HISTORY_ACCEPTANCE_2026-09-26.md) 记录了追加式 effect 转移证据、只读一致快照和隔离回归。上文关于 `relay_effects` 只有最新状态的描述是 2026-09-25 快照；现在可读取已实际提交的 effect 转移，但旧库不补造历史。
- 当前事件字段为 effect ID、key、kind、前后状态、原因类别和时间；没有 Pi session、tool call、Run 或 Step ID。MCP `operationId` 是跨会话的 effect 幂等键，不能证明它属于哪条 Pi 会话。Pi adapter 当前只注册 doctor；其 deferred 样本可读取 Pi session 信息，但未提供到 MCP effect 的已验证关联。
- AgentLens 现有导入格式要求完整 Run；Generic 格式要求 `run` 及标准事件。现有模型没有独立 effect/recovery 事件类型。将 Relay effect 历史强行包装成 Run 会制造不存在的执行事实。
- 因此本次在门槛第 4 条前停止：目前无法以可信关联完成 Run、Step、Effect、Recovery 的 CLI/TUI 对照试用。M8 状态为**数据源不足、未验收**。后续只可在独立阶段验证 Pi 公共 API 是否能为真实调用提供稳定、非秘密的 session/tool 关联；证据成立后再决定是否派 AgentLens 适配。Relay 整体安全门槛仍关闭，不运行真实外部效果。

## 2026-09-26 隔离 Pi key-match 探针验收后的适配边界

- Relay [PR #4](https://github.com/mat973252/Relay/pull/4) 已独立重放并合并；[验收记录](https://github.com/mat973252/Relay/blob/main/reports/INDEPENDENT_PI_RELAY_LINK_ACCEPTANCE_2026-09-26.md) 记录了实际 Pi AgentSession、自定义工具桥、未修改的 Relay MCP、loopback provider 的 4 次提交及 success/UNKNOWN/两调用对照。Pi 持久化工具参数中的 actionId/operationId 与 journal key 可以精确匹配。
- 这只证明该实验中的单向 **key match**，不证明 effect 的独占归属或普遍因果关系。Pi 0.87.0 无内置 MCP 客户端；不同桥可改写参数，同一 key 可跨调用/会话复用，journal 无 Pi identity。整体安全门槛仍关闭。
- 下一阶段可复用实际 Pi session 的既有 Run/tool 导入语义，并将 Relay effect snapshot/committed transitions 作为独立、只读来源证据显示；不得改写成虚构的 Run/Step/Recovery AgentEvent。缺失 Recovery 来源显示“未知/未记录”，UNKNOWN 不受 Pi toolResult 的 isError=false 或 Run status 影响。
- 适配任务见 `docs/devin-m8-relay-evidence.md`。本次仅解除“完全无法验证候选 key”的部分阻塞，M8 仍未验收；只有产品适配与 Windows/Ubuntu、实际 CLI/TUI/包安装独立验收后才记录隔离试用结论，且不称为生产覆盖或 Relay 安全通过。

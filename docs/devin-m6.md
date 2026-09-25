# AgentLens M6 — Pi 与 Generic JSONL Adapter

前提：以独立验收的 M5 为基线。只实现 PROJECT.md M6 第一阶段的 Pi 与 Generic JSONL 输入适配：外部事件经独立 Adapter 归一化为现有 AgentEvent/Run，然后进入现有本地 SQLite、`runs`、`inspect`、`diff`。保持 Apache-2.0、Node `>=22.13`。Codex/Claude/OTel 适配、Relay 试用、Replay、UI、云服务与远端采集均不属于本阶段。

范围与契约：

- Generic JSONL 是面向外部 Agent 的简单逐行事件输入，与 M2 的 `agentlens-trace` 封装格式区分清楚；定义并文档化最小必需字段、版本、Run 生命周期、事件 ID/时间戳、工具开始与结果关联以及未知事件处理。允许调用者显式给出 Run/Agent 元数据；不要猜测缺失指标，原始载荷必要时放在 `data` 中。现有 `agentlens import` 对 `agentlens-trace` v1 的行为保持兼容。
- Pi Adapter 依据可核查的 Pi 实际输出格式或官方/开源源码样本实现，并在仓库说明具体格式版本、样本出处及支持边界。准备已脱敏且可复现的成功与失败/工具错误样本；不把臆造的 JSON 当作真实 Pi 格式。不读取或上传用户本机私有会话、密钥、提示词或 Cookie。
- Adapter 与 core 分层：core 仅见 AgentEvent/Run，不添加 Pi 专有事件类型。时间顺序、工具输入/输出/错误、parentId、Run 状态和已存在的 metrics 尽量保留；无法映射的字段记录在可解释的原始载荷中或明确拒绝，不静默丢失关键事件。
- 提供用户可执行的本地 CLI 导入路径与帮助、README 示例，明确指定 generic/pi 输入格式，避免模糊自动猜测。单文件可导入一个完整 Run；中断、非法 JSON、无效关联、重复 Run、未来格式版本或损坏记录必须明确失败且不留下半条 Run。无网络发送；既有查询与 Diff 仍只读。

验收：从干净检出冻结安装、lint/test/build；用 Generic JSONL 成功/失败样本及有来源的 Pi 样本实际运行构建产物 CLI 导入到临时数据库，再用 `runs`/`inspect`/`diff` 核对状态、事件顺序、工具路径、输入/输出、错误、结果和存在的指标。对照源文件逐项说明映射及不可映射信息。验证同一输入重复导入拒绝且数据库内容不变，非法/截断输入原子失败，已有 `agentlens-trace` 导入回归，Windows Git `core.autocrlf=true` 与 Ubuntu Node 22/24 CI 均通过。若缺乏可核查的 Pi 格式或无法运行真实样本，不宣称 Pi Adapter 验收完成，报告阻塞与证据。

在已授权仓库的 `devin/m6-adapters` 分支提交并推送，报告完整 SHA、输入格式来源、实际命令/结果、映射边界及已知缺口；完成 M6 后停下等待独立验收。不直接修改 main，不开始 M7，不引入未经授权的远端服务。计算消耗上限 10 ACU，接近上限时停止并报告进度。

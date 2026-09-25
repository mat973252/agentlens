# AgentLens M0 — Devin Cloud 任务书

基于已授权的公开仓库 `mat973252/agentlens` 当前 `main`，只实现 AgentLens 的 M0 项目骨架。AgentLens 是本地优先的 Agent 执行分析 CLI，V0.1 围绕 Record、Inspect、Diff；本阶段不实现 Event Schema、SQLite、Recorder、Diff、Replay 或 UI。技术约束：Node.js 22+、TypeScript、pnpm、Commander.js、Vitest、tsup，轻量 lint 与 GitHub Actions CI。

许可证是 Apache-2.0；`package.json` 的 license 字段与交付源码中的 LICENSE 文件都必须一致。

在仓库根目录交付可独立安装的源码，使全新 Linux 环境能够执行 `corepack pnpm install --frozen-lockfile`、lint、test、build，以及构建产物的 `agentlens --help`。CLI 帮助要显示项目名和命令入口；尚未实现的后续命令不要伪装成可用。附带最小示例测试和明确的 Node/pnpm 版本说明。优先使用简单结构，不要提前搭建未来模块框架。保持已有 `PROJECT.md`、`DELIVERY.md` 与里程碑文档。

请在 `devin/m0-skeleton` 分支提交并推送，报告完整提交 SHA、实际运行命令和结果、已知限制。若 GitHub 权限或环境使推送失败，保留本地提交并明确报告阻塞，不要重做已完成代码。

停止点：完成 M0 后停下等待独立验收；不要开始 M1，不要直接修改 `main` 或发布。若方案需要外部权限或超出本阶段范围，先说明阻塞。把本阶段计算消耗控制在 5 ACU 内；接近上限时停下报告当前成果。

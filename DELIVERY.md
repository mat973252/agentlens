# 里程碑交付记录

状态日期：2026-09-25。项目文档与本地 Git 基线已建立；实现里程碑尚未验收。

| 阶段 | 交付结果 | 独立验收 | 状态 |
| --- | --- | --- | --- |
| M0 | 可安装 CLI、构建、测试、CI | 全新安装；`agentlens --help`；构建与测试 | 本机验收通过，待 main CI |
| M1 | Event Schema、SQLite schema/migration、10+ fixtures | fixtures 写入、读取、序列化往返一致 | 未开始 |
| M2 | SDK Recorder 与 JSONL 导入 | Demo Agent 从开始到完成的事件记录完整 | 未开始 |
| M3 | `runs`、`inspect` | 无需打开数据库即可理解一次运行 | 未开始 |
| M4 | `diff A B` | 对照成功与失败运行，在 30 秒内发现主要差异 | 未开始 |
| M5 | 规则式循环检测 | 重复工具、文件、错误和 ping-pong 案例可复现 | 未开始 |
| M6 | Pi、Generic JSONL，后续 Codex 适配 | 外部事件归一化后信息正确 | 未开始 |
| M7 | Relay 真实试用 | 记录对照案例与集成成本 | 未开始 |

每阶段验收记录须包含源码来源、版本或提交、运行环境、实际命令、结果、已知缺口及下一步决定。未验收成果不得标为完成；远端创建、推送和发布另行处理。

## M0 验收记录（2026-09-25）

- 源码：Devin Cloud 会话 `2154c12229864de0932a6e353d88c681`，首次提交 `75c3f5b66ca169148618e95e0b363a4dde3a5266`；独立验收发现 Windows Git `core.autocrlf=true` 检出后 Biome 因 CRLF 报 8 个格式错误。Devin 在同一分支补交 `.gitattributes`，最终提交 `73ce7c0f875ad9972a82bcb36865150bd589e0d9`，远端 `devin/m0-skeleton` SHA 已核对，`main` 快进至此提交。
- 独立环境：Windows PowerShell、Git 系统配置 `core.autocrlf=true`、Node v24.19.0、pnpm 10.17.1；从修复后远端分支建立全新检出 `D:\code\aiproject\_review\agentlens-m0-fix`。未更改用户 Git 全局配置。
- 实际命令与结果：`corepack pnpm install --frozen-lockfile` 通过；`corepack pnpm lint`（Biome 与 `tsc --noEmit`）通过；`corepack pnpm test` 3/3 通过；`corepack pnpm build` 通过；`node dist/cli.js --help` 显示项目名称和入口，`--version` 为 0.0.1。全新检出 `git status --short` 为空。
- 范围与许可：仅有 M0 骨架、CLI 空入口、示例测试与 Node 22/24 Ubuntu CI；Event Schema、SQLite、Recorder、Diff、Replay 均未实现。`package.json` 的 `Apache-2.0` 与现有 LICENSE 一致。未发现跟踪的 env 或凭据路径。
- 已知边界：Windows Node 22、Ubuntu Node 22/24 的托管 CI 尚待确认；首次提交的 Windows lint 问题已由 `.gitattributes` 在新检出中复验解决。当前仅能把本机 M0 验收标为通过，不能据此宣称 M1 功能可用。
- 下一步：推送 `main` 后确认 Ubuntu CI；通过后按 `docs/devin-m1.md` 单独派发 M1。

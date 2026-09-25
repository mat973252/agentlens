# 里程碑交付记录

状态日期：2026-09-25。项目文档与本地 Git 基线已建立；实现里程碑尚未验收。

| 阶段 | 交付结果 | 独立验收 | 状态 |
| --- | --- | --- | --- |
| M0 | 可安装 CLI、构建、测试、CI | 全新安装；`agentlens --help`；构建与测试 | 已验收 |
| M1 | Event Schema、SQLite schema/migration、10+ fixtures | fixtures 写入、读取、序列化往返一致 | 已验收 |
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
- Ubuntu CI：`main` 提交 `fb15c49` 的 [运行 36095835132](https://github.com/mat973252/agentlens/actions/runs/36095835132) 已通过 Node 22/24 两项作业，每项包含冻结安装、lint、测试、构建与 CLI 帮助冒烟。
- 已知边界：Windows Node 22 尚未单独测试；首次提交的 Windows lint 问题已由 `.gitattributes` 在新检出中复验解决。M0 不包含 M1 功能。
- 下一步：按 `docs/devin-m1.md` 单独派发 M1。

## M1 验收记录（2026-09-25）

- 源码：Devin Cloud 会话 `0b586d2c7af7401b8cd762ce6db2238e`，PR [#1](https://github.com/mat973252/agentlens/pull/1)，最终提交 `8a0fcab213d07f3758286c388033aab5c30bdda1`；远端 `devin/m1-event-schema` SHA 与 PR head 均已核对，`main` 快进到同一提交，PR 显示 merged。
- 返工：首版 `5ea168c` 在 Windows 上 58 项测试中 1 项失败，原因是 `SqliteTraceStore.open` 在未来 schemaVersion 异常路径未关闭 SQLite 句柄，导致清理临时数据库报 EPERM；ASCII TEMP 也复现。Devin 提交 `b8dd11b` 修复连接释放并增加删除断言。随后发现 `node:sqlite` 最低受支持版本与 `engines.node >=22`/README 不一致，Devin 提交 `8a0fcab` 将承诺改为 `>=22.13`。
- 独立环境与命令：Windows PowerShell、Git `core.autocrlf=true`、Node v24.19.0、pnpm 10.17.1；最终提交全新检出 `D:\code\aiproject\_review\agentlens-m1-final`。`corepack pnpm install --frozen-lockfile`、lint、58/58 tests、build、`node dist/cli.js --help` 均通过；工作区保持干净。
- 范围与验证：12 份 JSON fixture 覆盖成功、工具失败与恢复、重试、循环、超时、取消、部分运行和 Unicode 载荷；测试逐份进行序列化/反序列化及 SQLite 写读往返，并核对事件顺序和值。另有非法事件类型/关联/版本、损坏数据、迁移、回滚及未来版本错误测试。检查 diff 未涉及 `LICENSE`、`PROJECT.md`、CLI 功能或其他里程碑；Apache-2.0 保持一致。
- Ubuntu CI：PR 最终提交的 [运行 36096755831](https://github.com/mat973252/agentlens/actions/runs/36096755831) 与 `main` 的 [运行 36096911155](https://github.com/mat973252/agentlens/actions/runs/36096911155) 均显示 Node 22/24 两项作业通过。
- 已知边界：本机仅运行 Node v24.19.0，Node 22.13 最低小版本未在本机单独运行；Node 22/24 的托管 CI 使用各自当前补丁版。事件 `data` 为必需且可为 null；metrics 目前只约束 `failedToolCalls <= toolCalls`，不从事件流重算；M2 Recorder 与 JSONL 导入尚未实现。
- 下一步：按 `docs/devin-m2.md` 单独派发 M2。

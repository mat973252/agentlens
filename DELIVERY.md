# 里程碑交付记录

状态日期：2026-09-25。M0–M4 已独立验收并集成；M5–M7 尚未验收。

| 阶段 | 交付结果 | 独立验收 | 状态 |
| --- | --- | --- | --- |
| M0 | 可安装 CLI、构建、测试、CI | 全新安装；`agentlens --help`；构建与测试 | 已验收 |
| M1 | Event Schema、SQLite schema/migration、10+ fixtures | fixtures 写入、读取、序列化往返一致 | 已验收 |
| M2 | SDK Recorder 与 JSONL 导入 | Demo Agent 从开始到完成的事件记录完整 | 已验收 |
| M3 | `runs`、`inspect` | 无需打开数据库即可理解一次运行 | 已验收 |
| M4 | `diff A B` | 对照成功与失败运行，快速发现主要差异 | 已验收 |
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

## M2 验收记录（2026-09-25）

- 源码：Devin Cloud 会话 `054e5b02fa5849d39115f40aba8b4795`、PR [#2](https://github.com/mat973252/agentlens/pull/2)，最终提交 `9967c52106bc738934c06fc3060342c4e9193d62`；远端分支及 PR head SHA 已核对，`main` 快进到同一提交，PR 显示 merged。
- 返工：首版 `37be98c` 在 Windows 上 `examples/demo-agent.ts` 静默退出0但不生成 DB/JSONL，原因是直接比较 `import.meta.url` 与 Windows 路径。Devin 提交 `a976a7c` 修复跨平台入口，`9967c52` 使 Demo 子进程回归测试兼容 Node SQLite 实验警告；产品实现不再有该入口问题。
- 独立环境与命令：Windows PowerShell、Git `core.autocrlf=true`、Node v24.19.0、pnpm 10.17.1；最终提交全新检出 `D:\code\aiproject\_review\agentlens-m2-final`。`corepack pnpm install --frozen-lockfile`、lint、94/94 tests、build 均通过，CLI help 仅列已实现的 `import`。
- Demo 端到端：在独立临时目录实际运行 `corepack pnpm exec tsx examples/demo-agent.ts --db <demo.db> --jsonl <demo.jsonl>`，再以构建产物 `node dist/cli.js import <demo.jsonl> --db <imported.db>` 导入。两库各 1 个 Run、9 个有序事件，含 `run.started`、三次工具调用（一次失败）、`error` 与 `run.completed`；按 SQL 读出 runs/events 全字段的 JSON SHA-256 完全一致，覆盖顺序、parentId、状态与载荷。非法 JSONL 返回 1 且不创建目标数据库；重复导入返回 1，现有库仍为 1 Run、9 事件。
- 范围与许可：本地 SDK Recorder、严格 JSONL v1 格式及 `import` CLI；12 份 M1 fixture 的往返及生命周期、非法输入测试仍在测试集中。`LICENSE`、`PROJECT.md`、里程碑文档、CI 未被产品分支改动；`package.json` 仍为 Apache-2.0、Node `>=22.13`。Recorder 只在完成或失败时将整条 Run 原子写入，运行中状态未持久化；此为已知设计边界。
- Ubuntu CI：PR 最终提交的 [运行 36100283463](https://github.com/mat973252/agentlens/actions/runs/36100283463) 与 `main` 提交 `9967c52` 的 [运行 36100344119](https://github.com/mat973252/agentlens/actions/runs/36100344119) 均显示 Node 22/24 两项通过。
- 下一步：按 `docs/devin-m3.md` 单独派发 M3 的只读 `runs`/`inspect` 命令。

## M3 验收记录（2026-09-25）

- 源码：Devin Cloud 会话 `5f506e3c27dc4e63bc5055c4dd6c672b`，远端 `devin/m3-inspect` 最终提交 `27d79f87e022f77f6c1294bd036182c3c5a7c0c2` 已核对，并快进集成 `main`。首版 `565f608` 虽通过自动测试，但独立验收发现 `runs` 缺结束时间、`inspect` 隐去工具输入输出与最终 summary；已由 Devin 在同分支修复并补回归。M3 没有实现后续 Diff 等功能。
- 独立环境与命令：Windows PowerShell、Git `core.autocrlf=true`、Node v24.19.0、pnpm 10.17.1；最终远端提交的全新检出位于 `D:\code\aiproject\_review\agentlens-m3-27d79f`。`corepack pnpm install --frozen-lockfile`、lint、106/106 tests、build 均通过；`git diff --check` 无误，Apache-2.0 与 Node `>=22.13` 保留。
- CLI 端到端：从 M1 的成功、工具失败后恢复、取消和运行中四份 fixture 写入临时 SQLite，构建产物 `runs`/`inspect` 实际显示有序列表、起止时间、状态、Agent/模型、指标、工具输入输出及失败、事件顺序和最终 summary。重复输出逐字一致。M2 Demo 实际生成 DB/JSONL，`runs`/`inspect` 可读其 9 个事件。
- 只读及错误路径：对 fixture DB 查看前后 SHA-256 与修改时间均不变，无 WAL/journal；缺失数据库不创建目录，未知 Run ID、非 SQLite 损坏文件、未来 schemaVersion 均以非零状态和明确错误退出。验收脚本在 `_review` 临时区，未进入产品仓库。
- Ubuntu CI：`main` 提交 `27d79f8` 的 [运行 36101294948](https://github.com/mat973252/agentlens/actions/runs/36101294948) 已通过 Node 22/24 两项作业，各自完成冻结安装、lint、测试、构建与 CLI 帮助冒烟。
- 已知边界：工具输入输出与结果载荷在终端中有长度上限，超出时以省略号提示；尚无两次运行 Diff、循环检测或外部 Provider 适配。Node 22.13 最低补丁版未在本机单独测试。
- 下一步：按 `docs/devin-m4.md` 单独派发 M4 Diff。

## M4 验收记录（2026-09-25）

- 源码：Devin Cloud 会话 `7ca0811e1eba4ea18cf065317a9f8838`、PR [#3](https://github.com/mat973252/agentlens/pull/3)，最终提交 `a942641e35baf65b705d82fa7073686d6c606bd2`；远端分支及 PR head SHA 已核对，`main` 快进到同一提交，PR 显示 merged。
- 独立环境与命令：Windows PowerShell、Git `core.autocrlf=true`、Node v24.19.0、pnpm 10.17.1；最终远端提交的全新检出 `D:\code\aiproject\_review\agentlens-m4-a942641`。冻结安装、lint、112/112 tests、build、构建产物 CLI/help 均通过；`git diff --check` 无误，Apache-2.0 与 Node `>=22.13` 保留。
- Diff 端到端：将五份 M1 fixture 写入独立临时 SQLite；构建产物实际对比基础成功/致命工具失败、计划成功/重试耗尽、含缺失指标的运行中样本。输出含状态、时长、token 与工具指标的 A/B/变化值、按工具分布、错误、结果和明确匹配规则的时间线差异；缺失的 reasoning token 显示 `unknown`。同一输入重复输出逐字一致。基础成功对致命失败的输出可直接定位新增 shell 部署调用、`permission denied`、运行失败及工具路径差异；这是单样本人工观察，不证明产品层面的“30 秒内理解”指标。
- 只读及错误路径：查看前后数据库 SHA-256 与修改时间不变，无 WAL/journal；缺失数据库不创建目录，未知或相同 Run ID、损坏数据库、未来 schemaVersion 均以非零状态和明确错误退出。验收脚本在 `_review` 临时区，未进入产品仓库。
- Ubuntu CI：PR [运行 36102207227](https://github.com/mat973252/agentlens/actions/runs/36102207227) 与合入后 `main` 的 [运行 36102389561](https://github.com/mat973252/agentlens/actions/runs/36102389561) 均通过 Node 22/24 作业。
- 已知边界：时间线以事件类型和工具名做最长公共子序列匹配，并非语义比较；大运行记录的对齐成本和输出长度尚未单独压测。错误按来源类型、工具和相同文本聚合，不代表根因相同。尚无 M5 循环检测、Provider 适配或 Replay。
- 下一步：按 `docs/devin-m5.md` 单独派发规则式循环检测。

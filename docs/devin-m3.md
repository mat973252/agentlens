# AgentLens M3 — 本地运行记录查看

前提：以已独立验收的 M2 为基线。只实现 `agentlens runs` 与 `agentlens inspect <run-id>`；不做两次运行对比、循环检测、Provider 适配、Replay、UI 或云服务。保持 Apache-2.0、Node `>=22.13` 与本地优先。

目标：从现有 SQLite 记录以只读方式展示一次 Agent 执行。`runs` 给出稳定排序的 Run 列表及 ID、状态、Agent/模型、起止时间和关键指标；`inspect` 给出元信息、有序事件时间线、工具调用与失败、错误、指标和最终结果。输出应让开发者无需打开数据库就能回答“这次 Agent 做了什么、在哪失败或完成”。两命令都支持与 M2 `import --db` 一致的数据库路径选择，帮助文本准确列出已实现命令。

验收：用 M2 Demo 数据库及 M1 至少三种不同状态的 fixture 数据库，实际执行 `runs` 和 `inspect`，核对 Run ID、状态、事件顺序、工具及错误、metrics 与最终结果；同一数据库重复输出稳定。缺失数据库、未知 Run ID、损坏或不支持的 schemaVersion 必须明确失败；查看命令不得创建缺失数据库、修改既有记录或触发迁移写入。全新安装后的 lint/test/build、构建产物 CLI 帮助与命令端到端通过。README 提供最短示例和当前能力边界。

在已授权仓库的 `devin/m3-inspect` 分支提交并推送，报告完整 SHA、实际命令和结果、已知限制。完成 M3 后停下等待独立验收，不开始 M4、不直接改 main。计算消耗上限 10 ACU；接近上限时停止并报告进度。

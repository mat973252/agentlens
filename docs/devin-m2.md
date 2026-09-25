# AgentLens M2 — Recorder 与 JSONL 导入

前提：以已独立验收的 M1 为基线。只实现 M2；不做 `runs`/`inspect`/`diff`、循环分析、Provider 适配、Replay、UI 或云服务。保持本地优先、Apache-2.0 和 Node `>=22.13` 版本承诺。

目标：提供不依赖 Agent Provider 的轻量 SDK Recorder，支持 `startRun()`、`emit()`、`completeRun()`、`failRun()`，生成并持久化符合 M1 Run/Event schema 的有序事件。提供 `agentlens import trace.jsonl`，将文档化的最小 JSONL 格式校验后写入既有 SQLite 存储；文件内容默认只在本机处理，不上传。JSONL 格式须明确区分 run 元信息与事件，保存事件顺序及 JSON 载荷原值，不静默改写或丢弃未知字段。

验收：独立 Demo Agent 从 `Run Start → Tool → Tool → Error → Tool → Complete` 产生完整 trace，经 Recorder 保存、SQLite 读取及 JSONL 导入后保留同样的 Run ID、事件顺序、parentId、时间、状态与数据。另验证失败运行 `failRun()`、无效调用顺序、非法 JSONL/缺失关联/不受支持版本、重复 Run ID；错误输入应明确失败，数据库不得留下半条导入。全新安装的 lint/test/build 和构建产物 CLI 帮助通过；README 给出最短的 SDK 与导入示例，并准确说明当前未实现的命令。

在已授权仓库的 `devin/m2-recorder-import` 分支提交并推送，报告完整 SHA、实际测试命令与结果、已知边界。完成 M2 后停下等待独立验收，不开始 M3、不直接改 main。计算消耗上限 10 ACU；接近上限时停止并报告进度。

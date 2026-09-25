# AgentLens M1 — Event Schema

前提：以经过独立验收的 M0 为基线。只实现 M1；不做 Recorder、CLI 导入、Inspect、Diff、Replay 或 UI。

目标：定义与 Provider 无关的 Run、AgentEvent、ToolCallEvent、RunMetrics，EventType 以 PROJECT.md 第 6–9 节为准。Zod 校验输入，SQLite 持久化和版本迁移使用直接 SQL，不引入 ORM。准备至少 10 份可重复使用的 fixture traces，覆盖成功、工具失败、重试、循环、超时和取消；必要时把 schema 约束与事件数据分开，避免工具输入输出被强制解释为 AgentLens 自身语义。保持本地数据默认不出机器，Apache-2.0 一致。

验收：全新安装后的 lint/test/build 通过；所有 fixture 都能写入、读取、序列化、反序列化并保持事件顺序与字段值；非法类型、缺失关联或不受支持的 schemaVersion 要给出明确失败，不静默丢事件。按真实命令给出测试结果、源码提交 SHA 与已知边界。

停止点：M1 完成后等待独立验收，不进入 M2，不创建额外服务、不发布。代码提交到已授权仓库的独立阶段分支，不能直接合并 main。控制本阶段计算消耗在 10 ACU 内，接近上限时报告并停止。

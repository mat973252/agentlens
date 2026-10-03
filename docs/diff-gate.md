# L2：显式 diff 门禁（当前源码）

目的：在已有 `diff A B` 上比较指定检查项，不从时间线变化推断业务成败，不新增 diff 算法。A 是用户显式选定的基线，B 是候选；调用方负责保证任务、模型、工具权限与采样条件可比。

先按 [README 的开发环境说明](../README.md#开发环境)构建当前源码，并从仓库根目录运行本地入口；公共 0.1.0 包不包含此门禁。

```bash
node dist/cli.js diff baseline candidate --db traces.db --json \
  --check status --check errors=0 --check inputTokens=100 --check durationMs=500
```

- `status`：要求基线为 passed；候选 passed 通过、failed 退化，running/cancelled 或非成功基线均为数据不足。
- `errors=N`：比较 `error` 和 `tool.failed` 事件总数，B−A 大于 N 才退化，列出两侧对应 event ID。它比较记录数，不推断错误根因；恢复过的错误也计数。
- `durationMs=N`、`inputTokens=N`、`outputTokens=N`、`reasoningTokens=N`、`toolCalls=N`、`failedToolCalls=N`：允许的最大绝对增量。N 必须是有限非负数字，等于阈值通过。用绝对增量避免零基线的百分比歧义。
- 耗时与普通 diff 一致，优先 recorded duration，否则用起止时间差。缺失或非法负时长为数据不足；不把缺失 tokens 填成零。不支持 cost，因为现有 schema 未记录成本。
- 数值及 errors 检查需要两侧运行都已 passed/failed；running/cancelled 不足以形成完整比较。

有任一明确退化时退出 2，仍保留同报告中的数据不足项；无退化但有数据不足时退出 3；全部指定项通过退出 0；输入、规则或数据库错误退出 1。重复检查项拒绝。没有 `--check` 时，保留原 diff 输出与退出语义。

JSON 门禁使用 `agentlens.diff-gate/1`，保留原 a/b/relayEvidence 字段并添加 gate。门禁不评价 Relay effect，运行成功不能把 UNKNOWN 改成 CONFIRMED。文本仍显示原 diff，再附检查结果。

验收：阈值边界/零基线、单侧缺失、running/cancelled、退化与缺失并存、输入错误；实际 CLI 退出码；数据库 hash/mtime 与旁文件不变；普通 diff 和 TUI 回归保持通过。之后补固定 before/after 证据包和独立用户观察，不能以门禁自测代替采用。

## 可重跑的固定证据包

构建后执行 `node examples/diff-gate-evidence.mjs`，或附加一个尚不存在的输出目录。脚本拒绝覆盖已有目录，执行真实本地 JSON 读取、已付款发票金额求和与断言；candidate 人为引入过期缓存查询和漏掉 paid 过滤的两处已知错误。所有数据为脚本内固定的合成订单，无模型调用、网络或个人资料。

输出 baseline/candidate JSONL、SQLite、普通 diff、门禁 JSON 以及 evidence.json。后者连接工具路径、耗时与实际 event ID，并记录输入/脚本及 dist JavaScript 文件哈希；导入前记录构建哈希，执行后复核一致。运行期间不要并发重建 dist；前后校验不是对恶意瞬时替换的防护。脚本逐项断言错误数0→2、调用数3→4、错误事件ID以及 tokens 缺失。状态和错误门禁真实返回 2；仅检查未记录 inputTokens 时真实返回 3。时间是本次本地观察值，不是性能结论；tokens/cost 没有记录，不能补成 0。此包可本地审阅，脚本不上传；若替换为业务 trace，分享前仍须检查载荷与身份信息。

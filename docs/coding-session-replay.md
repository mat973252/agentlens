# 用真实编码记录检查诊断边界

这是维护者对一次真实 Java 编码会话的事后回放。来源是 ctxpack 提交
`5d47695f885c38a503ca7fa125352c2cf7051522` 中的
`experiments/recovery/historical-coding-2026-10-03.json` 的 `modelSmoke`。
相邻 fixture 保存来源文件的 SHA256 和所选字段；没有复制原始路径、提示词、工具参数或输出正文。

在源码根目录执行（Node 22.13+）：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node examples/coding-session-replay.mjs
```

脚本打印新建临时目录，保存 SQLite 数据库、CLI inspect/summary、门禁 JSON 和来源摘要。
也可传入一个尚不存在的输出目录。它不调用模型、不执行原会话的工具、不联网。
当前公共包没有此未发布示例，请使用本地构建。

实际原会话包含 6 次读取、1 次修改、3 次测试：基线测试退出 1，修改后两次测试退出 0，
最后一次读取为重复读取。所有工具传输均成功，因此 `failedToolCalls=0`。
示例将非零测试退出码另映射为一个明确标记 `derived=true` 的 error，保留源调用索引与退出码；
这是回放者的诊断映射，不能说原始记录已经包含该 error 事件。

同一个来源生成两种投影：

| 投影 | 预期诊断 |
| --- | --- |
| `java-full` | 23 个事件，10 个工具结果，passed，1 个已恢复的派生错误信号 |
| `java-prefix` | 人为截于第六次工具调用的开始之后：12 个事件、5 个结果、1 个无结果的开始；running，没有 endedAt |

完整投影的 passed 来自维护者已接受的单次编码验收。前缀投影故意不完成 run，
并在关闭数据库后用独立 CLI 读取已落盘事件；它不声称原会话在此崩溃。
两个投影不是修改前后两个独立执行，不能用于计算质量提升或运行成本下降。

把输出的实际数据库路径代入：

```sh
node dist/cli.js inspect java-full --db PATH_TO_REPLAY_DB --summary
node dist/cli.js inspect java-prefix --db PATH_TO_REPLAY_DB --summary
node dist/cli.js diff java-full java-prefix --db PATH_TO_REPLAY_DB --json --check status --check toolCalls=0 --check errors=0 --check inputTokens=0
```

前两条退出 0 只表示能读取。最后一条退出 **3**，四项均为 `insufficient_data`；
未结束的较短记录不能冒充工具调用或错误减少。这次门禁因 running 提前判定不足，
不覆盖“两份已结束记录均缺 token”的分支；该分支可用现有 `examples/diff-gate-evidence.mjs` 独立验证。
原始记录没有 tokens/cost：三个 token 指标保持缺失，费用不在当前 RunMetrics 契约内，不能声称本例验收了费用门禁。
事件时间及 run duration 是本次回放写入时间；原始相对时间、工具耗时和人工审核等待另保留在 payload 中。
二者不得混作模型速度基准，也不能据此声称独立用户采用或实时 SDK 接入已经通过。

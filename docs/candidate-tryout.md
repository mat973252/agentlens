# 未发布候选的两次试用

早期门禁功能基线是源码提交 `6c43a19b36932fa6493f973d49ca0e9f0c9d3d81`；包含快照读取修复与真实会话回放的后续基线为 `f207732f413eb89feec18f71d0fd9bc63e3e4239`。包含这些修复的候选源码已在[草稿 PR #9](https://github.com/mat973252/agentlens/pull/9)公开，尚未发布为 npm 包。公共npm 0.1.0不能替代该源码；docs/examples也不在npm打包清单。

从空目录取得候选（需 Git），记录实际检出的完整提交；分支会随审阅更新：

```sh
git clone --branch mat/l1-durable-recording --single-branch https://github.com/mat973252/agentlens.git agentlens-candidate
cd agentlens-candidate
git rev-parse HEAD
```

接着在候选源码根目录执行（Node≥22.13，项目固定pnpm10.17.1）：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node examples/diff-gate-evidence.mjs
node examples/coding-session-replay.mjs
```

先进入展开后的项目根目录。Git检出可另执行`git rev-parse HEAD`；没有`.git`的ZIP跳过此命令，改核对维护者提供的“源码提交↔ZIP SHA256”映射。ZIP哈希本身不能独立证明Git提交身份；没有可信映射时记为来源未核验。安装必须包含devDependencies以获得构建工具，首次需要网络及可用corepack，源码ZIP不是离线二进制包。Windows中文路径建议使用已验证的Node24.19或Node22.23；记录实际`node --version`。

脚本打印新证据目录；父脚本成功退出0，内部CLI退化退出2、仅缺usage退出3是预期结果，不是安装失败。检查该目录的`diff.txt`、`gate.json`与`evidence.json`：基线通过，候选失败；错误数0→2、工具调用3→4，错误关联candidate-e3/e9；tokens未记录。若手工复查，使用`node dist/cli.js diff baseline candidate --db <证据目录>/traces.db --json --check status --check errors=0`。

本例都是合成数据和有意注入的故障。真实价值试用需由独立开发者选择自己的两次可比运行，事先选定检查项；先确认任务/模型/工具权限可比。第二次试用应是另一天或另一项实际任务，自行决定是否继续用，不以同一脚本连跑两次冒充留存。

JSON门禁给出检查结果，但当前不包含工具分布和时间线。要从“调用3→4”继续定位，先看文本diff，再读取候选事件（把占位路径换成脚本输出的实际路径）：

```sh
node dist/cli.js diff baseline candidate --db PATH_TO_EVIDENCE_DB --check toolCalls=0
node dist/cli.js inspect candidate --db PATH_TO_EVIDENCE_DB --json
```

第一条预期退出2，并显示`read-json`增加一次；第二条退出0，事件`candidate-e2`的输入指向`orders-cache.json`，其失败事件为`candidate-e3`。这能定位已记录的新增尝试，不自动证明它是最终失败的原因；另一次`verify-total`失败仍需单独查看。

第二个脚本则回放一次真实编码记录的完整与截断投影，预期23/12事件、passed/running和1个缺少结果的工具调用；内部比较门禁返回3，父脚本返回0。它仍是维护者事后演示，不是两次独立运行。来源、时间含义和缺失指标边界见[回放说明](coding-session-replay.md)。

每次只记录：日期、源码SHA/运行时、任务与比较目标、预设检查项、是否独立完成、卡点与维护者帮助、找到的错误event ID、结果是否改变下一步、下次是否仍想使用。参与者可用自选代号，不要求身份资料。维护者演示与独立使用分别标注；尚无人使用时填写“未测量”。

分享默认只给去敏的最小片段及版本/复现步骤。SQLite和JSONL可能含完整提示词、工具参数/返回值、身份、私有路径及凭据；不要直接上传真实库或压缩整个输出目录。哈希不是脱敏，也不证明可公开。合成包无需上传，脚本没有上传功能。

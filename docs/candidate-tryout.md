# 未发布候选的两次试用

本轮功能基线是源码提交 `6c43a19b36932fa6493f973d49ca0e9f0c9d3d81`。它尚未推送或发布，公共npm 0.1.0不能替代该源码；docs/examples也不在npm打包清单。需要维护者提供含该提交的仓库副本或源码包。拿不到源码应记录为交付阻碍，不继续使用旧包制造成功结果。

在收到的候选源码目录执行（Node≥22.13，项目固定pnpm10.17.1）：

```sh
git rev-parse HEAD
corepack pnpm install --frozen-lockfile
corepack pnpm build
node examples/diff-gate-evidence.mjs
```

无Git元数据的源码包应使用维护者提供的提交信息和SHA256核对表；不要自行填写未经核对的版本。Windows中文路径建议使用已验证的Node24.19或Node22.23；记录实际`node --version`。

脚本打印新证据目录；父脚本成功退出0，内部CLI退化退出2、仅缺usage退出3是预期结果，不是安装失败。检查该目录的`diff.txt`、`gate.json`与`evidence.json`：基线通过，候选失败；错误数0→2、工具调用3→4，错误关联candidate-e3/e9；tokens未记录。若手工复查，使用`node dist/cli.js diff baseline candidate --db <证据目录>/traces.db --json --check status --check errors=0`。

本例都是合成数据和有意注入的故障。真实价值试用需由独立开发者选择自己的两次可比运行，事先选定检查项；先确认任务/模型/工具权限可比。第二次试用应是另一天或另一项实际任务，自行决定是否继续用，不以同一脚本连跑两次冒充留存。

每次只记录：日期、源码SHA/运行时、任务与比较目标、预设检查项、是否独立完成、卡点与维护者帮助、找到的错误event ID、结果是否改变下一步、下次是否仍想使用。参与者可用自选代号，不要求身份资料。维护者演示与独立使用分别标注；尚无人使用时填写“未测量”。

分享默认只给去敏的最小片段及版本/复现步骤。SQLite和JSONL可能含完整提示词、工具参数/返回值、身份、私有路径及凭据；不要直接上传真实库或压缩整个输出目录。哈希不是脱敏，也不证明可公开。合成包无需上传，脚本没有上传功能。

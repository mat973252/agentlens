# AgentLens

面向 AI Agent 开发者的本地执行分析工具，先实现记录、查看和对比两次运行。核心是稳定的 Event Schema 与可解释的行为差异。

项目范围、CLI、技术栈与 M0–M7 里程碑见 [PROJECT.md](PROJECT.md)。目前仅建立项目文档与本地 Git 基线，代码开发由 Devin Cloud 按里程碑交付。

## 开发与验收

每次只执行一个里程碑。Devin 提供可取得的源码、测试命令与结果；维护者独立复核通过后，才进入下一阶段。进度记录见 [DELIVERY.md](DELIVERY.md)。

V0.1 以真实失败/成功运行的记录和 Diff 演示为发布门槛；项目目标指标在获得对照实验前只算目标，不算已达到的结果。

许可证：[Apache-2.0](LICENSE)。

## 开发环境

- Node.js >= 22（`.nvmrc` 为 22）
- pnpm 10（`packageManager` 字段固定；推荐 `corepack enable` 后使用 `corepack pnpm`）

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint       # Biome + tsc --noEmit
corepack pnpm test       # Vitest
corepack pnpm build      # tsup → dist/cli.js
node dist/cli.js --help  # 或 pnpm dev -- --help
```

M0 仅为项目骨架：CLI 帮助展示项目名与入口，计划命令（runs / show / inspect / diff）在后续里程碑实现，当前不对外提供。

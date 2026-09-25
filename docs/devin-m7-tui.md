# AgentLens M7 — 可打包的交互式 Node TUI

基线：已独立验收的 M6 `main`。本阶段由 Devin 编写全部产品代码，只实现本地交互式终端界面，不开始 Relay 接入、Web Dashboard、云服务、Replay 或新 Adapter。提交到 `devin/m7-tui` 后停在 M7，等待 Codex 独立验收。每阶段 10 ACU 上限，接近上限时停止并报告。

## 用户明确的视觉方向（2026-09-25）

- 可通过 Node 包安装运行的**可视化终端界面**，布局与信息密度参考 Claude Code TUI；不是仅给现有命令加颜色。
- 标志参考 [用户 GitHub 头像](https://github.com/mat973252)：深色圆形上的白色几何 `M` 与薄荷色圆点。普通终端用紧凑、可读的文字/字符标记表达，不依赖终端图片协议。
- 配色参考 [个人网站](https://mat973252.github.io/) 当日公开样式：`--ink: #142121`、`--paper: #fbf9f8`、`--mint: #83cebe`、`--muted: #61706b`，辅色 `#4aab96`。以深色终端适配这些色彩并保持对比度；真彩色不可用时提供 ANSI 降级，`NO_COLOR` 生效。网站的留白、细分隔线、清晰层级与紧凑标签可转译到终端；不照搬网页排版。
- 曾确认的 AgentPermit4j Playground 紧凑 Claude Code 风格 TUI 可作辅助布局参考。外部视觉只作为参考，不复制 Claude Code 品牌资产或源代码。

## 范围

- 增加 `agentlens ui --db <path>`（或等价的单一明确入口），从已发布 Node 包的 `bin` 直接启动；默认仍读取本地数据库，任何网络请求均非必需。
- 主视图优先呈现 Run A / Run B 对比；可浏览运行列表、状态/时间/指标摘要、详情时间线、工具输入输出与错误、Possible loops，并选择两次运行查看 Diff。未知指标继续显示 unknown，长内容可展开或滚动，不把截断文本误当完整数据。
- 键盘完整可用：上下/j/k、Enter、Tab 或明确切换键、Esc、q、Ctrl+C；屏幕内有键位提示。窄终端至少 80×24 可读，120×30 有清晰分栏。窗口 resize 后恢复布局，不吞键、不留下损坏的终端状态。
- 首阶段界面只读：打开、导航和退出前后，SQLite 文件 SHA-256 与 mtime 不变；缺失/损坏/未来 schema 数据库有明确错误，且不创建新库。非 TTY 环境给出可理解提示与非零退出，`--help` 始终可用。
- 保留 `runs`、`inspect`、`diff`、`import` 已验收 CLI 行为和 SDK API。不要使原有 JSONL 导入格式改变。

## 安装与验收

- 从全新检出冻结安装、lint、测试、构建；`npm pack` 或等价方式生成实际 npm 包，在仓库外空目录安装该 tarball，运行 `agentlens ui --help`、实际 TTY 启动和交互。不得依赖 `tsx`、仓库源码或 devDependencies。
- Windows Terminal 与 Ubuntu TTY 各跑一轮，检查 80×24、120×30、resize、中文/Unicode、NO_COLOR、ANSI 降级与 Ctrl+C 终端恢复。提供界面截图或终端录屏，并对照上述视觉令牌检查层级、密度、配色和 `M·` 标记。
- 导入 M6 Generic 与 Pi 成功/失败 fixture，再经 TUI 查阅和对比，所显示的状态、工具路径、错误、结果须与原有 CLI 一致；重复进入/退出不会改变数据库。
- README 说明安装、入口、键位、终端兼容性和只读边界。报告完整提交 SHA、测试与打包命令、截图路径、已知限制；只推送本里程碑分支，不直接修改 main 或开始 M8。

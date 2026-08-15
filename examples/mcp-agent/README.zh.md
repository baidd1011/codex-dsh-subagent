# DSH MCP Agent 示例

[English](README.md) | 中文

此组合通过 stdio MCP 向 Codex 暴露普通 DSH session。Codex 仍是主 Agent；每次委派都使用用户选择的 DSH 原生预设，拥有独立的 prompt、工具、agent loop、session 日志、压缩策略和可选的前台 DSH 子 Agent。Web profile 使用同一份原生预设名录和 3080 共享 runtime。

## 运行

在仓库根目录执行 `pnpm run demo:mcp-agent` 启动源码示例；安装发布后的 bin 包后，可使用等价命令 `dsh-mcp-agent --config examples/mcp-agent/cordis.yml`。可执行文件的 stdout 只承载 MCP 帧，诊断信息写入 stderr；它从启动环境或仓库 `.env` 读取 `DEEPSEEK_API_KEY`。

使用 `codex mcp add dsh-agent -- dsh-mcp-agent --config <绝对路径>/examples/mcp-agent/cordis.yml` 注册 stdio 示例。浏览器模式先设置 `DSH_MCP_TOKEN` 并启动 `dsh --profile web`，再使用 `codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN` 注册。

## 选择 DSH 会话

新委派前，Codex 先调用 `list_agent_presets()`，让用户从当前可挂载的原生预设中明确选择一个，再用选中的 `agentPreset`、绝对 `cwd` 和（需要时）`permissionPreset: 'workspace-write'` 等原生权限调用 `delegate_task`。默认权限为 `read-only`。续接只接受 `sessionId` 和任务文本，因此会话继续沿用原有预设、模型、思考等级、工作区和权限状态。

session 以 JSONL 保存在 `.sessions`。重启后可以用 `sessionId` 读取已完成或未完成的精确 MCP 轮次，但活跃 job 本身不跨进程恢复。Web 页面会显示 `Codex 子任务` 来源徽标，同时保留普通 DSH 对话的输入、停止、steer、模型、权限、重命名和分支能力。

## 模型体验

Codex 看到 `list_agent_presets`、`delegate_task`、`get_task`、`continue_task` 和 `cancel_task`。DSH 只看到选中的原生预设和普通任务 `user/message`；MCP 方法名、Codex 指令、历史、工具、reasoning 状态和 loop 状态不会进入 DSH 模型请求。

## 已知限制

- 此示例是 headless/stdio 入口；Web profile 另外提供绑定回环地址、Bearer 保护的 `/mcp/dsh-agent` Streamable HTTP 路由。远程 HTTP 和多客户端认证暂不包含。
- 活跃 job 不跨进程存活，但 DSH session 和最后一条精确 MCP 轮次会持久化。
- Codex 与 DSH 只有在调用方显式授权时共享文件系统根目录；二者不共享 session 或模型 provider 状态。

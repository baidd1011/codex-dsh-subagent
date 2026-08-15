# Codex DSH Subagent

[English](README.md) | 中文

Codex DSH Subagent 通过 MCP 把 Codex 连接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。Codex 与 GPT-5.6 继续担任主 Agent；每个委派任务都会成为一条普通 DSH 对话，使用用户选择的 DSH 原生预设、DeepSeek 模型、系统提示词、工具、Agent loop、session 历史、compaction、权限控制和可选的 DSH 子 Agent。

这套集成自动完成原本需要人工复制的流程：把 Codex 分配的任务粘贴到 DSH 新对话，等待 DSH 完成，再把结果复制回 Codex。Codex 与 DSH 不共享提示词、历史、工具、reasoning 状态或 loop 状态；MCP 只传递任务、工作区、所选预设、权限预设和结果。

本仓库基于 DeepSeek Harness，保留其插件架构、Web UI、CLI 与开发工具。项目目前处于开发者预览阶段，可能出现破坏兼容性的变更。

## 功能

- Codex 通过 `list_agent_presets` 实时读取 DSH 当前可用的预设。
- 用户选择 `standard`、`code`、`minimal`、`cordis` 等原生预设；集成层不创建专用 Agent 预设。
- `delegate_task` 在指定工作区创建并启动普通 DSH session。
- session 会在 DSH Web 页面实时出现并显示“Codex 子任务”来源徽标，同时保留页面的全部普通会话能力。
- Codex 通过 `get_task`、`continue_task` 和 `cancel_task` 查询、续接或取消精确的委派轮次。
- Host 重启后仍可读取 session。活跃 job 只存在于当前进程，已完成或未完成的结果与续接状态从持久化 DSH session 恢复。
- 保留用于 headless 场景的 stdio MCP 入口；推荐的本机集成方式是由 DSH Web 进程承载、带 Bearer Token 的 Streamable HTTP 入口。

## 环境要求

- Windows、macOS 或 Linux
- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.7.0`
- 支持 MCP 的 Codex CLI
- DeepSeek API Key

## 运行

### 从源码运行

```sh
git clone https://github.com/baidd1011/codex-dsh-subagent.git
cd codex-dsh-subagent
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install
pnpm run build
```

仓库不包含 API Key 或 MCP Token。请通过环境变量或 DSH 自带的凭据页面进行配置。

## 连接 Codex 与 DSH Web Host

Web 集成仅供本机使用。DSH Host 绑定 `127.0.0.1`，`/mcp/dsh-agent` 强制要求 Bearer Token。启动 DSH 和 Codex 的终端必须使用同一个 Token。

### 1. 启动 DSH

PowerShell：

```powershell
Set-Location C:\path\to\codex-dsh-subagent
$env:DEEPSEEK_API_KEY = "<your-deepseek-api-key>"
$env:DSH_MCP_TOKEN = "<a-random-local-token>"
$env:DSH_MCP_ALLOWED_ROOT = (Get-Location).Path
pnpm dsh web
```

Bash：

```sh
cd /path/to/codex-dsh-subagent
export DEEPSEEK_API_KEY='<your-deepseek-api-key>'
export DSH_MCP_TOKEN='<a-random-local-token>'
export DSH_MCP_ALLOWED_ROOT="$PWD"
pnpm dsh web
```

打开 `http://127.0.0.1:3080`。`DSH_MCP_ALLOWED_ROOT` 是 Codex 可以创建 DSH 任务的目录树；如果要委派其他项目，应将它设为所有目标工作区的共同父目录。

### 2. 在 Codex 注册 MCP 服务

打开另一个终端，设置同一个本地 Token。

PowerShell：

```powershell
$env:DSH_MCP_TOKEN = "<the-same-random-local-token>"
codex mcp remove dsh-agent
codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN
codex
```

Bash：

```sh
export DSH_MCP_TOKEN='<the-same-random-local-token>'
codex mcp remove dsh-agent
codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN
codex
```

如果此前没有注册过该服务，`codex mcp remove dsh-agent` 可能提示目标不存在；继续执行 add 命令即可。

### 3. 委派任务

向 Codex 发送：

```text
Use dsh-agent for this task. First call list_agent_presets and show me the available DSH modes. Ask me to choose one. Then call delegate_task with my selected agentPreset, an absolute cwd inside DSH_MCP_ALLOWED_ROOT, and permissionPreset read-only. Poll get_task with waitMs=60000 until the run reaches a terminal status. Report runId, sessionId, status, result, reason, and usage.

Task: Read package.json and summarize the repository without modifying files.
```

`delegate_task` 返回 `running` 时，新对话已经持久化并挂入对应的 DSH 工作区。页面可以继续发送消息、停止、切换模型或权限、重命名、移动、归档和分支。页面创建的分支是一条普通 DSH 对话，不会自动把结果返回 Codex。

## 权限

新委派默认使用 `read-only`。Codex 可以请求服务端允许的 `workspace-write` 等 DSH 原生权限预设。DSH 保持自己的审批语义，页面也可以查看或调整 session 权限。`continue_task` 会沿用 session 已有的预设、模型、思考等级、工作区和权限状态。

服务端会规范化请求路径，并强制要求其位于 `DSH_MCP_ALLOWED_ROOT` 内。该目录应尽量缩小。不要把 MCP 路由暴露到公网，也不要把本地 Bearer Token 当作互联网凭据复用。

## Headless stdio 模式

源码仓库还包含独立 MCP 组合：

```sh
pnpm run demo:mcp-agent
```

stdio 注册命令、配置字段、工具返回、生命周期与持久化规则参见 [MCP Agent 示例](examples/mcp-agent/README.md)和[服务端包参考](packages/mcp/mcp-agent-server/README.md)。

## 开发

```sh
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
pnpm run doc-sync
```

本项目是 pnpm monorepo。修改 package 前请先阅读 [AGENTS.md](AGENTS.md)、[开发指南](docs/development.md)和[架构文档](docs/architecture.md)。

## 上游与许可证

DeepSeek Harness 由 [DeepSeek AI](https://deepseek.com) 开发，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动。上游源码与社区支持位于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

本仓库使用 [MIT License](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

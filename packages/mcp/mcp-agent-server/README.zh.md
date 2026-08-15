# @deepseek-ai/dsh-mcp-agent-server

[English](README.md) | 中文

`mcp-agent-server` namespace 插件把 Codex 等外部调用自动映射成普通 DSH 会话。每次委派都从 DSH 已挂载的预设中选择一个，在指定工作区创建普通 session，提交一条普通用户消息，等待这一轮结束，再把结果返回。Codex 与 DSH 保持两套 prompt、历史、工具、loop、模型和压缩；MCP 只传递任务与结果。

## 组合

本插件要求组合中提供：

| 服务 | 作用 |
|---|---|
| `ctx.agents` | 创建和冷恢复普通 DSH Agent。 |
| `ctx.jobs` | 保存无 owner 的后台运行及取消控制器。 |
| `ctx.sessionPersistence` | 刷新和检查持久 session。 |
| `ctx.agentPresets` | 列出并挂载用户选择的原生预设。 |
| `ctx.agentDefaultModel` | 为新 session 提供当前 DSH 默认模型。 |
| `ctx.permissionPresets` | 为首轮应用原生沙箱与审批预设。 |

Web 入口（`@deepseek-ai/dsh-mcp-agent-server/web`）还需要 `ctx.webServer`、`ctx.workspaceRegistry` 和 `ctx.credentials`。它与浏览器运行在同一个 3080 Host 中，因此来源标记、工作区附加和首条任务 receipt 持久化后，`delegate_task` 才会返回。

插件不修改 `agent-loop`，不注册模型 provider，也不创建专用 Agent 预设。预设名录和默认模型服务由 DSH 自己负责。

## 配置

| 键 | 必填 | 描述 |
|---|---|---|
| `allowedRoots` | 是 | 非空的绝对、已存在目录；`cwd` 必须解析到其中之一。 |
| `allowedPermissionPresets` | 否 | 新委派允许使用的原生权限预设名；默认 `['read-only']`。 |
| `defaultPermissionPreset` | 否 | `delegate_task` 省略 `permissionPreset` 时使用；默认 `read-only`。 |
| `maxWaitMs` | 否 | 单次 `get_task.waitMs` 的上限；默认 `30000`。等待不会取消任务。 |
| `maxResultBytes` | 否 | 返回最终文本和 job 输出的 UTF-8 字节上限；默认 `65536`。 |

Web 入口还接受 `path`（默认 `/mcp/dsh-agent`）和 `authCredential`（默认 `DSH_MCP_TOKEN`）。每次请求都会解析凭据并要求 `Authorization: Bearer <token>`；token 不会写入 `cordis.yml` 或仓库。

服务器使用 `realpath` 规范化根目录和工作区，要求目标是目录并拒绝越出配置根的路径。权限名由 DSH 原生权限服务解析；续接不能替换 session 原有的预设、模型、思考等级、工作区或权限状态。

## MCP 工具

| 工具 | 结果 |
|---|---|
| `list_agent_presets()` | 实时读取可挂载的 DSH 预设，返回 id、本地化名称、描述、顺序和当前默认项。 |
| `delegate_task(task, cwd, agentPreset, permissionPreset?)` | 创建普通 DSH session，并在 session 发布、工作区附加和首条任务 receipt 持久化后返回 `{ runId, sessionId, status: 'running' }`。`agentPreset` 必填；权限默认 `read-only`。 |
| `get_task(runId \| sessionId, waitMs?)` | 必须且只能传一个 id。`runId` 只在当前进程有效；`sessionId` 重启后也能读取精确的 MCP 任务轮次。 |
| `continue_task(sessionId, task)` | 复用活跃 session 或冷恢复；沿用 session 的预设、模型、思考等级、工作区和原生权限。 |
| `cancel_task(runId)` | 取消当前 MCP 轮次并等待真实终态；普通 DSH session 仍保留给页面使用。 |

每个工具同时返回 JSON 文本块和相同的 `structuredContent` 对象。终态为 `completed`、`max-tokens`、`error`、`aborted` 或 `incomplete`；运行中结果不带最终文本。

## Web Host 与 Codex

随附的 Web profile 将 HTTP 入口挂在 `http://127.0.0.1:3080/mcp/dsh-agent`。允许根目录默认是 Web Host 启动时的精确工作目录；需要委派到其他位置时设置 `DSH_MCP_ALLOWED_ROOT`。在启动 Web Host 与 Codex 的环境中设置 `DSH_MCP_TOKEN`，然后注册：

```text
codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN
```

Codex 首次委派前应先调用 `list_agent_presets()`，让用户明确选择一个 id，再调用 `delegate_task`。生成的 session 就是普通 DSH 对话。侧栏依据不可见的持久来源事件显示“Codex 子任务”，但页面保留普通的输入、停止、steer、模型、思考、权限、重命名、移动、归档和分支能力。页面分支是没有 Codex 来源标记的普通 DSH session，不能通过原 sessionId 续接。

## 生命周期与持久化

每个 MCP run 写入任务开始标记、一条带 id 的 inbox 用户消息和任务结束标记。`get_task` 只截取这条消息对应的精确 turn，因此页面后续消息或 steer 不会覆盖原结果。结果选取该 turn 内最后一条非空根 `assistant/message`、对应的 `turn/end`，并汇总根 session 与本轮前台后代的 usage。未关闭的 turn 报告为 `incomplete`。run 完成后不释放普通 DSH Agent；有活跃 Agent 时续接直接复用，没有时按记录的预设冷恢复。传输关闭时停止新准入，取消插件持有的轮次，并等待 flush 与 job 结算。

## 模型体验

### 委派的用户消息

#### 模型看到什么

DSH 模型看到的是所选原生预设下的一条普通 `user/message`，以及 DSH 当前默认模型。MCP 方法名、Codex 系统指令、Codex 历史、Codex 工具、Codex reasoning 状态和 loop 状态不会注入该请求。因此页面看到的就是用户手动新建 DSH 对话时的同一套能力。

#### Token 影响

任务文本和所选预设消耗普通 DSH 输入 token。MCP 服务不会增加模型可见的提示词、上下文记录或工具定义。

#### KV Cache 影响

session 沿用所选预设的正常缓存行为。MCP 任务标记和 Codex 来源标记仅写入日志，不会改变模型请求前缀。

## 已知限制

- Web 路由只绑定回环地址并要求 token；远程 HTTP 和多客户端认证暂缓。
- 活跃 job 只在进程内。Host 重启后，可以用 `sessionId` 读取已持久化的 completed/incomplete 轮次，并用 `continue_task` 冷恢复普通 session。
- 带有 `origin: 'subagent'` 的旧 session 继续保持只读，不迁移；新 Codex session 不再写入这组元数据。

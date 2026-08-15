# @deepseek-ai/dsh-mcp-agent-demo

[English](README.md) | 中文

这是 DSH MCP 会话桥接的仅 bin 示例包。它负责 `dsh-mcp-agent` stdio 入口；运行时组合仍由外部 `cordis.yml` 持有，因此部署可以选择普通 DSH 预设、模型服务、持久化后端、沙箱和权限预设。

## Bin

```text
dsh-mcp-agent --config <absolute-path-to-cordis.yml>
```

bin 会加载可选 `.env`，启动指定的 Cordis 组合，将 stdout 保留给 MCP 帧，将诊断写入 stderr。stdin EOF、`SIGINT` 和 `SIGTERM` 会 dispose fiber，使插件能够取消 job、刷新 session 并释放传输。

完整组合和 Codex 注册命令见 [`examples/mcp-agent`](../../../examples/mcp-agent/README.md)。

五个 MCP 工具是 `list_agent_presets`、`delegate_task`、`get_task`、`continue_task` 和 `cancel_task`。委派出的 session 是普通 DSH 会话，仍可在 Web 页面输入新消息、steer 或停止、切换模型／思考等级／权限、重命名、移动、归档和分支。只有持久化来源标记和精确任务标记用于识别 Codex 创建的任务；它们不会限制页面能力。

## 模型体验

### 委派的 DSH 轮次

#### 模型看到什么

模型看到用户选择的 DSH 原生预设，以及作为普通 `user/message` 进入 session 的委派任务。桥接不会注入 Codex 提示词、历史、工具 schema、reasoning 状态、loop 状态或 MCP 方法名，也不会创建专用 worker 预设或固定模型与思考等级。

#### Token 影响

委派任务和所选 DSH 预设的 token 成本与手动创建普通 DSH 对话相同。本包不增加模型可见的提示词或工具 schema。

#### KV Cache 影响

缓存行为与普通 DSH session 相同。所选预设建立请求前缀；后续轮次在预设、模型可见上下文和 provider 路由不变时复用该前缀。

## 已知限制与暂缓事项

- 这个可执行文件支持 stdio MCP；Web bundle 提供托管在 Web Host 上的 Streamable HTTP 入口，并共享相同的运行语义。
- 必须显式传入配置路径，避免主 Agent 意外启动另一个工作区的组合。

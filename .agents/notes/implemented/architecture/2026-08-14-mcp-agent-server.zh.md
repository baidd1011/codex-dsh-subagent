# Agent Note: External DSH sessions use MCP automation

Status: implemented

[English](2026-08-14-mcp-agent-server.md) | 中文

## Problem

Codex 是主 Agent，而 DSH 必须保持完整独立的运行时，拥有自己的 prompt、工具、loop、session、持久化和压缩。把 DeepSeek 当作 Codex 的另一个 provider，或复制主 session，会抹掉这条边界，并使权限与恢复变得含糊。委派出的对话应与页面手动打开的 DSH 对话相同，而不是受限的 worker 面板。

## Decision

`@deepseek-ai/dsh-mcp-agent-server` 是 namespace function plugin。它通过 stdio 和 Web Host 托管的 Streamable HTTP 子路径暴露 `list_agent_presets`、`delegate_task`、`get_task`、`continue_task` 和 `cancel_task`。两个传输共用一个任务 runtime；Web 请求还会在返回 `running` 前，把已发布的 session 附加到规范化 cwd 对应的精确工作区。Codex 必须传入用户选择的现有 DSH 预设；插件只记录普通的 `cwd` 与 `agentPreset` 元数据，并追加一个只供页面展示和 MCP 所有权校验使用的不可见 `session/source: codex` 标记。首轮应用原生权限预设，并启动一个无 owner 的 `ctx.jobs` run。复制进 DSH 日志的主 Agent 输入只有任务文本。

run id 是进程内 branded handle；session id 是持久 handle。一个 session 同时最多一个活动 MCP run；workspace-write run 按规范化工作区互斥，read-only run 可以并行。每个 run 都有绑定单条用户消息 id 与精确 `turn/end` 的持久开始／结束标记，因此页面后续消息和 steer 不会覆盖它的结果。终态 MCP run 完成后仍保留活跃 Agent；续接优先复用它，不存在时才按持久预设恢复。已写入 completed `turn/end` 后才收到的取消会保留 completed 结果，而不会改写成 aborted。传输 dispose 会先关闭准入，再取消并等待插件持有的全部 run。

示例组合将 MCP server 与 DSH 主干分开：DeepSeek adapter、agent loop、JSONL 持久化、checkpoint、compaction、sandbox、文件系统工具和前台 subagent 都是 `examples/mcp-agent` 中的普通 DSH 插件。示例为 headless 提供 DSH 默认模型，但 MCP 插件不固定 provider、模型、思考等级或预设。Codex prompt、历史、工具 schema、reasoning 和 loop 状态不会跨过 MCP 边界。

## Alternatives considered

**共享 session 或事件双向投影** 被拒绝，因为它会让两个产品共同拥有一个 loop，并可能把主 Agent 历史或工具 schema 变成子 Agent 模型输入。

**Codex plugin 或 DeepSeek provider adapter** 被拒绝，因为要求的子 Agent 必须保留 DSH 的 system-prompt 与 agent-loop 组合，而不是在主 Agent 内部变成一个模型路由。

**长期实验性 exec-server 桥接** 暂缓。v1 使用持久 DSH session 和显式 continuation，更容易验证任务边界；未来传输可以复用相同的工具与 session 约定。

## Consequences

MCP 接口仅限本机：stdio 适合 headless 使用，Web 入口绑定 `127.0.0.1`，每次请求解析 `DSH_MCP_TOKEN`，并通过现有浏览器 mux 发布普通 session。Web profile 默认把委派限制在进程 cwd；需要扩大范围时，`DSH_MCP_ALLOWED_ROOT` 必须指定显式绝对根目录。Web UI 用不可见来源标记显示“Codex 子任务”，只隐藏真正嵌套的 subagent，普通 session 的输入、停止、steer、model、权限、重命名、移动、归档和 fork 全部可用。页面分支没有 Codex 标记，也不能被原 MCP id 续接；旧的 `origin: subagent` 根 session 继续保持旧只读行为。活动 job 仅在进程内；精确 MCP 轮次和 continuation 可以跨进程保留。因为 Codex 与 DSH 共享文件但不共享 session，workspace-write 运行结束后主 Agent 必须检查实际 diff。

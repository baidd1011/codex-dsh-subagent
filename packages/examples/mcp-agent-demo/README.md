# @deepseek-ai/dsh-mcp-agent-demo

English | [中文](README.zh.md)

Bin-only example package for the DSH MCP session bridge. It owns the `dsh-mcp-agent` stdio entry point; the runtime composition remains in an external `cordis.yml`, so a deployment can choose its normal DSH presets, model service, persistence backend, sandbox and permission presets.

## Bin

```text
dsh-mcp-agent --config <absolute-path-to-cordis.yml>
```

The bin loads the optional `.env`, boots the requested Cordis composition, reserves stdout for MCP frames, and sends diagnostics to stderr. stdin EOF, `SIGINT`, and `SIGTERM` dispose the fiber so the plugin can cancel jobs, flush sessions and release its transport.

Use [`examples/mcp-agent`](../../../examples/mcp-agent/README.md) for the shipped composition and Codex registration command.

The five MCP tools are `list_agent_presets`, `delegate_task`, `get_task`, `continue_task` and `cancel_task`. A delegated session is an ordinary DSH session that may remain open in the Web UI: users can send messages, steer or stop it, change model/reasoning/permissions, rename or move it, archive it and fork it. Only a persisted source marker and exact task markers identify the Codex-created turn; the marker is not a capability restriction.

## Model Experience

### Delegated DSH turn

#### What the model sees

The model sees the selected native DSH preset and the delegated task as an ordinary `user/message`. The bridge does not inject the Codex prompt, history, tool schemas, reasoning state, loop state, or MCP method names, and it does not create a special worker preset or fix a model and reasoning level.

#### Token effect

The delegated task and selected DSH preset have the same token cost as a manually created DSH conversation. This package adds no model-visible prompt or tool schema.

#### KV Cache effect

Cache behavior matches a normal DSH session. The selected preset establishes the request prefix; later turns reuse that prefix when the preset, model-visible context, and provider route remain unchanged.

## Known Limitations and Deferred Work

- This executable supports stdio MCP. The Web-hosted Streamable HTTP entry is provided by the Web bundle and shares the same runtime semantics.
- It requires an explicit config path so the parent cannot accidentally boot a different workspace composition.

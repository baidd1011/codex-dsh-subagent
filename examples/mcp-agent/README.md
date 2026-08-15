# DSH MCP agent example

English | [中文](README.zh.md)

This composition exposes ordinary DSH sessions to Codex through stdio MCP. Codex remains the parent Agent, while every delegated turn gets its own selected DSH preset, prompt, tools, loop, session log, compaction policy and optional foreground DSH subagent. The Web profile uses the same native roster and shared runtime at 3080.

## Run

From the repository root, start the source example with `pnpm run demo:mcp-agent`. After installing the published bin package, the equivalent command is `dsh-mcp-agent --config examples/mcp-agent/cordis.yml`. The executable keeps stdout exclusively for MCP frames and sends diagnostics to stderr. It reads `DEEPSEEK_API_KEY` from the launching environment or the repository `.env`.

Register the stdio example with Codex using `codex mcp add dsh-agent -- dsh-mcp-agent --config <absolute-path-to>/examples/mcp-agent/cordis.yml`. For the browser-hosted route, set `DSH_MCP_TOKEN`, start `dsh --profile web`, and register `codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN`.

## Choosing a DSH session

Before a new delegation, Codex calls `list_agent_presets()` and asks the user to choose one of the currently mountable native presets. It then calls `delegate_task` with the selected `agentPreset`, an absolute `cwd`, and (when needed) `permissionPreset: 'workspace-write'` or another configured native permission. The default is `read-only`. Continuation accepts only `sessionId` and task text, so the session keeps its preset, model, reasoning level, workspace and permission state.

The session is stored as JSONL under `.sessions`. A completed or incomplete turn can be read by `sessionId` after restart; active jobs themselves are process-local. The Web page shows a `Codex 子任务` source badge, but the session is an ordinary DSH conversation with normal input, stop, steer, model, permission, rename and fork controls.

## Model experience

Codex sees `list_agent_presets`, `delegate_task`, `get_task`, `continue_task`, and `cancel_task`. DSH sees only its selected native preset and the ordinary task `user/message`; MCP method names, Codex instructions, history, tools, reasoning state and loop state do not enter the DSH model request.

## Known limitations

- This example is the headless/stdio entry; the Web profile adds a loopback, Bearer-protected Streamable HTTP route at `/mcp/dsh-agent`. Remote HTTP and multi-client authentication are outside v1.
- Active jobs do not survive process restart. The durable DSH session and its exact last MCP turn do.
- Codex and DSH share a filesystem root only when the caller explicitly grants it; they never share a session or model-provider state.

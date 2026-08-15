# Codex DSH Subagent

English | [中文](README.zh.md)

Codex DSH Subagent connects Codex to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through MCP. Codex and GPT-5.6 remain the parent Agent. Every delegated task becomes an ordinary DSH conversation that runs with a user-selected native DSH preset, DeepSeek model, system prompt, tools, Agent loop, session history, compaction, permission controls, and optional DSH subagents.

The integration automates the manual workflow of copying a task from Codex into a new DSH conversation and copying the answer back. Codex and DSH do not share prompts, histories, tools, reasoning state, or loop state. MCP carries the task, workspace, selected preset, permission preset, and result.

This repository is based on DeepSeek Harness and retains its plugin architecture, Web UI, CLI, and development tooling. It is currently a developer preview and may introduce compatibility-breaking changes.

## What works

- Codex can discover the DSH presets currently available through `list_agent_presets`.
- A user selects a native preset such as `standard`, `code`, `minimal`, or `cordis`; the integration does not create a separate Agent preset.
- `delegate_task` creates and starts a normal DSH session in the selected workspace.
- The session appears in the DSH Web UI with a `Codex subtask` source badge and remains fully usable from the page.
- Codex can poll, continue, or cancel its exact delegated turn through `get_task`, `continue_task`, and `cancel_task`.
- Session data survives a Host restart. Active jobs remain process-local, while completed or incomplete results and continuation state are recovered from the persisted DSH session.
- The stdio MCP entry remains available for headless use; the recommended local integration uses the token-protected Streamable HTTP endpoint hosted by the DSH Web process.

## Requirements

- Windows, macOS, or Linux
- Node.js `^22.19.0` or `>=24.0.0`
- pnpm `11.7.0`
- Codex CLI with MCP support
- A DeepSeek API key

## Run

### Run from source

```sh
git clone https://github.com/baidd1011/codex-dsh-subagent.git
cd codex-dsh-subagent
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install
pnpm run build
```

The repository does not contain API keys or MCP tokens. Supply them through the environment or the normal DSH credentials UI.

## Connect Codex to the DSH Web Host

The Web integration is local-only. The DSH Host binds to `127.0.0.1`, and `/mcp/dsh-agent` requires a Bearer token. Use the same token in the terminal that starts DSH and the terminal that starts Codex.

### 1. Start DSH

PowerShell:

```powershell
Set-Location C:\path\to\codex-dsh-subagent
$env:DEEPSEEK_API_KEY = "<your-deepseek-api-key>"
$env:DSH_MCP_TOKEN = "<a-random-local-token>"
$env:DSH_MCP_ALLOWED_ROOT = (Get-Location).Path
pnpm dsh web
```

Bash:

```sh
cd /path/to/codex-dsh-subagent
export DEEPSEEK_API_KEY='<your-deepseek-api-key>'
export DSH_MCP_TOKEN='<a-random-local-token>'
export DSH_MCP_ALLOWED_ROOT="$PWD"
pnpm dsh web
```

Open `http://127.0.0.1:3080`. `DSH_MCP_ALLOWED_ROOT` is the directory tree in which Codex may create DSH tasks; set it to the parent of every workspace you intend to delegate into.

### 2. Register the MCP server in Codex

Open another terminal and set the same local token.

PowerShell:

```powershell
$env:DSH_MCP_TOKEN = "<the-same-random-local-token>"
codex mcp remove dsh-agent
codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN
codex
```

Bash:

```sh
export DSH_MCP_TOKEN='<the-same-random-local-token>'
codex mcp remove dsh-agent
codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN
codex
```

If no previous registration exists, `codex mcp remove dsh-agent` may report that the server is absent; continue with the add command.

### 3. Delegate a task

Give Codex this instruction:

```text
Use dsh-agent for this task. First call list_agent_presets and show me the available DSH modes. Ask me to choose one. Then call delegate_task with my selected agentPreset, an absolute cwd inside DSH_MCP_ALLOWED_ROOT, and permissionPreset read-only. Poll get_task with waitMs=60000 until the run reaches a terminal status. Report runId, sessionId, status, result, reason, and usage.

Task: Read package.json and summarize the repository without modifying files.
```

When `delegate_task` returns `running`, the new conversation is already persisted and attached to the matching workspace in the DSH Web UI. The page can send messages, stop the turn, change the model or permission preset, rename, move, archive, and fork the conversation. A fork created from the page is an ordinary DSH conversation and is not automatically returned to Codex.

## Permissions

New delegations default to `read-only`. Codex may request an allowed native DSH permission preset such as `workspace-write`. DSH keeps its normal approval behavior, and the Web page can inspect or change the session permission. `continue_task` retains the session's existing preset, model, reasoning level, workspace, and permission state.

`DSH_MCP_ALLOWED_ROOT` is enforced by the server after canonicalizing the requested path. Keep it as narrow as practical. Do not expose the MCP route to a public network or reuse the local Bearer token as an Internet credential.

## Headless stdio mode

The source checkout also includes a standalone MCP composition:

```sh
pnpm run demo:mcp-agent
```

See the [MCP Agent example](examples/mcp-agent/README.md) and the [server package reference](packages/mcp/mcp-agent-server/README.md) for the stdio registration command, configuration fields, tool responses, lifecycle, and persistence rules.

## Development

```sh
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
pnpm run doc-sync
```

The repository is a pnpm monorepo. Read [AGENTS.md](AGENTS.md), the [development guide](docs/development.md), and the [architecture documentation](docs/architecture.md) before changing packages.

## Upstream and license

DeepSeek Harness is developed by [DeepSeek AI](https://deepseek.com) and powered by [Cordis](https://github.com/cordiverse/cordis). Upstream source and community support remain at [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

This repository is licensed under the [MIT License](LICENSE). Third-party dependencies and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

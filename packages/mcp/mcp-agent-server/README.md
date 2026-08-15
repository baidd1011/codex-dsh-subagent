# @deepseek-ai/dsh-mcp-agent-server

English | [中文](README.zh.md)

The `mcp-agent-server` namespace plugin automates ordinary DSH sessions for an external caller such as Codex. A delegation selects one of the presets already mounted by DSH, creates a normal session in the requested workspace, submits one ordinary user message, waits for that turn, and returns the result. Codex and DSH keep separate prompts, histories, tools, loops, models, and compaction; MCP carries only the task and result.

## Composition

Load this plugin in a composition that provides:

| Service | Role |
|---|---|
| `ctx.agents` | Creates and cold-resumes the ordinary DSH Agent. |
| `ctx.jobs` | Holds the unowned background run and cancellation controller. |
| `ctx.sessionPersistence` | Flushes and inspects durable sessions. |
| `ctx.agentPresets` | Lists and mounts the user-selected native preset. |
| `ctx.agentDefaultModel` | Supplies the current DSH model default for a fresh session. |
| `ctx.permissionPresets` | Applies the native sandbox and approval preset selected for the first turn. |

The Web entry (`@deepseek-ai/dsh-mcp-agent-server/web`) additionally requires `ctx.webServer`, `ctx.workspaceRegistry`, and `ctx.credentials`. It runs in the same 3080 Host as the browser, so the source marker, workspace attachment, and first task receipt are persisted before `delegate_task` returns.

The plugin does not change `agent-loop`, register a model provider, or create a special Agent preset. The configured DSH roster and default model service remain the source of truth.

## Config

| Key | Required | Description |
|---|---|---|
| `allowedRoots` | yes | Non-empty absolute existing directories. `cwd` must resolve inside one of them. |
| `allowedPermissionPresets` | no | Native permission preset names accepted by new delegations; defaults to `['read-only']`. |
| `defaultPermissionPreset` | no | Permission used when `delegate_task` omits `permissionPreset`; defaults to `read-only`. |
| `maxWaitMs` | no | Upper bound for one `get_task.waitMs`; defaults to `30000`. Waiting never cancels. |
| `maxResultBytes` | no | UTF-8 byte limit for returned final text and job output; defaults to `65536`. |

The Web entry also accepts `path` (default `/mcp/dsh-agent`) and `authCredential` (default `DSH_MCP_TOKEN`). It resolves the credential for every request and requires `Authorization: Bearer <token>`; the value is never written to `cordis.yml` or the repository.

The server canonicalizes roots and workspaces with `realpath`, requires directories, and rejects traversal outside the configured roots. Permission names are resolved by the native DSH permission service. A continuation cannot replace the session's preset, model, reasoning level, workspace, or permission state.

## MCP tools

| Tool | Result |
|---|---|
| `list_agent_presets()` | Reads the live mountable DSH roster and returns ids, localized names, descriptions, order, and the current default. |
| `delegate_task(task, cwd, agentPreset, permissionPreset?)` | Creates a normal DSH session and returns `{ runId, sessionId, status: 'running' }` after publication, workspace attachment, and the first durable task receipt. `agentPreset` is required; permission defaults to `read-only`. |
| `get_task(runId \| sessionId, waitMs?)` | Accepts exactly one id. A run id is process-local; a session id also reads the exact persisted MCP turn after restart. |
| `continue_task(sessionId, task)` | Reuses a live session or cold-resumes it. The session's preset, model, reasoning level, workspace, and native permission state are retained. |
| `cancel_task(runId)` | Cancels one active MCP turn and waits for the real terminal result. The ordinary DSH session remains available to the page. |

Every tool returns both a JSON text block and the same `structuredContent` object. Terminal status is one of `completed`, `max-tokens`, `error`, `aborted`, or `incomplete`; a running result has no final text.

## Web Host and Codex

The shipped Web profile mounts the HTTP entry at `http://127.0.0.1:3080/mcp/dsh-agent`. Its allowed root defaults to the exact directory from which the Web Host starts; set `DSH_MCP_ALLOWED_ROOT` to an explicit absolute directory when Codex must delegate elsewhere. Set `DSH_MCP_TOKEN` in the environment that launches both the Web Host and Codex, then register the endpoint:

```text
codex mcp add dsh-agent --url http://127.0.0.1:3080/mcp/dsh-agent --bearer-token-env-var DSH_MCP_TOKEN
```

Codex should call `list_agent_presets()` and ask the user to choose an id before the first `delegate_task`. The resulting session is a normal DSH conversation. The sidebar marks it with the invisible persisted source event as `Codex subtask` (`Codex 子任务`), but the page keeps its normal input, stop, steer, model, reasoning, permission, rename, move, archive, and fork controls. A page-created fork is an ordinary DSH session without the Codex source marker and cannot be continued through the original MCP session id.

## Lifecycle and durability

Each MCP run has one durable task-start marker, one identified inbox user message, and a task-end marker. `get_task` slices that exact message's turn, so later page messages or steers cannot replace its result. The result selects the last non-empty root `assistant/message`, the matching `turn/end`, and usage from the root plus foreground descendants during that turn. An open turn is reported as `incomplete`. The live Agent is retained after the run; continuation reuses it when present and cold-resumes the recorded preset when absent. Transport close stops admission, cancels plugin-owned turns, and waits for their flush and job settlement.

## Model Experience

### Delegated user message

#### What the model sees

The DSH model sees an ordinary `user/message` under the selected native preset and current DSH model default. MCP method names, Codex system instructions, Codex history, Codex tools, Codex reasoning state, and Codex loop state are not inserted into that request. The DSH page therefore shows and controls the same conversation a user would have created manually.

#### Token effect

The task text and selected preset consume the normal DSH input tokens. The MCP server contributes no model-visible prompt, context record, or tool definition.

#### KV Cache effect

The session follows the selected preset's normal cache behavior. MCP task markers and the Codex source marker are log-only and cannot change the model request prefix.

## Known Limitations and Deferred Work

- The Web route is loopback-bound and token-protected; remote HTTP and multi-client authentication are deferred.
- Active jobs are process-local. After a Host restart, a persisted completed or incomplete turn can be read by `sessionId`, and `continue_task` can cold-resume the ordinary session.
- Legacy sessions carrying `origin: 'subagent'` remain observation-only and are not migrated. New Codex sessions do not carry that metadata.

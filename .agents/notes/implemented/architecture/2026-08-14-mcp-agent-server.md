# Agent Note: External DSH sessions use MCP automation

Status: implemented

English | [中文](2026-08-14-mcp-agent-server.zh.md)

## Problem

Codex is the parent Agent, while DSH must remain a complete independent runtime with its own prompt, tools, loop, session, persistence and compaction. Treating DeepSeek as another Codex provider or copying the parent session would erase that boundary and make permissions and recovery ambiguous. The delegated conversation must behave like a DSH conversation opened from the page, rather than like a restricted worker pane.

## Decision

`@deepseek-ai/dsh-mcp-agent-server` is a namespace function plugin. It exposes `list_agent_presets`, `delegate_task`, `get_task`, `continue_task`, and `cancel_task` through stdio and through a Streamable HTTP subpath hosted by the Web Host. Both transports share one task runtime; Web requests additionally attach the published session to the exact normalized cwd workspace before returning `running`. Codex must pass a user-selected existing DSH preset; the plugin records only ordinary `cwd` and `agentPreset` metadata, plus an invisible `session/source: codex` marker for UI display and MCP ownership checks. It applies the native permission preset for the first task and starts an unowned `ctx.jobs` run. The task text is the only parent input copied into the DSH log.

Run ids are process-local branded handles; session ids are durable handles. A session has at most one active MCP run, workspace-write runs are exclusive per canonical workspace, and read-only runs may run in parallel. Each run has durable start/end markers tied to one user-message id and exact `turn/end`, so later page messages and steers cannot replace its result. The live Agent remains available after a terminal MCP run; continuation reuses it when present and otherwise resumes the persisted preset. A cancellation received after a completed `turn/end` preserves the completed result instead of replacing it with an aborted status. Transport disposal closes admission before cancelling and awaiting plugin-owned runs.

The example composition keeps the MCP server separate from the DSH spine: the DeepSeek adapter, agent loop, JSONL persistence, checkpoint, compaction, sandbox, filesystem tool and foreground subagent are ordinary DSH plugins in `examples/mcp-agent`. The example supplies a DSH default model for headless use, but the MCP plugin does not pin a provider, model, reasoning level or preset. No Codex prompt, history, tool schema, reasoning state or loop state crosses the MCP boundary.

## Alternatives considered

**A shared session or event projection** was rejected because it makes the two products co-own one loop and allows parent history or tool schemas to become child model input.

**A Codex plugin or a DeepSeek provider adapter** was rejected because the requested child must retain DSH's system-prompt and agent-loop composition, not become a model route inside the parent.

**A long-lived experimental exec-server bridge** was deferred. The v1 task boundary is easier to validate with durable DSH sessions and explicit continuation; a future transport can reuse the same tool and session contracts.

## Consequences

The MCP surface is local-only: stdio is suitable for headless use, while the Web endpoint binds `127.0.0.1`, resolves `DSH_MCP_TOKEN` per request and publishes ordinary sessions to the existing browser mux. The Web profile confines delegation to the process cwd unless `DSH_MCP_ALLOWED_ROOT` names an explicit absolute root. The Web UI keeps the invisible source marker as a `Codex subtask` sidebar badge, hides only true nested subagent children, and leaves ordinary input, stop, steer, model, permission, rename, move, archive and fork controls enabled. A page-created fork has no Codex marker and cannot be continued by the original MCP id. Legacy `origin: subagent` roots keep their old read-only behavior. Active jobs are process-local, while exact persisted MCP turns and continuation survive restart. The parent must inspect the actual workspace diff after a workspace-write run because Codex and DSH share files without sharing a session.

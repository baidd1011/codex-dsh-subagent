# Codex delegation example

Use the DSH MCP server when a task benefits from an ordinary DSH session with its own prompt, tools and loop.

```text
Call list_agent_presets first and ask the user to choose an existing DSH preset. Then use delegate_task with the smallest existing absolute workspace root, the selected agentPreset, and the default read-only permissionPreset for investigation. Request workspace-write only for a new task that must edit files. While a workspace-write DSH task is running, do not modify the same file range from Codex. After get_task reports a terminal state, inspect the actual diff and run the relevant tests before presenting the result. Use continue_task with the returned sessionId when the delegated session needs a follow-up; do not pass a new cwd, preset, model, or permission on continuation.
```

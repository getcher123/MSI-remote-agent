# Native, PowerShell and WSL processes

Use `start_process` with an allowlisted executable and separate `args`. Select `runtime=native` for the host process runtime (`windows` remains a compatible legacy value) and `runtime=wsl` only when WSL is configured. On Windows, `powershell.exe` and `pwsh.exe` run PowerShell when installed and permitted. This API uses pipes, not a PTY or graphical terminal.

## Launch and follow output

1. Verify the task, target device, runtime, executable and working directory.
2. Prefer an executable plus argument array to shell concatenation. Shell code still requires careful quoting and the same user authorization.
3. Use `intent=read` for inspection; use `intent=write` and `confirm_mutation=true` when changing state.
4. Save the returned `session_id`. Read `process_output` using the returned stdout/stderr cursors; observe truncation, base offsets, `lost_chars` and `has_more`.
5. Use `process_input` only for an authorized interaction with that same session and set `confirm_mutation=true`.
6. Verify the process exit code and the actual task result. A session ID proves a launch was tracked, not that the command succeeded.

Do not expose secrets through command-line arguments or stdout. The agent removes its tunnel key from child environments but does not promise exhaustive secret filtering.

## Stop only owned work

Use `list_process_sessions` to inspect the current instance's sessions. Stop only a session started by this agent with `terminate_process` and `confirm_mutation=true`. Begin with `force=false`; do not silently escalate a failed soft stop to force. Inspect `termination_confirmed`, exit evidence and, for WSL, tree/group evidence.

Do not kill by process name, guess a PID, or shut down a WSL distribution to stop one task. Detached descendants in another session and sessions from a previous agent process are outside the in-memory ownership guarantee.

Before restarting the agent, finish or reconcile its processes. Internal MCP protocol children are managed through the local MCP route; they are not public terminal sessions.

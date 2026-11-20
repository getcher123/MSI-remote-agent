# Changelog

Changes are grouped by source version. A version in this file does not imply that a machine has been upgraded or that a release archive has been published.

## 0.3.1 — Codex delivery recovery

- Accept a caller-saved `operation_id` before the first `codex_send_message` call and persist its receipt before script validation or the first IPC preflight. A preflight timeout now leaves a recoverable result.
- Bind the ID to the exact UUID, title, cwd and message hash. Repeated or concurrent use of the same ID returns its saved result; conflicting reuse is rejected. Preserve legacy receipt lookup and text/target deduplication.
- Read delivery status by operation or receipt ID. Return persisted progress during an active dispatch, support explicit cached reads with `refresh=false` and live reconciliation with `refresh=true`, and never replay an unknown result.
- Record delivery phases and bounded error metadata. Preserve unresolved receipts, foreign locks and retained drafts; require one new complete exact user turn with a valid send timestamp to confirm delivery. Normalize only CRLF to LF in observed text while retaining the original message hash.
- Limit UI messages to 32768 UTF-8 bytes and document paired adapter discovery/read limits. External scripts and configured SHA values require a separate compatible update.
- Keep stdio handshake, `ping`, `tools/list` and operation-status reads responsive during long tools. Preserve serialized execution of ordinary tool calls and include safe operation metadata in errors.
- Add synthetic regressions for response loss, faults before and after UI dispatch, concurrent IDs, journal failures, lock ownership and strict delivery correlation.

The external tunnel HTTP 409 was not reproduced or established as fixed. Windows, WSL, desktop UI and live tunnel acceptance remain separate target-environment checks; this source change does not install an update on a machine.

## 0.3.0 — public source baseline

- CMD launchers reset the child PowerShell module search path to avoid inherited PowerShell 7 modules breaking Windows PowerShell 5.1.
- Uninstall preserves the installation when owned-process shutdown cannot be verified and reports removal failures.

- Replace machine-specific defaults with portable first-run configuration.
- Make WSL and Codex Connect optional for the core agent.
- Add the portable `native` process runtime while retaining the legacy `windows` value.
- Require the current SHA when replacing an existing file through `write_file`.
- Publish reusable documentation, contributor routes, operator skill and development roadmap.
- Add public-package validation and privacy checks to the development workflow.
- Preserve structured file tools, owned process control, exact-target Codex workflows and the direct local MCP bridge.
- Exclude deployment state, machine configuration, private evidence and historical work logs from the public source.

## Earlier implementation history

The 0.2.x implementation introduced direct local MCP registration, supported stdio and Streamable HTTP transports, durable operation receipts and native MCP content forwarding. The earlier core provided file/process tools and a wrapper around a separately installed Codex Connect adapter.

Private deployment reports and machine-specific package snapshots are not part of this public repository.

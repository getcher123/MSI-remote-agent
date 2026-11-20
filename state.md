# Development state

## Current source version

The current source version is **0.3.1**, based on the portable 0.3.0 public baseline. WSL and Codex Connect remain optional; structured file/process tools and the direct local MCP bridge remain available.

This file describes repository development. It is not an inventory of installed machines and is not proof that a production deployment has been upgraded.

## Delivery and control changes

- A caller saves `operation_id` before the first Codex send. The agent persists the bound receipt before script validation and the first IPC preflight, so an early timeout can be reconciled by a known ID.
- The same operation ID cannot dispatch twice or be rebound to a different exact target or message hash. Legacy receipt lookup and text/target deduplication remain supported.
- Delivery status returns saved progress during dispatch. `refresh=false` reads the persisted receipt; `refresh=true` explicitly reconciles an unknown result without sending. Unknown delivery, missing receipts and stale locks never authorize automatic replay.
- Exact-target, known-idle and empty-pending checks remain mandatory. Delivery confirmation requires a new complete exact user turn with a valid timestamp; a retained draft or unknown pending state is not treated as ready.
- MCP handshake, `ping`, `tools/list`, `codex_delivery_status` and `local_mcp_operation` can respond while another tool is pending. Ordinary tool calls retain their serial order.
- UI messages are bounded to 32768 UTF-8 bytes. The paired external adapter must support the documented discovery/read limits; see [Codex compatibility](docs/CODEX_CONNECT_COMPATIBILITY.md).

## Verification checkpoint

`node --test tests/codex-bridge.test.mjs tests/codex-delivery.test.mjs` passed **39 tests**, with **0 failures and 0 skips**, using synthetic adapters and receipts. These cases cover early preflight failure, response loss, repeated/concurrent IDs, lock ownership, storage failures and delivery correlation, including CRLF normalization without trimming or changing code/path text, an undated exact candidate alongside a dated match, and preservation of unknown pending evidence in status/discovery. The privacy check passed for 102 files; route and relative-link validation passed for 30 tools and 26 Markdown files. The unconfigured optional-disabled self-test passed for source version 0.3.1 and all 30 tools.

Independent reviews covered durable delivery, IPC bounds and the companion UI sender; the stdio control-lane change received a separate review. Final full-suite and release-manifest checks are recorded with the published change. CI runs the package on Linux and Windows with Node 22 and 24.

The companion Codex Connect checkout passed 50 Python tests in isolated WSL and a read-only live snapshot-13 check. Its Windows PowerShell parser check passed, but the local pure-function fixture launch from UNC was refused by the current execution policy; no bypass was used. Its separate Windows CI fixture performs no desktop interaction. These results do not validate this bridge's live desktop delivery, installer/upgrade, or tunnel acceptance. No update was installed on a target machine as part of this source work.

The reported external tunnel HTTP 409 was not reproduced in this environment. The stdio control-lane change addresses a confirmed local blocking path; it does not establish the cause or resolution of that external response.

## Entry points

- Users: [README.md](README.md) → [installation](docs/INSTALLATION.md) → [runbook](docs/RUNBOOK.md).
- Agents operating a connected machine: [remote-machine skill](skills/remote-machine/SKILL.md).
- Contributors: [AGENTS.md](AGENTS.md) → [CONTRIBUTING.md](CONTRIBUTING.md) → [testing](docs/TESTING.md).
- Planning: [ROADMAP.md](ROADMAP.md).

## Current boundaries

- The agent is a trusted-user tool with the permissions of its OS account. General shell execution is not sandboxed by file roots.
- MCP integrations are selected from local definitions. An application name alone does not establish protocol compatibility.
- Codex Connect relies on separately installed compatible adapter and UI-sender scripts; these are not redistributed here.
- Process sessions are in memory. Durable MCP and Codex receipts remain local and require explicit reconciliation after an uncertain outcome.
- CI and synthetic tests cover repository behavior. Live application, tunnel and desktop UI acceptance require a separately authorized test in the target environment.

## Next development step

Use the prioritized acceptance criteria in [ROADMAP.md](ROADMAP.md). For each change, record its exact commit, test command and result in the pull request. Publish only sanitized, reproducible evidence; keep raw operational results outside the repository.

# Development state

## Current source version

The current source version is **0.3.4**, based on the portable 0.3.0 public baseline. WSL and Codex Connect remain optional; structured file/process tools and the direct local MCP bridge remain available.

This file describes repository development. It is not an inventory of installed machines and is not proof that a production deployment has been upgraded.

## Delivery and control changes

### Version 0.3.4 changes

Version 0.3.4 adds a modern explicit owner-decision API for one terminal unknown receipt. It requires separate acceptance of possible late delivery, exact reviewed binding, a verified original message, fresh known idle/empty pending evidence and the existing lock. The decision does not change unknown into delivered/not-sent, assert UI-worker exit, clean a draft or submit anything. Every new distinct task retains normal current preflight and UI guards; original and CRLF/LF-equivalent text cannot replay. Legacy compatibility is unchanged.

Delayed status reconciliation now merges its observation into the current receipt under lock, preserving an intervening immutable owner decision. Inner UI timeout, nullable submit evidence, bounded elapsed time and an allowlisted cause remain distinct from the outer WSL result. Synthetic owner-decision and timeout regressions cover the candidate; target UI acceptance and any real owner decision remain separate, explicitly authorized operations.

### Released 0.3.3 behavior

- Optional legacy hash fields may be absent or explicitly null without invalidating a historical owner decision. Non-null malformed values still fail closed; a completed legacy UI observation still requires its valid observed hash. No legacy receipt is rewritten and no modern-operation exception is added.
- Valid legacy owner decisions and completed UI line-feed observations permit new distinct work while retaining the old receipt and outcome. `legacy_receipt_compatibility` identifies that narrower historical evidence; it is not a new strict delivery confirmation.
- Prior original/UI hashes are deduplicated by stable thread UUID even after a rename. A changed request binding receives a durable `not_sent_duplicate` result instead of an ambiguous alias.
- Bounded symbolic UI diagnostic codes survive staging failures; raw exception/output content remains excluded.

- A caller saves `operation_id` before the first Codex send. The agent persists the bound receipt before script validation and the first IPC preflight, so an early timeout can be reconciled by a known ID.
- The same operation ID cannot dispatch twice or be rebound to a different exact target or message hash. Legacy receipt lookup and text/target deduplication remain supported.
- Delivery status returns saved progress during dispatch. `refresh=false` reads the persisted receipt; `refresh=true` explicitly reconciles an unknown result without sending. Unknown delivery, missing receipts and stale locks never authorize automatic replay.
- Exact-target, known-idle and empty-pending checks remain mandatory. Delivery confirmation requires a new complete exact user turn with a valid timestamp; a retained draft or unknown pending state is not treated as ready.
- MCP handshake, `ping`, `tools/list`, `codex_delivery_status` and `local_mcp_operation` can respond while another tool is pending. Ordinary tool calls retain their serial order.
- UI messages are bounded to 32768 UTF-8 bytes. The paired external adapter must support the documented discovery/read limits; see [Codex compatibility](docs/CODEX_CONNECT_COMPATIBILITY.md).

## Verification checkpoint

The 0.3.4 source candidate passed **174/174 Linux tests**, including **72 focused delivery/owner-decision tests**. Route/link validation passed for **31 tools** and **26 Markdown files**; the privacy scan passed for **103 files**. Final release manifest/self-test, published CI and target Windows checks are recorded separately; a successful explicit-decision fixture is not a live owner acknowledgement.

The same 0.3.4 code was checked with isolated state on the target Windows host, Node 24.11.0: **171 passed, 0 failed, 3 platform-specific skips** out of 174 tests. The paired Codex candidate passed **55/55 tests in WSL** and **39/39 PowerShell guard fixtures**. Its public probe navigated an existing allowed session without entering or submitting a message. Actual owner acknowledgement and delivery remain separate operations; no unknown receipt was changed by these checks.

### Retained 0.3.3 checkpoint

For 0.3.3, `npm test` passed **153 tests** with **0 failures and 0 skips**. Three additional regressions cover serialized null legacy aliases, distinct-message eligibility with original-text no-replay, and continued rejection of malformed or modern evidence. The prior cases cover legacy owner decisions, line-feed evidence, duplicates after title/cwd changes, durable caller binding, preserved receipts, current preflight/lock checks and bounded UI diagnostic codes. Strict correlation of new user turns remains unchanged.

The privacy check passed for **102 files**. Agent routes and relative links passed for **30 tools** and **26 Markdown files**. The optional-disabled self-test and final manifest validation are rerun after the version update and recorded with published CI; Linux and Windows CI use Node 22 and 24.

The same 0.3.3 candidate was also checked in an isolated configuration on Windows with Node 24.11.0: **150 passed, 0 failed, 3 platform-specific skips** out of 153 tests. The dedicated Windows output/EOF, truthful soft-stop, confirmed force-stop and owned-resource cleanup smoke all passed. An earlier CI attempt timed out after ten seconds in the Windows output/EOF smoke; that result is retained and the final CI rerun is recorded with the pull request. No test or timeout was weakened for the retry.

A separately authorized target check confirmed normal NTFS installation under Windows RemoteSigned, script hashes, the installed self-test, healthy tunnel restart and live snapshot-13 reads. The following live check exposed the nullable legacy alias addressed here. It also observed the rich-text UI adding Markdown escaping to a submitted message: the visible agent acknowledged its content, while strict transport correlation correctly remained unconfirmed. This nullable fix does not change that correlation rule or establish complete end-to-end acceptance. Raw operational receipts and machine-specific paths stay outside the repository.

The external tunnel returned transient HTTP 409/timeout responses during reconnect before operational requests recovered. Its underlying cause is not established as fixed by this source change. Do not clear delivery receipts to repair a transport error.

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

# Existing Codex sessions

Use this route only when Codex Connect is configured. The agent wraps external adapter/UI scripts and does not start a second backend or provide generic resume, steer, interrupt or approval APIs.

Use the schemas reported by the connected version. Version 0.3.1 supports a caller-known operation ID and cached/refresh delivery status. Older installed versions may not expose these fields. Updating repository source does not update a machine or its external scripts.

## Read

1. Run `codex_doctor` to check the adapter route.
2. If the exact UUID is unknown, call `codex_discover` with the narrowest known filter. An exact title may still match multiple threads.
3. Read `codex_read_thread` with a verified UUID and a small visible-message limit.
4. Check exact title, working directory, live runtime status, pending requests and unconfirmed submissions. Treat unknown status or pending evidence as unknown, never as idle or an empty queue.

For partial discovery errors, a known exact UUID can be checked with `thread_ids`. Do not infer that every session is offline because one candidate failed.

Use bounded reads. The full 0.3.1 schema requires a compatible paired adapter with `--timeout` 1..60, discovery `--limit` 1..200, read `--limit` 1..20 and `--max-chars` 100..200000. Check [adapter compatibility](../../../docs/CODEX_CONNECT_COMPATIBILITY.md) before relying on those limits; an old CLI or truncated message cannot prove delivery.

## Send once

Proceed only when the user's instruction authorizes sending or continuing work in the selected session. Verify the exact UUID/title/cwd immediately before sending. Require known `idle`, no pending request, no unconfirmed submission and a compatible available desktop.

Create and save a unique `operation_id` **before the first call**. Use 8..128 ASCII letters, digits, `_` or `-`, starting with a letter or digit. Pass this ID and the complete message to `codex_send_message` with `confirm_mutation=true`; keep the message within **32768 UTF-8 bytes**, then also save `receipt_id` from the reply. The agent persists a receipt before script validation or the first IPC preflight. The ID is bound to the exact target and text hash: repeating it reads the original result; changing its target or text conflicts.

Do not silently fall back to a send without an operation ID after losing an answer. Legacy calls remain compatible, but a caller without a saved ID has no guaranteed recovery key if the reply is lost.

`queued`, UI invocation and process exit do not confirm delivery. Accept delivery only from an observed exact new user turn. An observed receipt does not mean the other agent has finished its work. `already_observed` can return when the exact text is already present before dispatch; it means no new UI send was performed, not that a new delivery was proved.

Allow only CRLF-to-LF normalization when comparing observed text. Preserve other whitespace, case, backslashes and lone carriage returns. Keep the original text unchanged when reusing an operation ID: its bound hash is not normalized.

## Reconcile without replay

For `prepared`, `pending_send`, `ui_invoked_unobserved`, `outcome_unknown`, timeout or a lost reply, read `codex_delivery_status` by the original `operation_id` or `receipt_id`. If passing both, they must refer to the same receipt. Do not resend the message. An unresolved receipt blocks a new send to that thread, including one with a different operation ID.

- Use `refresh=false` for a persisted status read without IPC. During a dispatch lock, the default also returns the saved phase immediately.
- Use `refresh=true` for an explicit read-only live reconciliation of an unknown delivery, including after a stale lock. This never invokes the UI sender; it may wait for the bounded adapter read.
- Inspect `phase`, `stage`, `last_completed_stage`, `delivery_outcome`, `retry_safe` and `receipt_persisted`. A reported observation with `receipt_persisted=false` has not updated durable state.
- Treat `not_found`, a missing message in the current history tail, an empty composer or `current_pending=null` as insufficient evidence for another send.

For a proven `not_sent_preflight_failed`, `not_sent_preflight_changed` or `not_sent_ui_preflight`, check `retry_safe`, correct the cause and perform fresh exact-target checks before a new authorized attempt with a new ID. `not_sent_blocked` still requires reconciliation of the blocking receipt. `not_sent_ui_staged` retains a draft and is not retry-safe: inspect the draft rather than overwriting or submitting it automatically. Do not reinterpret an old matching turn as proof of a new delivery.

Do not delete stale locks or receipts to force progress. First confirm the old dispatcher is no longer active and reconcile the actual history. UI sending also depends on the user's available desktop session and compatible client; a successful doctor is not proof of UI delivery.

## Explicit owner decision for new distinct work

`codex_reset_delivery_block` records a separate owner decision accepting one terminal modern `outcome_unknown`, including the possibility of late delivery and its ordering effects. It does not replay a send, clear a draft, assert that a Windows worker exited, or prove that the earlier message was absent. A general instruction to continue or repair the integration is not that specific decision; do not apply it automatically from a scheduled controller.

Read the exact receipt first. Only after the owner's explicit acceptance pass its `receipt_id`, exact `thread_id`/`title`/`cwd`, original `expected_message_sha256`, `accept_unknown_outcome=true` and `confirm_mutation=true`. The server checks the original message hash, fresh exact idle/known-empty-pending evidence and its normal durable lock. Active known dispatchers, unfinished receipts and retained staged drafts are not reset. The new API is for schema-2 operations; historical legacy decisions remain compatible but are not created by this route.

The saved decision keeps the unknown phase and original-message replay barrier. A strict newly observed full user turn can instead be reconciled as delivery without an acceptance record. `blocks_new_send=false` applies only to this receipt, not to all thread state. `retry_safe=false` and `readiness_verified_for_next_send=false` remain explicit. Every genuinely new task still passes ordinary current identity/idle/pending, Windows mutex and draft guards. Cosmetic changes do not turn a replay into new work.

An identical repeated owner-decision call returns the same saved decision, without another write or a fresh readiness claim. If the response is lost, inspect the same receipt. Do not edit or delete the receipt or broaden its decision to other deliveries.

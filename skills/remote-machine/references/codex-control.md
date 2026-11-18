# Existing Codex sessions

Use this route only when Codex Connect is configured. The agent wraps external adapter/UI scripts and does not start a second backend or provide generic resume, steer, interrupt or approval APIs.

## Read

1. Run `codex_doctor` to check the adapter route.
2. If the exact UUID is unknown, call `codex_discover` with the narrowest known filter. An exact title may still match multiple threads.
3. Read `codex_read_thread` with a verified UUID and a small visible-message limit.
4. Check exact title, working directory, live runtime status and pending requests.

For partial discovery errors, a known exact UUID can be checked with `thread_ids`. Do not infer that every session is offline because one candidate failed.

## Send once

Proceed only when the user's instruction authorizes sending or continuing work in the selected session. Verify the exact UUID/title/cwd immediately before sending. Require `idle` and no pending request. Pass the complete UTF-8 message to `codex_send_message` with `confirm_mutation=true`, then save `receipt_id`.

`queued`, UI invocation and process exit do not confirm delivery. Accept delivery only from an observed exact new user turn. An observed receipt does not mean the other agent has finished its work. `already_observed` can return when the exact text is already present before dispatch; it means no new UI send was performed, not that a new delivery was proved.

For `pending_send`, `ui_invoked_unobserved`, `outcome_unknown`, timeout or a lost reply, use `codex_delivery_status` and exact-thread history. Do not resend the message. An unresolved receipt blocks a new send to that thread.

`not_sent_preflight_changed` establishes no UI dispatch; a new call may follow fresh checks within the authorized task. Do not reinterpret an old matching turn as proof of a new delivery.

Do not delete stale locks or receipts to force progress. First confirm the old dispatcher is no longer active and reconcile the actual history. UI sending also depends on the user's available desktop session and compatible client; a successful doctor is not proof of UI delivery.

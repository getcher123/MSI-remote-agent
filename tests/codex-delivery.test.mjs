import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../server/lib/codex-bridge.mjs';

const identity = { thread_id: 'thread-exact', title: 'TEST', cwd: '/project' };
function snapshot(turns = [], extra = {}) { return { ...identity, source: 'live_extension_snapshot', runtime_status: { type: 'idle' }, pending_request_methods: [], turns, ...extra }; }
function userTurn(id, text, time = Date.now(), truncated = false) { return { id, status: 'completed', started_at_ms: time, messages: [{ id: `${id}-m`, role: 'user', text, truncated }] }; }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-codex-'));
  const b = new CodexBridge({ wsl: { distro: 'test', user: 'test' }, codex: { adapterPath: '/a', uiSenderPath: '/b', messageDir: path.join(root, 'messages') }, receiptFile: path.join(root, 'receipts.json') }, { toHostPath: (x) => x });
  b.verifyScripts = async () => [];
  b.readThread = async () => snapshot();
  b.runWsl = async () => ({ exit_code: 0, stdout: '{"phase":"queued"}', stderr: '' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { b, root, request: { ...identity, message: 'UNIQUE_TEST_Проверка', wait_seconds: 1 } };
}
test('rejects wrong UUID even if title/cwd match', async (t) => {
  const { b, request } = await fixture(t); b.readThread = async () => snapshot([], { thread_id: 'wrong' });
  let sends = 0; b.runWsl = async () => { sends++; };
  const r = await b.sendMessage(request);
  assert.equal(r.phase, 'not_sent_preflight_failed'); assert.equal(r.error.code, 'CODEX_THREAD_ID_MISMATCH'); assert.equal(r.delivery_outcome, 'not_sent'); assert.equal(sends, 0);
});
test('rejects active, pending, and missing pending status before UI dispatch', async (t) => {
  const { b, request } = await fixture(t); let sends = 0; b.runWsl = async () => { sends++; };
  for (const [extra, code] of [[{ runtime_status: { type: 'active' } }, 'CODEX_THREAD_NOT_IDLE'], [{ pending_request_methods: ['approval'] }, 'CODEX_PENDING_REQUESTS'], [{ pending_request_methods: undefined }, 'CODEX_PENDING_UNKNOWN']]) {
    b.readThread = async () => snapshot([], extra);
    const r = await b.sendMessage(request); assert.equal(r.phase, 'not_sent_preflight_failed'); assert.equal(r.error.code, code); assert.equal(r.ui_dispatch_started, false);
  }
  assert.equal(sends, 0);
});
test('persists pending receipt before invoking UI and requires a new exact turn', async (t) => {
  const { b, request } = await fixture(t); let dispatched = false;
  b.runWsl = async () => {
    const [r] = await b.loadReceipts(); assert.equal(r.phase, 'pending_send'); assert.ok(r.baseline_turn_ids); assert.ok(r.enqueue_started_at_ms);
    dispatched = true; return { exit_code: 0, stdout: '{}', stderr: '' };
  };
  b.readThread = async () => snapshot(dispatched ? [userTurn('new', request.message)] : []);
  const r = await b.sendMessage(request); assert.equal(r.phase, 'observed'); assert.equal(r.observed_turn_id, 'new');
});
test('queued is unknown, and identical resend never invokes UI twice', async (t) => {
  const { b, request } = await fixture(t); let sends = 0; b.runWsl = async () => { sends++; return { exit_code: 0, stdout: '{"phase":"queued"}', stderr: '' }; };
  const r = await b.sendMessage(request); assert.equal(r.phase, 'outcome_unknown');
  const retry = await b.sendMessage(request); assert.equal(retry.receipt_id, r.receipt_id); assert.equal(retry.deduplicated, true); assert.equal(sends, 1);
  const blocked = await b.sendMessage({ ...request, message: 'DIFFERENT' }); assert.equal(blocked.phase, 'not_sent_blocked'); assert.equal(blocked.blocked_by_receipt_id, r.receipt_id); assert.equal(blocked.retry_safe, false); assert.equal(sends, 1);
});
test('timeout with exact observed turn is confirmed without resending', async (t) => {
  const { b, request } = await fixture(t); let sent = false;
  b.runWsl = async () => { sent = true; return { exit_code: 1, timed_out: true, stdout: '', stderr: '' }; };
  b.readThread = async () => snapshot(sent ? [userTurn('new', request.message)] : []);
  assert.equal((await b.sendMessage(request)).phase, 'observed');
});
test('CRLF composer normalization confirms delivery while the operation hash stays exact', async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_crlf_delivery';
  const message = '  echo C:\\work\\file\r\nnext  '; let sent = false;
  b.runWsl = async () => { sent = true; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  b.readThread = async () => snapshot(sent ? [userTurn('normalized-turn', message.replace(/\r\n/g, '\n'))] : []);
  const result = await b.sendMessage({ ...request, operation_id, message });
  assert.equal(result.phase, 'observed'); assert.equal(result.observed_turn_id, 'normalized-turn');
  await assert.rejects(() => b.sendMessage({ ...request, operation_id, message: message.replace(/\r\n/g, '\n') }), { code: 'CODEX_OPERATION_CONFLICT' });
});
test('delivery correlation preserves spaces, case, backslashes and lone carriage returns', async (t) => {
  const { b } = await fixture(t); const time = Date.now();
  const message = '  echo C:\\work\\file\r\nnext  ';
  const opts = { baseline_turn_ids: [], enqueue_started_at_ms: time };
  const normalized = message.replace(/\r\n/g, '\n');
  const different = [normalized.trim(), normalized.replaceAll('\\', ''), normalized.replace('echo', 'ECHO'), normalized.replace('\n', '\r')];
  for (const text of different) assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('new', text, time)]), message, opts), null);
});
test('old identical or truncated user text cannot confirm a new delivery', async (t) => {
  const { b } = await fixture(t); const time = Date.now(); const opts = { baseline_turn_ids: ['old'], enqueue_started_at_ms: time };
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('old', 'x', time)]), 'x', opts), null);
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('new', 'x', time - 5000)]), 'x', opts), null);
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('just-before', 'x', time - 1)]), 'x', opts), null);
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('new', 'x', time, true)]), 'x', opts), null);
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('first', 'x', time), userTurn('second', 'x', time)]), 'x', opts), null);
});
test('wrong UUID after dispatch stays unknown', async (t) => {
  const { b, request } = await fixture(t); let sent = false;
  b.runWsl = async () => { sent = true; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  b.readThread = async () => sent ? snapshot([userTurn('new', request.message)], { thread_id: 'wrong' }) : snapshot();
  assert.equal((await b.sendMessage(request)).phase, 'outcome_unknown');
});
test('an undated exact candidate makes a dated match ambiguous, but unrelated undated text does not', async (t) => {
  const { b } = await fixture(t); const started = Date.now();
  const options = { baseline_turn_ids: [], enqueue_started_at_ms: started };
  const dated = userTurn('known-new', 'exact input', started);
  const undated = userTurn('unknown-time', 'exact input', null);
  assert.equal(b.threadHasExactUserMessage(snapshot([dated, undated]), 'exact input', options), null);
  const unrelated = userTurn('unrelated-time', 'different input', null);
  assert.equal(b.threadHasExactUserMessage(snapshot([dated, unrelated]), 'exact input', options)?.turn_id, 'known-new');
});
test('thread change during recheck is recorded as definitely not sent', async (t) => {
  const { b, request } = await fixture(t); let reads = 0, sends = 0;
  b.readThread = async () => snapshot(++reads === 1 ? [] : [userTurn('new-owner', 'STOP')]); b.runWsl = async () => { sends++; };
  const r = await b.sendMessage(request); assert.equal(r.phase, 'not_sent_preflight_changed'); assert.equal(r.retry_safe, true); assert.equal(sends, 0);
});
test('delivery status can reconcile unknown and persists observation', async (t) => {
  const { b, request } = await fixture(t); const r = await b.sendMessage(request);
  b.readThread = async () => snapshot([userTurn('later', request.message)]);
  const d = await b.deliveryStatus({ receipt_id: r.receipt_id }); assert.equal(d.phase, 'observed'); assert.equal(d.receipt_persisted, true);
  b.readThread = async () => snapshot([userTurn('unrelated', 'other')]);
  const d2 = await b.deliveryStatus({ receipt_id: r.receipt_id }); assert.equal(d2.observed, true); assert.equal(d2.observed_in_current_tail, false);
});
test('unavailable live read does not erase prior observation', async (t) => {
  const { b, request } = await fixture(t); const r = await b.sendMessage(request);
  b.readThread = async () => snapshot([userTurn('later', request.message)]); await b.deliveryStatus({ receipt_id: r.receipt_id });
  b.readThread = async () => { throw new Error('ipc unavailable'); };
  const d = await b.deliveryStatus({ receipt_id: r.receipt_id }); assert.equal(d.observed, true); assert.equal(d.live_read_available, false);
});
test('corrupt receipts fail closed and are not overwritten', async (t) => {
  const { b, request } = await fixture(t); await fs.writeFile(b.receiptFile, '{broken');
  await assert.rejects(() => b.sendMessage(request)); assert.equal(await fs.readFile(b.receiptFile, 'utf8'), '{broken');
});
test('existing delivery lock blocks send and is not deleted', async (t) => {
  const { b, request } = await fixture(t); await fs.writeFile(`${b.receiptFile}.lock`, 'owned elsewhere');
  await assert.rejects(() => b.sendMessage(request), /lock exists/); assert.equal(await fs.readFile(`${b.receiptFile}.lock`, 'utf8'), 'owned elsewhere');
});
test('UI raw output and stderr are not saved to receipts', async (t) => {
  const { b, request } = await fixture(t); b.runWsl = async () => ({ exit_code: 1, stdout: 'PRIVATE_UI_RAW', stderr: 'PRIVATE_ERROR_RAW' });
  await b.sendMessage(request); const data = await fs.readFile(b.receiptFile, 'utf8'); assert.doesNotMatch(data, /PRIVATE_/);
});
test('explicit discovery checks only requested IDs and reports partial failures', async (t) => {
  const { b } = await fixture(t); const seen = [];
  b.readThread = async ({ thread_id }) => { seen.push(thread_id); if (thread_id === 'bad') throw new Error('ipc'); return snapshot([], { thread_id }); };
  const d = await b.discover({ thread_ids: ['good', 'bad', 'good'] }); assert.deepEqual(seen, ['good', 'bad']); assert.equal(d.partial, true); assert.equal(d.threads.length, 2);
});

test('discovery and delivery status preserve unknown pending state and unconfirmed submissions', async (t) => {
  const { b, request } = await fixture(t); const receipt = await b.sendMessage(request);
  const observation = { snapshot_version: 13, received_at_ms: Date.now(), source_timestamp_known: false };
  for (const unconfirmed_submission_count of [null, 1]) {
    const pending_state_known = unconfirmed_submission_count !== null;
    b.readThread = async () => snapshot([], { pending_state_known, pending_request_count: 0, unconfirmed_submission_count, observation });
    const discovery = await b.discover({ thread_ids: [identity.thread_id] });
    const thread = discovery.threads[0];
    assert.equal(thread.pending_state_known, pending_state_known); assert.equal(thread.unconfirmed_submission_count, unconfirmed_submission_count);
    assert.equal(thread.pending_request_count, 0); assert.deepEqual(thread.observation, observation);
    assert.deepEqual(thread.pending_request_methods, pending_state_known ? [] : null);
    const status = await b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: true });
    assert.equal(status.current_pending_state_known, pending_state_known); assert.equal(status.current_unconfirmed_submission_count, unconfirmed_submission_count);
    assert.equal(status.current_pending_request_count, 0); assert.deepEqual(status.current_observation, observation);
    assert.deepEqual(status.current_pending, pending_state_known ? [] : null); assert.equal(status.retry_safe, false);
  }
});

test('caller operation ID survives the first preflight timeout and does not re-execute', async (t) => {
  const { b, request } = await fixture(t);
  const operation_id = 'test_preflight_timeout'; let reads = 0, sends = 0;
  b.readThread = async () => {
    reads++;
    const [prepared] = await b.loadReceipts();
    assert.equal(prepared.operation_id, operation_id); assert.equal(prepared.stage, 'preflight_read'); assert.equal(prepared.ui_dispatch_started, false);
    throw Object.assign(new Error('PRIVATE_BACKEND_OUTPUT'), { code: 'CODEX_ADAPTER_TIMEOUT', layer: 'adapter', timed_out: true, exit_code: 1 });
  };
  b.runWsl = async () => { sends++; };
  const result = await b.sendMessage({ ...request, operation_id });
  assert.equal(result.phase, 'not_sent_preflight_failed'); assert.equal(result.delivery_outcome, 'not_sent'); assert.equal(result.retry_safe, true);
  assert.equal(result.error.code, 'CODEX_ADAPTER_TIMEOUT'); assert.equal(result.error.stage, 'preflight_read'); assert.equal(result.error.timed_out, true);
  assert.ok(result.receipt_id); assert.equal(result.receipt_persisted, true);
  const restored = new CodexBridge(b.config, b.pathPolicy);
  restored.readThread = async () => { throw Error('terminal preflight receipt must not need IPC'); };
  const status = await restored.deliveryStatus({ operation_id });
  assert.equal(status.receipt_id, result.receipt_id); assert.equal(status.phase, result.phase);
  const repeated = await restored.sendMessage({ ...request, operation_id });
  assert.equal(repeated.deduplicated, true); assert.equal(repeated.receipt_id, result.receipt_id); assert.equal(reads, 1); assert.equal(sends, 0);
  assert.doesNotMatch(await fs.readFile(b.receiptFile, 'utf8'), /PRIVATE_BACKEND_OUTPUT/);
});

test('script validation failures also have a persisted caller-known receipt', async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_script_validation'; let reads = 0;
  b.verifyScripts = async () => {
    const [r] = await b.loadReceipts(); assert.equal(r.operation_id, operation_id); assert.equal(r.stage, 'verify_scripts');
    throw Object.assign(new Error('private path must stay local'), { code: 'CODEX_SCRIPT_SHA_MISMATCH' });
  };
  b.readThread = async () => { reads++; };
  const r = await b.sendMessage({ ...request, operation_id });
  assert.equal(r.phase, 'not_sent_preflight_failed'); assert.equal(r.error.code, 'CODEX_SCRIPT_SHA_MISMATCH'); assert.equal(reads, 0);
});

test('in-flight preflight status and same-operation duplicate are immediate without a second read', { timeout: 3000 }, async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_inflight_preflight'; let reads = 0, sends = 0;
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  b.readThread = async () => { if (++reads === 1) { entered(); await gate; } return snapshot(); };
  b.runWsl = async () => { sends++; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  const first = b.sendMessage({ ...request, operation_id }); await started;
  const status = await b.deliveryStatus({ operation_id });
  assert.equal(status.stage, 'preflight_read'); assert.equal(status.observation_source, 'persisted_receipt'); assert.equal(status.live_read_available, null); assert.equal(status.current_pending, null);
  const second = await b.sendMessage({ ...request, operation_id });
  assert.equal(second.deduplicated, true); assert.equal(second.pending, true); assert.equal(second.receipt_id, status.receipt_id); assert.equal(reads, 1); assert.equal(sends, 0);
  await assert.rejects(() => b.sendMessage({ ...request, operation_id, message: 'different' }), { code: 'CODEX_OPERATION_CONFLICT' });
  release(); const completed = await first;
  assert.equal(completed.phase, 'outcome_unknown'); assert.equal(sends, 1);
});

test('submitted but unfinished UI operation remains pollable and is never invoked twice', { timeout: 3000 }, async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_inflight_ui'; let reads = 0, sends = 0, submitted = false;
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  b.readThread = async () => { reads++; return snapshot(submitted ? [userTurn('exact-turn', request.message)] : []); };
  b.runWsl = async () => { sends++; submitted = true; entered(); await gate; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  const first = b.sendMessage({ ...request, operation_id }); await started;
  const status = await b.deliveryStatus({ operation_id });
  assert.equal(status.phase, 'pending_send'); assert.equal(status.stage, 'ui_dispatch'); assert.equal(status.ui_dispatch_started, true); assert.equal(status.retry_safe, false); assert.equal(reads, 2);
  const second = await b.sendMessage({ ...request, operation_id }); assert.equal(second.deduplicated, true); assert.equal(sends, 1);
  release(); const done = await first; assert.equal(done.phase, 'observed'); assert.equal(done.observed_turn_id, 'exact-turn');
});

test('lost submit response is recoverable after bridge restart by operation ID', async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_lost_response'; let sends = 0;
  b.runWsl = async () => { sends++; return { exit_code: 1, timed_out: true, stdout: '', stderr: '' }; };
  await b.sendMessage({ ...request, operation_id }); // Intentionally discard the original response.
  const restored = new CodexBridge(b.config, b.pathPolicy);
  restored.runWsl = async () => { sends++; throw Error('must not dispatch again'); };
  restored.readThread = async () => snapshot([userTurn('accepted-once', request.message)]);
  const status = await restored.deliveryStatus({ operation_id });
  assert.equal(status.phase, 'observed'); assert.equal(status.observed_turn_id, 'accepted-once'); assert.equal(status.receipt_persisted, true);
  const repeat = await restored.sendMessage({ ...request, operation_id }); assert.equal(repeat.phase, 'observed'); assert.equal(sends, 1);
});

test('operation ID cannot be rebound to another message or any part of the target', async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_bound_operation';
  const first = await b.sendMessage({ ...request, operation_id });
  for (const change of [{ message: 'DIFFERENT' }, { thread_id: 'other-thread' }, { title: 'Other' }, { cwd: '/other' }]) {
    await assert.rejects(() => b.sendMessage({ ...request, operation_id, ...change }), (error) => error.code === 'CODEX_OPERATION_CONFLICT' && error.receipt_id === first.receipt_id);
  }
  await assert.rejects(() => b.deliveryStatus({ operation_id, receipt_id: 'different-receipt' }), { code: 'CODEX_OPERATION_CONFLICT' });
});

test('hash-deduplicated caller IDs remain recoverable through the original receipt', async (t) => {
  const { b, request } = await fixture(t); let sends = 0;
  b.runWsl = async () => { sends++; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  const first = await b.sendMessage({ ...request, operation_id: 'test_original_operation' });
  const alias = await b.sendMessage({ ...request, operation_id: 'test_duplicate_operation' });
  assert.equal(alias.receipt_id, first.receipt_id); assert.equal(alias.operation_id, 'test_duplicate_operation'); assert.equal(alias.canonical_operation_id, 'test_original_operation');
  b.readThread = async () => snapshot([userTurn('accepted-original', request.message)]);
  const recovered = await b.deliveryStatus({ operation_id: 'test_duplicate_operation' });
  assert.equal(recovered.phase, 'observed'); assert.equal(recovered.operation_id, 'test_duplicate_operation'); assert.equal(sends, 1);
  assert.equal((await b.deliveryStatus({ operation_id: 'test_original_operation', refresh: false })).phase, 'observed');
});

test('absent operation and unavailable pending state are not reported as safe or empty', async (t) => {
  const { b, request } = await fixture(t);
  const missing = await b.deliveryStatus({ operation_id: 'test_missing_operation' });
  assert.equal(missing.phase, 'not_found'); assert.equal(missing.delivery_outcome, 'unknown'); assert.equal(missing.retry_safe, false);
  const receipt = await b.sendMessage(request);
  b.readThread = async () => snapshot([], { pending_request_methods: undefined });
  const status = await b.deliveryStatus({ receipt_id: receipt.receipt_id });
  assert.equal(status.current_pending, null); assert.equal(status.retry_safe, false);
});

test('a stale lock permits explicit read-only reconciliation and is preserved', async (t) => {
  const { b, request } = await fixture(t); const receipt = await b.sendMessage({ ...request, operation_id: 'test_stale_lock' });
  await fs.writeFile(`${b.receiptFile}.lock`, 'foreign lock'); let reads = 0;
  b.readThread = async () => { reads++; return snapshot([userTurn('later', request.message)]); };
  const cached = await b.deliveryStatus({ operation_id: 'test_stale_lock' }); assert.equal(cached.phase, 'outcome_unknown'); assert.equal(reads, 0);
  const observed = await b.deliveryStatus({ operation_id: 'test_stale_lock', refresh: true });
  assert.equal(observed.observed, true); assert.equal(observed.receipt_persisted, false); assert.equal(reads, 1);
  assert.equal(await fs.readFile(`${b.receiptFile}.lock`, 'utf8'), 'foreign lock');
});

test('a replaced lock is never removed by the previous owner', async (t) => {
  const { b, request } = await fixture(t);
  b.runWsl = async () => { await fs.writeFile(`${b.receiptFile}.lock`, JSON.stringify({ token: 'foreign-owner' })); return { exit_code: 0, stdout: '{}', stderr: '' }; };
  await b.sendMessage(request);
  assert.equal(JSON.parse(await fs.readFile(`${b.receiptFile}.lock`, 'utf8')).token, 'foreign-owner');
});

test('terminal receipt write failure leaves a durable no-replay barrier', async (t) => {
  const { b, request } = await fixture(t); const operation_id = 'test_terminal_write_failure'; let dispatched = false, sends = 0;
  const save = b.saveReceipt.bind(b);
  b.saveReceipt = async (receipt) => { if (receipt.phase === 'observed') throw Error('disk unavailable'); return save(receipt); };
  b.runWsl = async () => { dispatched = true; sends++; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  b.readThread = async () => snapshot(dispatched ? [userTurn('accepted', request.message)] : []);
  const result = await b.sendMessage({ ...request, operation_id });
  assert.equal(result.phase, 'observed'); assert.equal(result.receipt_persisted, false); assert.equal(result.retry_safe, false);
  const restored = new CodexBridge(b.config, b.pathPolicy);
  restored.runWsl = async () => { sends++; };
  assert.equal((await restored.sendMessage({ ...request, operation_id })).phase, 'outcome_unknown'); assert.equal(sends, 1);
});

test('only a complete explicit non-submit UI result proves the operation was not sent', async (t) => {
  const { b, request } = await fixture(t);
  for (const [phase, expected, retrySafe] of [['failed_before_send', 'not_sent_ui_preflight', true], ['staged_not_submitted', 'not_sent_ui_staged', false]]) {
    b.runWsl = async () => ({ exit_code: 1, stdout: JSON.stringify({ phase, outcome: 'not_sent', submit_attempted: false, last_confirmed_phase: 'composer_checked' }), stderr: '' });
    const result = await b.sendMessage(request); assert.equal(result.phase, expected); assert.equal(result.delivery_outcome, 'not_sent'); assert.equal(result.retry_safe, retrySafe);
  }
  b.runWsl = async () => ({ exit_code: 1, timed_out: true, stdout: JSON.stringify({ phase: 'failed_before_send', outcome: 'not_sent', submit_attempted: false }), stderr: '' });
  assert.equal((await b.sendMessage(request)).phase, 'outcome_unknown');
});

test('UI message limit is checked in UTF-8 bytes before dispatch or storage', async (t) => {
  const { b, request } = await fixture(t); let sends = 0; b.runWsl = async () => { sends++; };
  await assert.rejects(() => b.sendMessage({ ...request, message: 'Ж'.repeat(20000), operation_id: 'test_large_utf8' }), { code: 'CODEX_MESSAGE_TOO_LARGE' });
  assert.equal((await b.loadReceipts()).length, 0); assert.equal(sends, 0);
});

test('failure to create the first receipt prevents all adapter and UI execution', async (t) => {
  const { b, request } = await fixture(t); let calls = 0;
  b.saveReceipt = async () => { throw Error('storage unavailable'); };
  b.verifyScripts = b.readThread = b.runWsl = async () => { calls++; };
  await assert.rejects(() => b.sendMessage({ ...request, operation_id: 'test_initial_store_failure' }), (error) => error.code === 'CODEX_RECEIPT_STORE_FAILED' && error.operation_id === 'test_initial_store_failure' && Boolean(error.receipt_id));
  assert.equal(calls, 0); assert.equal((await b.loadReceipts()).length, 0);
});

test('an explicit cache-only status never calls a live adapter', async (t) => {
  const { b, request } = await fixture(t); const receipt = await b.sendMessage({ ...request, operation_id: 'test_cached_status' });
  b.readThread = async () => { throw Error('must not call live adapter'); };
  const cached = await b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: false });
  assert.equal(cached.phase, 'outcome_unknown'); assert.equal(cached.live_read_available, null); assert.equal(cached.observation_source, 'persisted_receipt');
});

test('malformed or conflicting persisted operation identities fail closed', async (t) => {
  const { b, request } = await fixture(t); const receipt = await b.sendMessage({ ...request, operation_id: 'test_store_identity' });
  for (const records of [[{ ...receipt, receipt_id: undefined }], [{ ...receipt, operation_id: 12345678 }], [receipt, { ...receipt, receipt_id: 'another_receipt' }]]) {
    const data = JSON.stringify(records); await fs.writeFile(b.receiptFile, data);
    await assert.rejects(() => b.sendMessage({ ...request, operation_id: 'test_next_operation' }), { code: 'CODEX_RECEIPT_STORE_CORRUPT' });
    assert.equal(await fs.readFile(b.receiptFile, 'utf8'), data);
  }
});

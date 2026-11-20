import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../server/lib/codex-bridge.mjs';
import { buildTools } from '../server/lib/tools.mjs';
import { sha256Text } from '../server/lib/util.mjs';

const identity = { thread_id: 'synthetic-owner-thread', title: 'Synthetic owner decision', cwd: '/synthetic-project' };
function snapshot(extra = {}) {
  return { ...identity, source: 'live_extension_snapshot', runtime_status: { type: 'idle' },
    pending_request_methods: [], pending_state_known: true, pending_request_count: 0, unconfirmed_submission_count: 0,
    observation: { received_at_ms: Date.now(), freshness: 'received_in_current_request' }, turns: [], ...extra };
}
function userTurn(text, started = Date.now()) {
  return { id: 'synthetic-new-turn', status: 'completed', started_at_ms: started,
    messages: [{ id: 'synthetic-new-user', role: 'user', text, truncated: false }] };
}
async function fixture(t, message = 'An earlier\r\nsynthetic task') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-owner-decision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const b = new CodexBridge({ wsl: { distro: 'test', user: 'test' },
    codex: { adapterPath: '/a', uiSenderPath: '/b', messageDir: path.join(root, 'messages') },
    receiptFile: path.join(root, 'receipts.json') }, { toHostPath: x => x });
  b.verifyScripts = async () => [];
  b.readThread = async () => snapshot();
  const calls = { ui: 0 };
  b.runWsl = async () => { calls.ui++; return { exit_code: 3, timed_out: false, stderr: '', stdout: JSON.stringify({
    phase: 'outcome_unknown', outcome: 'unknown', last_confirmed_phase: 'ui_dispatched',
    reason: 'UI_PROCESS_TIMEOUT', inner_ui_timed_out: true, cause: 'TimeoutExpired', submit_attempted: null,
  }) }; };
  const request = { ...identity, operation_id: 'synthetic_original_operation', message, wait_seconds: 1 };
  const receipt = await b.sendMessage(request);
  assert.equal(receipt.phase, 'outcome_unknown');
  const args = { ...identity, receipt_id: receipt.receipt_id, expected_message_sha256: receipt.message_sha256, accept_unknown_outcome: true };
  return { b, root, request, receipt, args, calls };
}

test('explicit owner acceptance preserves an inner-timeout unknown and never invokes UI', async t => {
  const { b, receipt, args, calls } = await fixture(t);
  const result = await b.resetDeliveryBlock(args);
  assert.equal(result.reset_applied, true); assert.equal(result.phase, 'outcome_unknown');
  assert.equal(result.delivery_outcome, 'unknown'); assert.equal(result.retry_safe, false);
  assert.equal(result.blocks_new_send, false); assert.equal(result.resolution_scope, 'this_receipt_only');
  assert.equal(result.readiness_verified_for_next_send, false); assert.equal(calls.ui, 1);
  assert.deepEqual(result.ui_result, receipt.ui_result); assert.equal(result.ui_result.submit_attempted, null);
  assert.equal(result.owner_resolution.decision, 'accept_unknown_outcome_including_late_delivery');
  assert.equal(result.owner_resolution.reconciliation.history_coverage, 'bounded_live_tail');
  assert.equal(result.owner_resolution.reconciliation.exact_turn_found, false);
  for (const key of ['receipt_id', 'operation_id', 'message_sha256', 'phase', 'stage', 'delivery_outcome', 'ui_exit_code', 'ui_timed_out']) assert.equal(result[key], receipt[key]);
  assert.deepEqual(result.baseline_turn_ids, receipt.baseline_turn_ids);
  assert.deepEqual((await b.loadReceipts())[0].owner_resolution, result.owner_resolution);
});

test('owner decision is idempotent after a lost response and does not assert new readiness', async t => {
  const { b, args } = await fixture(t);
  const first = await b.resetDeliveryBlock(args);
  const before = await fs.readFile(b.receiptFile, 'utf8');
  const restarted = new CodexBridge(b.config, b.pathPolicy);
  restarted.readThread = async () => { throw Error('an idempotent acknowledgement must not need a new IPC read'); };
  const again = await restarted.resetDeliveryBlock(args);
  assert.equal(again.reset_applied, false); assert.equal(again.owner_decision_already_recorded, true);
  assert.equal(again.readiness_verified_for_next_send, false);
  assert.deepEqual(again.owner_resolution, first.owner_resolution);
  assert.equal(await fs.readFile(b.receiptFile, 'utf8'), before);
});

test('owner acceptance requires its explicit flag and reviewed exact receipt binding', async t => {
  const { b, args } = await fixture(t);
  const before = await fs.readFile(b.receiptFile, 'utf8');
  for (const value of [undefined, false, 'true']) await assert.rejects(() => b.resetDeliveryBlock({ ...args, accept_unknown_outcome: value }), { code: 'CODEX_OWNER_ACCEPTANCE_REQUIRED' });
  for (const key of ['thread_id', 'title', 'cwd']) await assert.rejects(() => b.resetDeliveryBlock({ ...args, [key]: 'wrong' }), { code: 'CODEX_OPERATION_CONFLICT' });
  await assert.rejects(() => b.resetDeliveryBlock({ ...args, expected_message_sha256: sha256Text('wrong') }), { code: 'CODEX_OPERATION_CONFLICT' });
  await assert.rejects(() => b.resetDeliveryBlock({ ...args, expected_message_sha256: 'bad' }), { code: 'CODEX_OWNER_RESOLUTION_INVALID' });
  await assert.rejects(() => b.resetDeliveryBlock({ ...args, receipt_id: 'missing_receipt' }), { code: 'CODEX_RECEIPT_NOT_FOUND' });
  assert.equal(await fs.readFile(b.receiptFile, 'utf8'), before);
});

test('owner acceptance preserves original and CRLF-equivalent replay barriers across rename and later observation', async t => {
  const { b, args, request, calls, receipt } = await fixture(t);
  await b.resetDeliveryBlock(args);
  const exact = await b.sendMessage({ ...request, operation_id: 'synthetic_replay_new_id' });
  assert.equal(exact.receipt_id, receipt.receipt_id); assert.equal(exact.deduplicated, true);
  const lf = await b.sendMessage({ ...request, operation_id: 'synthetic_replay_lf_id', message: request.message.replace(/\r\n/g, '\n') });
  assert.equal(lf.phase, 'not_sent_duplicate'); assert.equal(lf.deduplicated_by_receipt_id, receipt.receipt_id);
  const renamed = await b.sendMessage({ ...request, title: 'A renamed session', cwd: '/renamed-project', operation_id: 'synthetic_replay_renamed' });
  assert.equal(renamed.phase, 'not_sent_duplicate'); assert.equal(calls.ui, 1);
  b.readThread = async () => snapshot({ turns: [userTurn(request.message)] });
  assert.equal((await b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: true })).phase, 'observed');
  b.readThread = async () => snapshot();
  const afterObservation = await b.sendMessage({ ...request, operation_id: 'synthetic_replay_lf_after', message: request.message.replace(/\r\n/g, '\n') });
  assert.equal(afterObservation.phase, 'not_sent_duplicate'); assert.equal(calls.ui, 1);
});

test('only new distinct work may reach all ordinary preflight and UI guards after acceptance', async t => {
  const { b, args, request, calls } = await fixture(t);
  await b.resetDeliveryBlock(args);
  b.readThread = async () => snapshot({ runtime_status: { type: 'active' } });
  const blocked = await b.sendMessage({ ...request, operation_id: 'synthetic_distinct_active', message: 'A new integration task' });
  assert.equal(blocked.phase, 'not_sent_preflight_failed'); assert.equal(blocked.error.code, 'CODEX_THREAD_NOT_IDLE');
  assert.equal(calls.ui, 1);
  b.readThread = async () => snapshot();
  const distinct = await b.sendMessage({ ...request, operation_id: 'synthetic_distinct_ready', message: 'A new integration task' });
  assert.equal(distinct.phase, 'outcome_unknown'); assert.equal(calls.ui, 2);
});

test('one owner decision does not clear another unresolved receipt', async t => {
  const { b, args, request, receipt, calls } = await fixture(t);
  const other = { ...receipt, receipt_id: 'synthetic_other_receipt', operation_id: 'synthetic_other_operation', message_sha256: sha256Text('other earlier task') };
  await b.saveReceipt(other);
  await b.resetDeliveryBlock(args);
  const result = await b.sendMessage({ ...request, operation_id: 'synthetic_third_operation', message: 'New work' });
  assert.equal(result.phase, 'not_sent_blocked'); assert.equal(result.blocked_by_receipt_id, other.receipt_id);
  assert.equal(calls.ui, 1);
});

test('active dispatch and foreign or stale receipt locks reject owner acceptance unchanged', async t => {
  const { b, args, request, receipt } = await fixture(t);
  b.activeOperations.set(request.operation_id, { request, receipt });
  await assert.rejects(() => b.resetDeliveryBlock(args), { code: 'CODEX_DISPATCH_ACTIVE' });
  b.activeOperations.clear();
  await fs.writeFile(`${b.receiptFile}.lock`, 'foreign or stale');
  await assert.rejects(() => b.resetDeliveryBlock(args), { code: 'CODEX_DELIVERY_LOCKED' });
  assert.equal(await fs.readFile(`${b.receiptFile}.lock`, 'utf8'), 'foreign or stale');
  assert.equal((await b.loadReceipts())[0].owner_resolution, undefined);
});

test('pending, prepared, legacy, retained-draft and contradictory records cannot receive a modern owner decision', async t => {
  const variants = [
    { phase: 'prepared' }, { phase: 'pending_send' }, { stage: 'ui_dispatch' }, { ui_dispatch_started: false },
    { schema_version: 1, operation_id: undefined }, { draft_retained: true },
    { baseline_turn_ids: null }, { enqueue_started_at_ms: null }, { delivery_outcome: 'delivered' },
  ];
  for (const fields of variants) {
    const { b, args, receipt } = await fixture(t);
    await b.saveReceipt({ ...receipt, ...fields });
    const before = await fs.readFile(b.receiptFile, 'utf8');
    await assert.rejects(() => b.resetDeliveryBlock(args), { code: 'CODEX_OWNER_RESOLUTION_NOT_ELIGIBLE' });
    assert.equal(await fs.readFile(b.receiptFile, 'utf8'), before);
  }
});

test('unavailable or incomplete current target evidence prevents acceptance', async t => {
  const variants = [
    { thread_id: 'wrong' }, { title: 'wrong' }, { cwd: '/wrong' }, { runtime_status: { type: 'active' } },
    { pending_request_methods: ['approval'] }, { pending_state_known: undefined }, { pending_request_count: undefined },
    { unconfirmed_submission_count: 1 }, { source: 'saved_history' }, { observation: { received_at_ms: Date.now() } },
  ];
  for (const fields of variants) {
    const { b, args } = await fixture(t);
    b.readThread = async () => snapshot(fields);
    await assert.rejects(() => b.resetDeliveryBlock(args));
    assert.equal((await b.loadReceipts())[0].owner_resolution, undefined);
  }
  const { b, args } = await fixture(t);
  b.readThread = async () => { throw Error('IPC unavailable'); };
  await assert.rejects(() => b.resetDeliveryBlock(args));
  assert.equal((await b.loadReceipts())[0].owner_resolution, undefined);
});

test('missing or mismatched original message prevents owner acceptance', async t => {
  for (const missing of [false, true]) {
    const { b, args, receipt } = await fixture(t);
    const file = `${b.messageDirWsl}/${receipt.receipt_id}-${receipt.message_sha256.slice(0, 12)}.txt`;
    if (missing) await fs.unlink(file); else await fs.writeFile(file, 'different text');
    await assert.rejects(() => b.resetDeliveryBlock(args), { code: 'CODEX_MESSAGE_FILE_FAILED' });
    assert.equal((await b.loadReceipts())[0].owner_resolution, undefined);
  }
});

test('strict exact new user evidence is reconciled as observed without accepting unknown', async t => {
  const { b, args, request, calls } = await fixture(t);
  b.readThread = async () => snapshot({ turns: [userTurn(request.message)] });
  const result = await b.resetDeliveryBlock(args);
  assert.equal(result.phase, 'observed'); assert.equal(result.reset_applied, false);
  assert.equal(result.owner_decision_required, false); assert.equal(result.owner_resolution, undefined);
  assert.equal(result.observed_turn_id, 'synthetic-new-turn'); assert.equal(calls.ui, 1);
});

test('an owner decision does not manufacture strict observation from incomplete or escaped text', async t => {
  for (const kind of ['truncated', 'undated', 'escaped']) {
    const { b, args, request } = await fixture(t);
    const turn = userTurn(request.message);
    if (kind === 'truncated') turn.messages[0].truncated = true;
    if (kind === 'undated') delete turn.started_at_ms;
    if (kind === 'escaped') turn.messages[0].text += '\\';
    b.readThread = async () => snapshot({ turns: [turn] });
    const result = await b.resetDeliveryBlock(args);
    assert.equal(result.phase, 'outcome_unknown'); assert.equal(result.observed_turn_id, null);
    assert.equal(result.owner_resolution.reconciliation.exact_turn_found, false);
  }
});

test('malformed or rebound owner evidence never permits a new distinct send', async t => {
  for (const mutate of [
    r => { r.owner_resolution.binding.message_sha256 = sha256Text('wrong'); },
    r => { r.owner_resolution.decision = 'automatic'; },
    r => { r.owner_resolution.reconciliation.history_coverage = 'all_history'; },
    r => { r.owner_resolution.at = 'invalid'; },
  ]) {
    const { b, args, request, calls } = await fixture(t);
    await b.resetDeliveryBlock(args);
    const [r] = await b.loadReceipts(); mutate(r); await b.saveReceipt(r);
    const result = await b.sendMessage({ ...request, operation_id: 'synthetic_bad_decision_send', message: 'New task' });
    assert.equal(result.phase, 'not_sent_blocked'); assert.equal(calls.ui, 1);
    await assert.rejects(() => b.resetDeliveryBlock(args), { code: 'CODEX_OWNER_RESOLUTION_CONFLICT' });
  }
});

test('a malformed current receipt cannot keep owner-authorized distinct-message admission', async t => {
  for (const mutate of [
    r => { delete r.title; delete r.owner_resolution.binding.title; },
    r => { r.cwd = ''; r.owner_resolution.binding.cwd = ''; },
    r => { r.baseline_turn_ids = null; },
    r => { r.baseline_turn_ids = ['invalid whitespace']; },
    r => { r.draft_retained = true; },
  ]) {
    const { b, args, request, calls } = await fixture(t);
    await b.resetDeliveryBlock(args);
    const [r] = await b.loadReceipts(); mutate(r); await b.saveReceipt(r);
    const result = await b.sendMessage({ ...request, operation_id: 'synthetic_malformed_current', message: 'New task' });
    assert.equal(result.phase, 'not_sent_blocked'); assert.equal(calls.ui, 1);
  }
});

test('a delayed positive refresh preserves the immutable accepted decision', async t => {
  const { b, args, request, receipt } = await fixture(t);
  let finishRead; let enterRead; let reads = 0;
  const entered = new Promise(resolve => { enterRead = resolve; });
  b.readThread = async () => {
    if (++reads === 1) { enterRead(); return new Promise(resolve => { finishRead = resolve; }); }
    return snapshot();
  };
  const pending = b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: true });
  await entered;
  const accepted = await b.resetDeliveryBlock(args);
  finishRead(snapshot({ turns: [userTurn(request.message)] }));
  const observed = await pending;
  assert.equal(observed.phase, 'observed'); assert.equal(observed.receipt_persisted, true);
  assert.deepEqual(observed.owner_resolution, accepted.owner_resolution);
  assert.deepEqual((await b.loadReceipts())[0].owner_resolution, accepted.owner_resolution);
});

test('owner acknowledgement cannot report success when its durable write fails', async t => {
  const { b, args } = await fixture(t);
  const before = await fs.readFile(b.receiptFile, 'utf8');
  b.saveReceipt = async () => { throw Error('synthetic persistence failure'); };
  await assert.rejects(() => b.resetDeliveryBlock(args));
  assert.equal(await fs.readFile(b.receiptFile, 'utf8'), before);
});

test('public owner API requires explicit acceptance, reviewed hash and mutation confirmation', async () => {
  let called = false;
  const { tools, handlers } = buildTools({ config: {}, codexBridge: { resetDeliveryBlock: async args => { called = true; return args; } } });
  const tool = tools.find(item => item.name === 'codex_reset_delivery_block');
  assert.equal(tool.annotations.readOnlyHint, false);
  for (const field of ['receipt_id', 'thread_id', 'title', 'cwd', 'expected_message_sha256', 'accept_unknown_outcome', 'confirm_mutation']) assert.ok(tool.inputSchema.required.includes(field));
  assert.equal(tool.inputSchema.properties.accept_unknown_outcome.const, true);
  assert.equal(tool.inputSchema.properties.expected_message_sha256.pattern, '^[a-f0-9]{64}$');
  await assert.rejects(() => handlers.get(tool.name).handler({ confirm_mutation: false }));
  assert.equal(called, false);
});

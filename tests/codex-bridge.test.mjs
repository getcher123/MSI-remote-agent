import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../server/lib/codex-bridge.mjs';
import { buildTools } from '../server/lib/tools.mjs';
import { sha256Text } from '../server/lib/util.mjs';

const bridge = new CodexBridge({
  wsl: { distro: 'Ubuntu-22.04', user: 'testuser' },
  codex: { adapterPath: '/x', uiSenderPath: '/y' },
  receiptFile: '/tmp/nope',
}, { toHostPath: (x) => x });

test('finds an exact visible Codex user message', () => {
  const snapshot = { turns: [{ id: 'turn1', status: 'completed', messages: [{ role: 'user', id: 'm1', text: 'exact' }] }] };
  assert.deepEqual(bridge.threadHasExactUserMessage(snapshot, 'exact'), { turn_id: 'turn1', message_id: 'm1', turn_status: 'completed' });
  assert.equal(bridge.threadHasExactUserMessage(snapshot, 'other'), null);
});

test('requires exact idle thread with no pending request', () => {
  bridge.assertThreadReady({ title: 'T', cwd: '/x', runtime_status: { type: 'idle' }, pending_request_methods: [] }, { title: 'T', cwd: '/x' });
  assert.throws(() => bridge.assertThreadReady({ title: 'T', cwd: '/x', runtime_status: { type: 'active' }, pending_request_methods: [] }, { title: 'T', cwd: '/x' }), /not idle/);
  assert.throws(() => bridge.assertThreadReady({ title: 'T', cwd: '/x', runtime_status: { type: 'idle' }, pending_request_methods: ['approval'] }, { title: 'T', cwd: '/x' }), /pending/);
});

test('new adapter pending evidence cannot be silently reduced to an empty method list', () => {
  const ready = { title: 'T', cwd: '/x', runtime_status: { type: 'idle' }, pending_request_methods: [] };
  for (const extra of [{ pending_state_known: false }, { pending_request_count: 1 }, { unconfirmed_submission_count: 1 }, { pending_request_count: '0' }]) {
    assert.throws(() => bridge.assertThreadReady({ ...ready, ...extra }, { title: 'T', cwd: '/x' }));
  }
  bridge.assertThreadReady({ ...ready, pending_state_known: true, pending_request_count: 0, unconfirmed_submission_count: 0 }, { title: 'T', cwd: '/x' });
});

test('adapter timeout and invalid JSON retain safe structured diagnostics', async () => {
  const instance = new CodexBridge(bridge.config, bridge.pathPolicy); instance.verifyScripts = async () => [];
  instance.runWsl = async () => ({ exit_code: 1, timed_out: true, stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' });
  await assert.rejects(() => instance.adapter(['read']), (error) => error.code === 'CODEX_ADAPTER_TIMEOUT' && error.timed_out === true && !error.message.includes('PRIVATE'));
  instance.runWsl = async () => ({ exit_code: 0, stdout: 'PRIVATE_INVALID_JSON' });
  await assert.rejects(() => instance.adapter(['read']), (error) => error.code === 'CODEX_ADAPTER_INVALID_JSON' && !error.message.includes('PRIVATE'));
});

test('tool schema keeps legacy send callers and exposes operation recovery and byte limit', async () => {
  const calls = [];
  const codexBridge = { sendMessage: async (args) => { calls.push(args); return args; }, deliveryStatus: async (args) => { calls.push(args); return args; } };
  const { tools, handlers } = buildTools({ config: {}, codexBridge });
  const send = tools.find((tool) => tool.name === 'codex_send_message').inputSchema;
  assert.ok(!send.required.includes('operation_id')); assert.equal(send.properties.message.maxLength, 32768);
  assert.equal(send.properties.operation_id.minLength, 8);
  const status = tools.find((tool) => tool.name === 'codex_delivery_status').inputSchema;
  assert.deepEqual(status.anyOf, [{ required: ['receipt_id'] }, { required: ['operation_id'] }]);
  await handlers.get('codex_delivery_status').handler({ operation_id: 'schema_operation', refresh: false });
  assert.deepEqual(calls[0], { operation_id: 'schema_operation', refresh: false });
});

async function nullableLegacyFixture(t, fields = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-legacy-null-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyText = 'An earlier synthetic instruction';
  const identity = { thread_id: 'synthetic-thread', title: 'Renamed synthetic session', cwd: '/synthetic-project' };
  const receipt = {
    receipt_id: 'legacy_nullable_receipt', ...identity, title: 'Earlier synthetic session', phase: 'outcome_unknown',
    message_sha256: sha256Text(legacyText), message_with_lf_sha256: null, observed_message_sha256: null,
    baseline_turn_ids: ['synthetic-baseline'], enqueue_started_at_ms: Date.parse('2025-01-02T03:04:00.000Z'), retry_safe: false,
    owner_resolution: { action: 'allow_new_distinct_messages', at: '2025-01-02T03:05:00.000Z', prior_phase: 'outcome_unknown', history_coverage: 'saved_user_events' },
    ...fields,
  };
  const b = new CodexBridge({ wsl: { distro: 'test', user: 'test' }, codex: { adapterPath: '/a', uiSenderPath: '/b', messageDir: path.join(root, 'messages') }, receiptFile: path.join(root, 'receipts.json') }, { toHostPath: x => x });
  // Exercise a raw persisted legacy record, including JSON null (not undefined).
  await fs.writeFile(b.receiptFile, JSON.stringify([receipt]));
  b.verifyScripts = async () => [];
  return { b, receipt, legacyText, identity };
}

test('persisted null legacy hashes allow distinct work without rewriting history or permitting original-text replay', async t => {
  const { b, receipt, legacyText, identity } = await nullableLegacyFixture(t);
  const request = { ...identity, operation_id: 'test_nullable_distinct', message: 'A new synthetic instruction', wait_seconds: 1 };
  let sends = 0;
  b.runWsl = async () => { sends++; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  b.readThread = async () => ({ ...identity, runtime_status: { type: 'idle' }, pending_request_methods: [], turns: sends
    ? [{ id: 'new-synthetic-turn', status: 'completed', started_at_ms: Date.now(), messages: [{ id: 'new-synthetic-message', role: 'user', text: request.message }] }] : [] });
  assert.equal((await b.sendMessage(request)).phase, 'observed'); assert.equal(sends, 1);
  assert.deepEqual((await b.loadReceipts())[0], receipt);
  const historical = await b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: false });
  assert.equal(historical.legacy_receipt_compatibility, 'owner_accepted_unknown'); assert.equal(historical.observed, false); assert.equal(historical.retry_safe, false);
  b.verifyScripts = b.readThread = b.runWsl = async () => { throw Error('duplicate must not reach IPC/UI'); };
  const duplicateRequest = { ...request, operation_id: 'test_nullable_duplicate', message: legacyText };
  const duplicate = await b.sendMessage(duplicateRequest);
  assert.equal(duplicate.phase, 'not_sent_duplicate'); assert.equal(duplicate.deduplicated_by_receipt_id, receipt.receipt_id); assert.equal(duplicate.retry_safe, false);
  assert.equal((await b.sendMessage(duplicateRequest)).receipt_id, duplicate.receipt_id);
  assert.deepEqual((await b.loadReceipts())[0], receipt);
});

test('a null optional LF alias does not replace the mandatory legacy observed-message hash', async t => {
  const { b, receipt } = await nullableLegacyFixture(t, {
    phase: 'observed_with_ui_line_feed', owner_resolution: undefined, observed_turn_id: 'legacy-observed-turn', observed_message_id: 'legacy-observed-message',
    observed_at: '2025-01-02T03:05:00.000Z', observed_turn_status: 'completed', observation_source: 'live_tail',
    observed_message_sha256: sha256Text('An earlier synthetic instruction\n'),
  });
  const status = await b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: false });
  assert.equal(status.message_with_lf_sha256, null); assert.equal(status.legacy_receipt_compatibility, 'ui_line_feed_observation');
  assert.equal(status.observed, false); assert.equal(status.retry_safe, false);
});

test('nullable legacy hashes do not admit malformed aliases, modern overrides or missing mandatory observation proof', async t => {
  const changes = [
    ...['observed_message_sha256', 'message_with_lf_sha256'].flatMap(key => ['invalid', 123, {}, [], false].map(value => ({ [key]: value }))),
    { operation_id: 'modern_unknown_operation' }, { schema_version: 2 },
    { phase: 'observed_with_ui_line_feed', owner_resolution: undefined, observed_turn_id: 'legacy-observed-turn', observed_message_id: 'legacy-observed-message',
      observed_at: '2025-01-02T03:05:00.000Z', observed_turn_status: 'completed', observation_source: 'live_tail', observed_message_sha256: null },
  ];
  for (const [index, fields] of changes.entries()) {
    const { b, receipt, identity } = await nullableLegacyFixture(t, fields);
    b.verifyScripts = b.readThread = b.runWsl = async () => { throw Error('unresolved receipt must block before IPC/UI'); };
    const result = await b.sendMessage({ ...identity, operation_id: `test_nullable_rejected_${index}`, message: 'A new synthetic instruction', wait_seconds: 1 });
    assert.equal(result.phase, 'not_sent_blocked'); assert.equal(result.blocked_by_receipt_id, receipt.receipt_id); assert.equal(result.retry_safe, false);
    assert.equal((await b.deliveryStatus({ receipt_id: receipt.receipt_id, refresh: false })).legacy_receipt_compatibility, undefined);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge } from '../server/lib/codex-bridge.mjs';
import { buildTools } from '../server/lib/tools.mjs';

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

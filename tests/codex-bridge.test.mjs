import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge } from '../server/lib/codex-bridge.mjs';

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

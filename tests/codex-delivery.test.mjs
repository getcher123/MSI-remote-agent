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
  let sends = 0; b.runWsl = async () => { sends++; }; await assert.rejects(() => b.sendMessage(request), /UUID/); assert.equal(sends, 0);
});
test('rejects active, pending, and missing pending status before UI dispatch', async (t) => {
  const { b, request } = await fixture(t); let sends = 0; b.runWsl = async () => { sends++; };
  for (const extra of [{ runtime_status: { type: 'active' } }, { pending_request_methods: ['approval'] }, { pending_request_methods: undefined }]) {
    b.readThread = async () => snapshot([], extra); await assert.rejects(() => b.sendMessage(request));
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
  await assert.rejects(() => b.sendMessage({ ...request, message: 'DIFFERENT' }), /Unresolved/); assert.equal(sends, 1);
});
test('timeout with exact observed turn is confirmed without resending', async (t) => {
  const { b, request } = await fixture(t); let sent = false;
  b.runWsl = async () => { sent = true; return { exit_code: 1, timed_out: true, stdout: '', stderr: '' }; };
  b.readThread = async () => snapshot(sent ? [userTurn('new', request.message)] : []);
  assert.equal((await b.sendMessage(request)).phase, 'observed');
});
test('old identical or truncated user text cannot confirm a new delivery', async (t) => {
  const { b } = await fixture(t); const time = Date.now(); const opts = { baseline_turn_ids: ['old'], enqueue_started_at_ms: time };
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('old', 'x', time)]), 'x', opts), null);
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('new', 'x', time - 5000)]), 'x', opts), null);
  assert.equal(b.threadHasExactUserMessage(snapshot([userTurn('new', 'x', time, true)]), 'x', opts), null);
});
test('wrong UUID after dispatch stays unknown', async (t) => {
  const { b, request } = await fixture(t); let sent = false;
  b.runWsl = async () => { sent = true; return { exit_code: 0, stdout: '{}', stderr: '' }; };
  b.readThread = async () => sent ? snapshot([userTurn('new', request.message)], { thread_id: 'wrong' }) : snapshot();
  assert.equal((await b.sendMessage(request)).phase, 'outcome_unknown');
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

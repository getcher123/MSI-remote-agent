import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpOperationStore } from '../server/lib/mcp-operation-store.mjs';

const result = { content: [{ type: 'text', text: 'done' }], isError: false };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, localMcp = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-mcp-operations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { __stateDir: root, localMcp };
  const request = { operation_id: 'op_journal_123456', server_id: 'test-server', tool_name: 'commit_action', arguments_hash: 'a'.repeat(64), server_fingerprint: 'b'.repeat(64) };
  const store = new McpOperationStore(config);
  return { root, config, request, store, receiptPath: path.join(store.directory, `${request.operation_id}.json`) };
}

test('prepared and in-flight receipts are on disk before invocation and dispatch', async t => {
  const { store, request, receiptPath } = await fixture(t);
  const receipt = await store.run(request, async ({ markDispatched }) => {
    assert.equal(JSON.parse(await fs.readFile(receiptPath, 'utf8')).state, 'prepared');
    await markDispatched();
    assert.equal(JSON.parse(await fs.readFile(receiptPath, 'utf8')).state, 'in_flight');
    assert.equal((await store.status(request.operation_id)).state, 'in_flight');
    return result;
  });
  assert.equal(receipt.state, 'completed');
  assert.deepEqual(receipt.result, result);
  assert.equal(receipt.retry_safe, false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);
});

test('committed action followed by timeout is never repeated by duplicate or restarted store', async t => {
  const { store, config, request } = await fixture(t);
  let actions = 0;
  const invoke = async ({ markDispatched }) => {
    await markDispatched(); actions++;
    throw Object.assign(new Error('PRIVATE_SECRET_ERROR'), { code: 'REQUEST_TIMEOUT', dispatched: true });
  };
  assert.equal((await store.run(request, invoke)).state, 'outcome_unknown');
  const duplicate = await store.run(request, invoke);
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.retry_safe, false);
  assert.equal((await new McpOperationStore(config).run(request, invoke)).state, 'outcome_unknown');
  assert.equal(actions, 1);
  assert.doesNotMatch(JSON.stringify(await store.status(request.operation_id)), /PRIVATE_SECRET_ERROR/);
});

test('completed native image, audio, resource and structured content persist without conversion', async t => {
  const { store, config, request } = await fixture(t);
  const expected = {
    content: [{ type: 'text', text: 'Кадр🙂' }, { type: 'image', mimeType: 'image/png', data: 'AQIDBA==' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AQID' },
      { type: 'resource', resource: { uri: 'scene://current', mimeType: 'text/plain', text: 'scene' } },
      { type: 'resource_link', uri: 'scene://second', name: 'second' }],
    structuredContent: { visible: 3 }, _meta: { source: 'test' }, isError: true,
  };
  await store.run(request, async ({ markDispatched }) => { await markDispatched(); return expected; });
  const cached = await new McpOperationStore(config).run(request, () => assert.fail('must not resend'));
  assert.equal(cached.state, 'completed'); assert.equal(cached.result.isError, true);
  assert.deepEqual(cached.result, expected);
  cached.result.content[0].text = 'caller mutation';
  assert.deepEqual((await store.status(request.operation_id)).result, expected);
});

test('same operation ID with a different payload or endpoint fingerprint conflicts', async t => {
  const { store, request } = await fixture(t);
  let actions = 0;
  await store.run(request, async ({ markDispatched }) => { await markDispatched(); actions++; return result; });
  for (const change of [{ arguments_hash: 'c'.repeat(64) }, { server_fingerprint: 'c'.repeat(64) }, { tool_name: 'other' }, { server_id: 'other' }]) {
    await assert.rejects(() => store.run({ ...request, ...change }, () => actions++), { code: 'MCP_OPERATION_CONFLICT' });
  }
  assert.equal(actions, 1);
});

test('concurrent duplicate calls in the same process perform one action', async t => {
  const { store, request } = await fixture(t); const entered = deferred(); const finish = deferred();
  let actions = 0;
  const first = store.run(request, async ({ markDispatched }) => { await markDispatched(); actions++; entered.resolve(); await finish.promise; return result; });
  await entered.promise;
  const second = store.run(request, () => assert.fail('duplicate invoked'));
  await assert.rejects(() => store.run({ ...request, arguments_hash: 'd'.repeat(64) }, () => assert.fail('conflict invoked')), { code: 'MCP_OPERATION_CONFLICT' });
  assert.equal((await store.status(request.operation_id)).pending, true);
  finish.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(actions, 1); assert.deepEqual(a.result, b.result); assert.equal(b.deduplicated, true);
});

test('status is pending during first receipt creation and a delayed dispatch marker cannot overwrite an outcome', async t => {
  const { store, request } = await fixture(t);
  const blocked = deferred(); const release = deferred();
  const write = store._write.bind(store);
  store._write = async record => {
    if (record.state === 'in_flight') { blocked.resolve(); await release.promise; }
    return write(record);
  };
  const run = store.run(request, async ({ markDispatched }) => {
    // Reproduce the transport timer expiring before its durable hook completes.
    void markDispatched().catch(() => {});
    await blocked.promise;
    throw Object.assign(new Error('timeout while fsync is pending'), { code: 'REQUEST_TIMEOUT', dispatched: false });
  });
  const early = await store.status(request.operation_id);
  assert.equal(early.pending, true); assert.equal(early.state, 'prepared');
  await blocked.promise;
  assert.equal((await store.status(request.operation_id)).pending, true);
  release.resolve();
  assert.equal((await run).state, 'outcome_unknown');
  assert.equal((await store.status(request.operation_id)).state, 'outcome_unknown');
  await store.run(request, () => assert.fail('timed-out action replayed'));
});

test('another store cannot take over an active receipt or remove its lock', async t => {
  const { store, config, request } = await fixture(t); const entered = deferred(); const finish = deferred();
  const first = store.run(request, async ({ markDispatched }) => { await markDispatched(); entered.resolve(); await finish.promise; return result; });
  await entered.promise;
  const other = new McpOperationStore(config);
  const status = await other.status(request.operation_id);
  assert.equal(status.state, 'outcome_unknown'); assert.equal(status.recorded_state, 'in_flight');
  assert.equal((await other.run(request, () => assert.fail('other process invoked'))).retry_safe, false);
  await fs.access(path.join(store.directory, `${request.operation_id}.lock`));
  finish.resolve(); await first;
  assert.equal((await other.status(request.operation_id)).state, 'completed');
});

test('crashed subprocess leaves an unknown operation and a lock that is never automatically deleted', async t => {
  const { store, config, request, root } = await fixture(t);
  const modulePath = fileURLToPath(new URL('../server/lib/mcp-operation-store.mjs', import.meta.url));
  const countPath = path.join(root, 'action-count');
  const script = `import fs from 'node:fs/promises'; import { pathToFileURL } from 'node:url';
const {McpOperationStore}=await import(pathToFileURL(process.argv[1]));
const store=new McpOperationStore(JSON.parse(process.argv[2]));
await store.run(JSON.parse(process.argv[3]),async({markDispatched})=>{await markDispatched();await fs.writeFile(process.argv[4],'1');process.stdout.write('COMMITTED\\n');await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, modulePath, JSON.stringify(config), JSON.stringify(request), countPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture readiness timeout')), 5000);
    child.stdout.on('data', data => { if (data.toString().includes('COMMITTED')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('fixture closed before readiness')); });
  });
  child.kill('SIGKILL'); await exited;
  const lockPath = path.join(store.directory, `${request.operation_id}.lock`);
  const lockBefore = await fs.readFile(lockPath, 'utf8');
  const receipt = await store.run(request, () => assert.fail('crashed action replayed'));
  assert.equal(receipt.state, 'outcome_unknown'); assert.equal(receipt.retry_safe, false);
  assert.equal(await fs.readFile(countPath, 'utf8'), '1');
  assert.equal(await fs.readFile(lockPath, 'utf8'), lockBefore);
});

test('a prepared receipt from a previous owner is unknown even if dispatch was not recorded', async t => {
  const { store, config, request, receiptPath } = await fixture(t);
  const prepared = deferred(); const finish = deferred();
  const first = store.run(request, async () => { prepared.resolve(); await finish.promise; throw Object.assign(new Error('preflight'), { code: 'CONNECT_FAILED' }); });
  await prepared.promise;
  const other = new McpOperationStore(config);
  const status = await other.status(request.operation_id);
  assert.equal(status.state, 'outcome_unknown'); assert.equal(status.recorded_state, 'prepared'); assert.equal(status.dispatched, null);
  assert.equal(JSON.parse(await fs.readFile(receiptPath, 'utf8')).state, 'prepared');
  assert.equal((await other.run(request, () => assert.fail('prepared receipt replayed'))).retry_safe, false);
  finish.resolve(); await first;
});

test('known preflight failure is cached, exposes only an allowlisted code, and requires a new ID to retry', async t => {
  const { store, request, receiptPath } = await fixture(t); let calls = 0;
  const fail = async () => { calls++; throw Object.assign(new Error('PRIVATE_CREDENTIAL'), { code: 'CONNECT_FAILED', dispatched: false }); };
  const receipt = await store.run(request, fail);
  assert.equal(receipt.state, 'failed_preflight'); assert.equal(receipt.retry_safe, true); assert.equal(receipt.error_code, 'CONNECT_FAILED');
  await store.run(request, fail); assert.equal(calls, 1);
  assert.doesNotMatch(await fs.readFile(receiptPath, 'utf8'), /PRIVATE_CREDENTIAL/);
});

test('an existing lock without a receipt fails closed and is never removed', async t => {
  const { store, request } = await fixture(t);
  await fs.mkdir(store.directory); const lockPath = path.join(store.directory, `${request.operation_id}.lock`);
  await fs.writeFile(lockPath, 'unknown owner');
  const receipt = await store.run(request, () => assert.fail('lock bypassed'));
  assert.equal(receipt.state, 'outcome_unknown'); assert.equal(receipt.lock_present, true); assert.equal(receipt.retry_safe, false);
  assert.equal((await store.status(request.operation_id)).state, 'outcome_unknown');
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'unknown owner');
});

test('corrupted receipt or a changed persisted result fails explicitly without overwriting', async t => {
  const { store, request, receiptPath } = await fixture(t);
  await store.run(request, async ({ markDispatched }) => { await markDispatched(); return result; });
  const original = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  original.result.content[0].text = 'tampered';
  const corrupt = JSON.stringify(original); await fs.writeFile(receiptPath, corrupt);
  await assert.rejects(() => store.status(request.operation_id), { code: 'MCP_OPERATION_STORE_CORRUPT' });
  await assert.rejects(() => store.run(request, () => assert.fail('corruption bypassed')), { code: 'MCP_OPERATION_STORE_CORRUPT' });
  assert.equal(await fs.readFile(receiptPath, 'utf8'), corrupt);
  await fs.writeFile(receiptPath, '{broken');
  await assert.rejects(() => store.status(request.operation_id), { code: 'MCP_OPERATION_STORE_CORRUPT' });
});

test('oversized result and missing dispatch hook do not permit replay or falsely report completion', async t => {
  const { store, request } = await fixture(t, { maxResultBytes: 1024 }); let actions = 0;
  const receipt = await store.run(request, async ({ markDispatched }) => { await markDispatched(); actions++; return { content: [{ type: 'text', text: 'x'.repeat(1025) }] }; });
  assert.equal(receipt.state, 'outcome_unknown'); assert.equal(receipt.error_code, 'MCP_OPERATION_RESULT_TOO_LARGE');
  await store.run(request, () => actions++); assert.equal(actions, 1);
  const missing = await store.run({ ...request, operation_id: 'op_missing_hook_1' }, async () => result);
  assert.equal(missing.state, 'outcome_unknown'); assert.equal(missing.error_code, 'MCP_OPERATION_DISPATCH_NOT_MARKED');
});

test('invalid operation IDs cannot become paths and missing status is explicit', async t => {
  const { store, request } = await fixture(t);
  for (const id of ['../escape', 'short', '/absolute', 'C:\\badfile', 'a'.repeat(129), 'space id123', 'op\nsecret']) {
    await assert.rejects(() => store.status(id), { code: 'MCP_OPERATION_ID_INVALID' });
    await assert.rejects(() => store.run({ ...request, operation_id: id }, () => assert.fail()), { code: 'MCP_OPERATION_ID_INVALID' });
  }
  assert.equal((await store.status('op_not_created_123')).state, 'not_found');
});

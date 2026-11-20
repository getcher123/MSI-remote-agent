import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { McpServer } from '../server/lib/mcp-server.mjs';

function stdioHarness(handlers, { writeDelay = 0, outputError = null } = {}) {
  const input = new PassThrough();
  const replies = new Map(), waiters = new Map();
  const output = new Writable({ write(chunk, _encoding, done) {
    setTimeout(() => {
      if (outputError) return done(outputError);
      const reply = JSON.parse(chunk.toString('utf8'));
      replies.set(reply.id, reply);
      waiters.get(reply.id)?.(reply);
      done();
    }, writeDelay);
  } });
  const server = new McpServer({ tools: [], handlers, audit: { async record() {} }, input, output });
  return {
    input, server, replies,
    write(message) { input.write(`${JSON.stringify(message)}\n`); },
    response(id) {
      if (replies.has(id)) return Promise.resolve(replies.get(id));
      return new Promise(resolve => waiters.set(id, resolve));
    },
  };
}

const toolCall = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('slow tools preserve mutation order while control and operation status requests remain responsive', { timeout: 3000 }, async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const start = new Promise(resolve => { started = resolve; });
  const effects = [];
  const handlers = new Map([
    ['slow_effect', { mutation: true, async handler() { effects.push('first-start'); started(); await gate; effects.push('first-end'); return { done: true }; } }],
    ['next_effect', { mutation: true, async handler() { effects.push('second'); return { done: true }; } }],
    ['unlisted_read', { mutation: false, async handler() { effects.push('ordinary-read'); return {}; } }],
    ['codex_delivery_status', { mutation: false, async handler() { return { phase: 'prepared' }; } }],
    ['local_mcp_operation', { mutation: false, async handler() { return { state: 'in_flight' }; } }],
  ]);
  const harness = stdioHarness(handlers);
  const serving = harness.server.serveStdio();
  try {
    harness.write(toolCall(1, 'slow_effect'));
    await start;
    harness.write(toolCall(2, 'next_effect'));
    harness.write(toolCall(3, 'unlisted_read'));
    harness.write({ jsonrpc: '2.0', id: 4, method: 'ping' });
    harness.write({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    harness.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    harness.write({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
    harness.write(toolCall(7, 'codex_delivery_status'));
    harness.write(toolCall(8, 'local_mcp_operation'));
    const [ping, init, list, codex, operation] = await Promise.all([4, 5, 6, 7, 8].map(id => harness.response(id)));
    assert.deepEqual(ping.result, {});
    assert.equal(init.result.serverInfo.name, 'aihub-remote-agent');
    assert.deepEqual(list.result.tools, []);
    assert.equal(codex.result.structuredContent.phase, 'prepared');
    assert.equal(operation.result.structuredContent.state, 'in_flight');
    assert.equal(harness.server.initialized, true);
    assert.deepEqual(effects, ['first-start']);
    assert.equal(harness.replies.has(1), false);
    assert.equal(harness.replies.has(2), false);
    assert.equal(harness.replies.has(3), false);
  } finally {
    release();
    harness.input.end();
    await serving;
  }
  assert.deepEqual(effects, ['first-start', 'first-end', 'second', 'ordinary-read']);
  assert.deepEqual([...harness.replies.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('EOF drains accepted tools, parse errors and delayed stdout writes', { timeout: 3000 }, async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const start = new Promise(resolve => { started = resolve; });
  const harness = stdioHarness(new Map([
    ['slow_effect', { mutation: true, async handler() { started(); await gate; return { done: true }; } }],
    ['failed_effect', { mutation: true, async handler() { throw new Error('Synthetic handler failure'); } }],
  ]), { writeDelay: 15 });
  let finished = false;
  const serving = harness.server.serveStdio().then(() => { finished = true; });
  harness.write(toolCall(1, 'slow_effect'));
  await start;
  harness.write(toolCall(2, 'failed_effect'));
  harness.input.write('{invalid JSON}\n');
  harness.write({ id: 3, method: 'ping' });
  harness.input.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await serving;
  assert.equal(harness.replies.get(1).result.structuredContent.done, true);
  assert.equal(harness.replies.get(2).result.isError, true);
  assert.equal(harness.replies.get(null).error.code, -32700);
  assert.equal(harness.replies.get(3).error.code, -32600);
});

test('a failed stdout write rejects serving without unhandled stream errors', { timeout: 3000 }, async () => {
  const outputError = Object.assign(new Error('Synthetic closed output'), { code: 'EPIPE' });
  const harness = stdioHarness(new Map(), { outputError });
  const serving = harness.server.serveStdio();
  const rejected = assert.rejects(serving, { code: 'EPIPE' });
  harness.write({ jsonrpc: '2.0', id: 1, method: 'ping' });
  harness.input.end();
  await rejected;
});

test('structured tool errors retain only validated operation lookup metadata', { timeout: 3000 }, async () => {
  const handlers = new Map([
    ['conflict', { mutation: true, async handler() {
      throw Object.assign(new Error('Synthetic operation conflict'), {
        code: 'CODEX_OPERATION_CONFLICT', operation_id: 'fixture-operation-0001', receipt_id: 'codexsend_fixture_0001',
        debug: 'PRIVATE DIAGNOSTIC', stderr: 'PRIVATE STDERR',
      });
    } }],
    ['invalid_metadata', { mutation: true, async handler() {
      throw Object.assign(new Error('Synthetic failure'), { code: 'invalid private text', operation_id: '/private/path', receipt_id: '../private' });
    } }],
  ]);
  const harness = stdioHarness(handlers);
  const serving = harness.server.serveStdio();
  harness.write(toolCall(1, 'conflict'));
  harness.write(toolCall(2, 'invalid_metadata'));
  harness.input.end();
  await serving;
  const result = harness.replies.get(1).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'CODEX_OPERATION_CONFLICT');
  assert.equal(result.structuredContent.operation_id, 'fixture-operation-0001');
  assert.equal(result.structuredContent.receipt_id, 'codexsend_fixture_0001');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const invalid = harness.replies.get(2).result.structuredContent;
  assert.equal(invalid.error_code, undefined);
  assert.equal(invalid.operation_id, undefined);
  assert.equal(invalid.receipt_id, undefined);
});

function rpc(child, message) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.id === message.id) {
          child.stdout.off('data', onData);
          resolve(parsed);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify(message)}\n`);
    setTimeout(() => { child.stdout.off('data', onData); reject(new Error('RPC timeout')); }, 5000).unref();
  });
}

test('MCP initialize and tools/list work over stdio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-mcp-'));
  const fakeAdapter = path.join(root, 'adapter.py');
  const fakeSender = path.join(root, 'sender.py');
  await fs.writeFile(fakeAdapter, '# fake');
  await fs.writeFile(fakeSender, '# fake');
  const config = {
    deviceId: 'test-device',
    stateDir: path.join(root, 'state'),
    allowedRoots: [{ path: root, permissions: ['read','write'] }], deniedPathFragments: [],
    wsl: { distro: 'Ubuntu-22.04', user: 'testuser' },
    commandPolicy: { allowedExecutables: ['node'], deniedPatterns: [] },
    codex: { adapterPath: fakeAdapter, uiSenderPath: fakeSender },
  };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [path.resolve('server/index.mjs'), '--stdio'], {
    cwd: path.resolve('.'), env: { ...process.env, AIHUB_REMOTE_AGENT_CONFIG: configPath }, stdio: ['pipe','pipe','pipe'],
  });
  try {
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.result.serverInfo.name, 'aihub-remote-agent');
    const list = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = list.result.tools.map((x) => x.name);
    assert.ok(names.includes('codex_send_message'));
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('start_process'));
  } finally {
    child.stdin.end();
    child.kill();
  }
});

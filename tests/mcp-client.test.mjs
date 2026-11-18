import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalMcpClient, McpClientError, SUPPORTED_MCP_PROTOCOLS } from '../server/lib/mcp-client.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mcp-fixture.mjs', import.meta.url));
const stdio = (extra = {}) => new LocalMcpClient({ transport: 'stdio', command: process.execPath, args: [fixture], timeoutMs: 1500, ...extra });

test('stdio negotiates, preserves multimodal results, resources, prompts and pagination', async () => {
  const client = stdio();
  try {
    const info = await client.connect();
    assert.equal(info.protocol_version, '2025-11-25');
    assert.deepEqual(info.server, { name: 'fixture', version: '1' });
    assert.equal(JSON.stringify(info).includes('PRIVATE'), false);
    const first = await client.listTools();
    assert.equal(first.nextCursor, 'page:2');
    assert.equal((await client.listTools({ cursor: first.nextCursor })).tools[0].name, 'second');
    let hookComplete = false;
    const result = await client.callTool('echo', { value: 'тест' }, { onDispatched: async () => { await delay(10); hookComplete = true; } });
    assert.equal(hookComplete, true);
    assert.deepEqual(result.content.map(item => item.type), ['text', 'image', 'resource', 'resource_link']);
    assert.equal(result.content[0].text, 'Русский текст 🧪');
    assert.equal(result.content[1].data, 'aGVsbG8=');
    assert.deepEqual(result.structuredContent.args, { value: 'тест' });
    assert.equal((await client.listResources()).resources[0].uri, 'fixture://one');
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
    assert.equal((await client.readResource('fixture://one')).contents[0].text, 'resource text');
    assert.equal((await client.listPrompts()).prompts[0].name, 'greet');
    assert.equal((await client.getPrompt('greet', { name: 'Иван' })).messages[0].content.text, 'Hello Иван');
  } finally { assert.equal((await client.close()).process_exit_confirmed, true); }
});

test('stdio supports only explicitly implemented initialize-based protocol versions', async () => {
  for (const protocol of SUPPORTED_MCP_PROTOCOLS) {
    const client = stdio({ env: { ...process.env, FIXTURE_PROTOCOL: protocol } });
    try { assert.equal((await client.connect()).protocol_version, protocol); }
    finally { await client.close(); }
  }
  const unsupported = stdio({ env: { ...process.env, FIXTURE_PROTOCOL: '2026-07-28' } });
  try { await assert.rejects(unsupported.connect(), { code: 'UNSUPPORTED_NEGOTIATED_PROTOCOL', dispatched: false }); }
  finally { await unsupported.close(); }
});

test('stdio handles peer ping, refuses unadvertised sampling, omits raw peer errors', async () => {
  const client = stdio();
  try {
    const result = await client.callTool('ask_client');
    assert.deepEqual(JSON.parse(result.content[0].text), [{ id: 9101, error: null }, { id: 9102, error: -32601 }]);
    await assert.rejects(client.callTool('error'), error => {
      assert(error instanceof McpClientError);
      assert.equal(error.code, 'RPC_ERROR');
      assert.equal(error.rpcCode, -32602);
      assert.equal(error.dispatched, true);
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.message.includes('PRIVATE'), false);
      return true;
    });
  } finally { await client.close(); }
});

test('failed durable dispatch hook prevents stdio send', async () => {
  const client = stdio();
  try {
    await assert.rejects(client.callTool('echo', {}, { onDispatched: async () => { throw new Error('PRIVATE callback failure'); } }), { dispatched: false, outcomeUnknown: false });
    assert.equal((await client.callTool('stats')).content[0].text, '0');
  } finally { await client.close(); }
});

test('stdio timeout has unknown outcome; late reply never causes replay', async () => {
  const client = stdio();
  try {
    await client.connect();
    await assert.rejects(client.callTool('slow', {}, { timeoutMs: 20 }), { code: 'REQUEST_TIMEOUT', dispatched: true, outcomeUnknown: true });
    await delay(200);
    assert.equal((await client.callTool('stats')).content[0].text, '1');
  } finally { await client.close(); }
});

test('stdio disconnect after side effect does not restart or replay', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-mcp-client-'));
  const counter = path.join(dir, 'counter.txt');
  const client = stdio({ env: { ...process.env, FIXTURE_COUNTER_FILE: counter } });
  try {
    await assert.rejects(client.callTool('crash'), { dispatched: true, outcomeUnknown: true });
    await assert.rejects(client.callTool('echo'), { dispatched: false });
    assert.equal(await fs.readFile(counter, 'utf8'), 'crash\n');
  } finally { await client.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('stdio rejects oversized frames and closes only its owned child', async () => {
  const client = stdio({ maxMessageBytes: 1024 });
  try { await assert.rejects(client.callTool('huge'), { code: 'MESSAGE_TOO_LARGE', dispatched: true, outcomeUnknown: true }); }
  finally { assert.equal((await client.close()).process_exit_confirmed, true); }
});

test('async spawn adapter and explicit close force flag are preserved', async () => {
  let closedWith;
  const client = stdio({
    spawnFn: async (...args) => { const child = spawn(...args); child.stdout.pause(); await once(child, 'spawn'); return child; },
    closeFn: async (child, options) => {
      closedWith = options;
      const ended = once(child, 'close');
      child.stdin.end();
      await ended;
      return { closed: true, process_exit_confirmed: true };
    },
  });
  await client.connect();
  await client.close();
  assert.equal(closedWith.force, false);
});

test('constructor rejects unsupported modern protocol, header overrides and URL credentials', () => {
  assert.throws(() => stdio({ protocol: 'modern' }), { code: 'UNSUPPORTED_PROTOCOL' });
  assert.throws(() => new LocalMcpClient({ transport: 'streamable-http', url: 'http://user:password@localhost/mcp' }), { code: 'INVALID_ENDPOINT' });
  assert.throws(() => new LocalMcpClient({ transport: 'streamable-http', url: 'http://localhost/mcp', headers: { 'Mcp-Session-Id': 'inject' } }), { code: 'INVALID_HEADERS' });
});

test('handshake timeout is not misreported as dispatch of the requested tool', async () => {
  const client = stdio({ env: { ...process.env, FIXTURE_STALL_INIT: '1' }, timeoutMs: 30 });
  let dispatched = false;
  try {
    await assert.rejects(client.callTool('echo', {}, { onDispatched: () => { dispatched = true; } }), { code: 'REQUEST_TIMEOUT', dispatched: false, outcomeUnknown: false });
    assert.equal(dispatched, false);
  } finally { await client.close(); }
});

test('explicit force close can follow an unconfirmed soft close, without automatic escalation', async () => {
  const attempts = [];
  const client = stdio({ closeFn: async (child, options) => {
    attempts.push(options.force);
    if (!options.force) return { closed: false, process_exit_confirmed: false };
    const ended = once(child, 'close');
    child.kill('SIGKILL');
    await ended;
    return { closed: true, process_exit_confirmed: true };
  } });
  await client.connect();
  assert.equal((await client.close()).closed, false);
  assert.deepEqual(attempts, [false]);
  assert.equal((await client.close({ force: true })).closed, true);
  assert.deepEqual(attempts, [false, true]);
});

test('standalone client never passes tunnel credential to its spawned child', async () => {
  let observed;
  const client = stdio({
    env: { ...process.env, CONTROL_PLANE_API_KEY: 'private-test-tunnel-key' },
    spawnFn: (...args) => { observed = args[2].env; return spawn(...args); },
  });
  try { await client.connect(); assert.equal(observed.CONTROL_PLANE_API_KEY, undefined); }
  finally { await client.close(); }
});

async function httpFixture({ mode = 'json' } = {}) {
  const received = [], sockets = new Set();
  let callCount = 0, redirected = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/redirected') { redirected++; res.end(); return; }
    if (req.method === 'DELETE') { received.push({ method: 'DELETE', headers: req.headers }); res.writeHead(204).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks));
    received.push({ ...message, headers: req.headers });
    if (!message.method || message.id === undefined) { res.writeHead(202).end(); return; }
    const send = result => res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') { send({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'HTTP fixture', version: '1' } }); return; }
    if (message.method === 'tools/list') { send({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }); return; }
    if (message.method === 'tools/call') {
      callCount++;
      if (mode === 'drop') { res.destroy(); return; }
      if (mode === 'timeout') return;
      if (mode === '404') { res.writeHead(404).end('PRIVATE error body'); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: '/redirected' }).end(); return; }
      if (mode === 'huge') { send({ content: [{ type: 'text', text: 'x'.repeat(12000) }] }); return; }
      if (mode === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'test-session' });
        res.write(': keep alive\r\n\r\n');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'ping' })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\r\n\r\n`);
        const result = { content: [{ type: 'text', text: 'SSE 🧪' }], structuredContent: { value: 7 }, isError: false };
        res.write(`data: {"jsonrpc":"2.0",\r\ndata: "id":${message.id},"result":${JSON.stringify(result)}}\r\n\r\n`);
        return; // Client must finish on the result, without waiting for a forever-open stream.
      }
      send({ content: [{ type: 'text', text: 'HTTP result' }], structuredContent: { count: callCount }, isError: false });
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, received,
    count: () => callCount, redirected: () => redirected,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('Streamable HTTP keeps session and negotiated version, returns JSON without replay', async () => {
  const peer = await httpFixture();
  const client = new LocalMcpClient({ transport: 'streamable-http', url: peer.url, headers: { Authorization: 'Bearer private-test-value' } });
  try {
    assert.equal((await client.connect()).protocol_version, '2025-06-18');
    assert.equal((await client.listTools()).tools.length, 1);
    assert.equal((await client.callTool('echo')).structuredContent.count, 1);
    const call = peer.received.find(item => item.method === 'tools/call');
    assert.equal(call.headers['mcp-session-id'], 'test-session');
    assert.equal(call.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(call.headers.authorization, 'Bearer private-test-value');
    assert.equal(JSON.stringify(client.info).includes('private-test-value'), false);
  } finally {
    assert.equal((await client.close()).session_closed, true);
    await peer.close();
  }
});

test('Streamable HTTP accepts multiline SSE, replies to ping, ends on result', async () => {
  const peer = await httpFixture({ mode: 'sse' });
  const client = new LocalMcpClient({ transport: 'streamable-http', url: peer.url, timeoutMs: 1000 });
  try {
    const result = await client.callTool('echo');
    assert.equal(result.content[0].text, 'SSE 🧪');
    assert.equal(result.structuredContent.value, 7);
    assert(peer.received.some(item => item.id === 9999 && item.result));
    assert.equal(peer.count(), 1);
  } finally { await client.close(); await peer.close(); }
});

test('HTTP disconnect, timeout, session 404 and redirects never replay a tool call', async () => {
  for (const mode of ['drop', 'timeout', '404', 'redirect']) {
    const peer = await httpFixture({ mode });
    const client = new LocalMcpClient({ transport: 'streamable-http', url: peer.url, timeoutMs: 1000 });
    try {
      await client.connect();
      await assert.rejects(client.callTool('echo', {}, { timeoutMs: 50 }), error => {
        assert.equal(error.dispatched, true, mode);
        assert.equal(error.outcomeUnknown, true, mode);
        assert.equal(error.message.includes('PRIVATE'), false);
        return true;
      });
      assert.equal(peer.count(), 1, mode);
      assert.equal(peer.received.filter(item => item.method === 'initialize').length, 1, mode);
      assert.equal(peer.redirected(), 0);
    } finally { await client.close(); await peer.close(); }
  }
});

test('HTTP dispatch hook failure never sends, and response body limit is enforced', async () => {
  const peer = await httpFixture({ mode: 'huge' });
  const client = new LocalMcpClient({ transport: 'streamable-http', url: peer.url, maxMessageBytes: 1024 });
  try {
    await assert.rejects(client.callTool('echo', {}, { onDispatched: async () => { throw new Error('PRIVATE hook'); } }), { dispatched: false, outcomeUnknown: false });
    assert.equal(peer.count(), 0);
    await assert.rejects(client.callTool('echo'), { code: 'MESSAGE_TOO_LARGE', dispatched: true, outcomeUnknown: true });
    assert.equal(peer.count(), 1);
  } finally { await client.close(); await peer.close(); }
});

test('HTTP session 404 invalidates cached connected status without reinitialization or replay', async () => {
  const peer = await httpFixture({ mode: '404' });
  const client = new LocalMcpClient({ transport: 'streamable-http', url: peer.url });
  try {
    await client.connect();
    assert.equal(client.connected, true);
    await assert.rejects(client.callTool('echo'), { code: 'HTTP_STATUS', httpStatus: 404, dispatched: true, outcomeUnknown: true });
    assert.equal(client.connected, false);
    await assert.rejects(client.connect(), { code: 'CONNECTION_FAILED', dispatched: false });
    await assert.rejects(client.callTool('echo'), { dispatched: false, outcomeUnknown: false });
    assert.equal(peer.count(), 1);
    assert.equal(peer.received.filter(item => item.method === 'initialize').length, 1);
  } finally { await client.close(); await peer.close(); }
});

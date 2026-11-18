import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalMcpBridge } from '../server/lib/local-mcp-bridge.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { McpServer } from '../server/lib/mcp-server.mjs';
import { AuditLog } from '../server/lib/audit.mjs';
import { registerLocalMcpTools } from '../server/lib/local-mcp-tools.mjs';

const fixtureScript = fileURLToPath(new URL('./fixtures/bridge-fixture.mjs', import.meta.url));
const PRIVATE = 'fixture-private-launch-metadata';
const terminal = new Set(['completed', 'outcome_unknown', 'failed_preflight']);

async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-bridge-'));
  const source = path.join(dir, 'mcp.json');
  const counterFile = path.join(dir, 'counter.txt');
  const raw = { mcpServers: { fixture: {
    command: process.execPath,
    args: [fixtureScript, `--private=${PRIVATE}`],
    cwd: dir,
    env: { BRIDGE_COUNTER_FILE: counterFile, BRIDGE_PRIVATE_VALUE: PRIVATE },
    disabled_tools: ['forbidden'],
    ...overrides,
  } } };
  await fs.writeFile(source, JSON.stringify(raw));
  const config = {
    __stateDir: path.join(dir, 'state'),
    processLogDir: path.join(dir, 'processes'),
    auditLog: path.join(dir, 'audit.jsonl'),
    wsl: { user: 'bridgefixture', distro: 'fixture' },
    allowedRoots: [{ path: dir, permissions: ['read', 'write'] }],
    deniedPathFragments: [],
    commandPolicy: { allowedExecutables: [process.execPath], deniedPatterns: [], maxOutputChars: 4096 },
    localMcp: { sources: [{ path: source, runtime: 'windows' }], maxResultBytes: 1024 * 1024 },
  };
  const policy = new PathPolicy(config);
  const manager = new ProcessManager(config, policy);
  const bridge = new LocalMcpBridge(config, policy, manager);
  const bridges = [bridge];
  t.after(async () => {
    const pending = bridges.flatMap(current => [...current.operations.active.values()].map(active => active.promise));
    if (pending.length) await Promise.race([Promise.allSettled(pending), delay(2000, undefined, { ref: false })]);
    for (const current of bridges) await current.closeAll().catch(() => {});
    for (const session of manager.sessions.values()) if (!session.closed) await manager.terminateInternal(session.id, true, 'test_cleanup', 1000).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  await bridge.register({ server_id: 'fixture', source_path: source, source_name: 'fixture', runtime: 'windows', confirm_mutation: true });
  const getCount = async () => { try { return Number(await fs.readFile(counterFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
  const restart = () => {
    const next = new LocalMcpBridge(config, policy, manager);
    bridges.push(next); return next;
  };
  const call = (operation_id, args = {}, extra = {}) => bridge.call({ server_id: 'fixture', tool_name: 'increment', arguments: args, operation_id, confirm_mutation: true, wait_ms: 1000, ...extra });
  return { dir, source, raw, counterFile, config, policy, manager, bridge, bridges, call, getCount, restart };
}

async function complete(bridge, receipt, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!terminal.has(receipt.state)) {
    if (Date.now() >= until) throw new Error(`Receipt did not complete: ${receipt.state}`);
    await delay(15);
    receipt = await bridge.operation({ operation_id: receipt.operation_id });
  }
  return receipt;
}

function outerServer(bridge, config) {
  const handlers = new Map(), tools = [];
  registerLocalMcpTools((name, description, inputSchema, handler, { mutation = false } = {}) => {
    tools.push({ name, description, inputSchema }); handlers.set(name, { handler, mutation });
  }, bridge);
  const server = new McpServer({ tools, handlers, audit: new AuditLog(config) });
  return {
    server,
    async invoke(name, args = {}) {
      let response;
      server.writeResult = (id, result) => { response = { id, result }; };
      server.writeError = (id, code, message) => { response = { id, error: { code, message } }; };
      await server.callTool('fixture-request', { name, arguments: args });
      assert.ok(response, 'Outer MCP must return a response');
      assert.equal(response.error, undefined);
      return response.result;
    },
  };
}

test('discovery/registration do not launch; live tools preserve pagination and exclude disabled tool', async t => {
  const f = await setup(t);
  const found = await f.bridge.discover();
  assert.ok(found.servers.some(server => server.source_name === 'fixture'));
  assert.equal(f.manager.sessions.size, 0);
  const page = await f.bridge.tools({ server_id: 'fixture' });
  assert.deepEqual(page.tools.map(tool => tool.name), ['increment']);
  assert.equal(page.nextCursor, 'second');
  const page2 = await f.bridge.tools({ server_id: 'fixture', cursor: page.nextCursor });
  assert.ok(page2.tools.some(tool => tool.name === 'mixed_content'));
  assert.equal((await f.bridge.servers()).servers[0].connection, 'connected');
  const denied = await complete(f.bridge, await f.call('blocked-tool-0001', {}, { tool_name: 'forbidden' }));
  assert.equal(denied.state, 'failed_preflight');
  assert.equal(await f.getCount(), 0);
});

test('concurrent identical operation IDs execute the real child action exactly once', async t => {
  const f = await setup(t);
  const receipts = await Promise.all([f.call('duplicate-call-0001', { delay_ms: 80 }), f.call('duplicate-call-0001', { delay_ms: 80 })]);
  for (const initial of receipts) {
    const receipt = await complete(f.bridge, initial);
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.result.structuredContent.counter, 1);
  }
  const replay = await f.call('duplicate-call-0001', { delay_ms: 80 });
  assert.equal(replay.state, 'completed');
  assert.equal(await f.getCount(), 1);
  await assert.rejects(f.call('duplicate-call-0001', { delay_ms: 81 }));
  assert.equal(await f.getCount(), 1);
});

test('short wait returns a durable receipt and polling returns the result without another action', async t => {
  const f = await setup(t);
  const initial = await f.call('async-receipt-0001', { delay_ms: 200 }, { wait_ms: 1 });
  assert.ok(['prepared', 'in_flight'].includes(initial.state));
  const receipt = await complete(f.bridge, initial);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.result.structuredContent.counter, 1);
  assert.equal((await f.bridge.operation({ operation_id: initial.operation_id })).state, 'completed');
  assert.equal(await f.getCount(), 1);
});

test('lost reply after actual effect remains unknown across restart and is never replayed', async t => {
  const f = await setup(t);
  const initial = await f.call('dropped-result-0001', { drop_reply: true }, { timeout_ms: 80 });
  const receipt = await complete(f.bridge, initial);
  assert.equal(receipt.state, 'outcome_unknown');
  assert.equal(await f.getCount(), 1);
  await f.bridge.disconnect({ server_id: 'fixture', confirm_mutation: true });
  const next = f.restart();
  const replay = await next.call({ server_id: 'fixture', tool_name: 'increment', arguments: { drop_reply: true }, operation_id: 'dropped-result-0001', confirm_mutation: true, timeout_ms: 80 });
  assert.equal(replay.state, 'outcome_unknown');
  assert.equal(await f.getCount(), 1);
  assert.equal(next.sessions.size, 0, 'A recorded unknown outcome must not reconnect or resend');
});

test('native tool reply preserves image/audio/resource blocks, upstream metadata and error flag', async t => {
  const f = await setup(t);
  const outer = outerServer(f.bridge, f.config);
  let result = await outer.invoke('local_mcp_call', { server_id: 'fixture', tool_name: 'mixed_content', arguments: { fail: true }, operation_id: 'native-content-0001', confirm_mutation: true, wait_ms: 1000 });
  if (!terminal.has(result.structuredContent.operation.state)) {
    await complete(f.bridge, result.structuredContent.operation);
    result = await outer.invoke('local_mcp_operation', { operation_id: 'native-content-0001' });
  }
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.operation.state, 'completed');
  assert.deepEqual(result.structuredContent.upstream, { object_count: 1 });
  assert.deepEqual(result._meta, { fixture: 'preserved' });
  assert.deepEqual(result.content.map(block => block.type), ['text', 'text', 'image', 'audio', 'resource', 'resource_link']);
  assert.equal(result.content.find(block => block.type === 'image').mimeType, 'image/png');
  assert.ok(Buffer.from(result.content.find(block => block.type === 'image').data, 'base64').length > 30);
  assert.equal(result.content.find(block => block.type === 'resource').resource.text, '{"objects":1}');
  const audit = await fs.readFile(f.config.auditLog, 'utf8');
  assert.ok(!audit.includes('Сцена доступна'));
  assert.ok(!audit.includes('iVBORw0K'));
  assert.ok(!audit.includes(PRIVATE));
});

test('native resource and prompt calls keep embedded content without filesystem dereferencing', async t => {
  const f = await setup(t);
  const outer = outerServer(f.bridge, f.config);
  const resources = await f.bridge.resources({ server_id: 'fixture' });
  assert.equal(resources.resources[0].uri, 'fixture://scene/1');
  const resource = await outer.invoke('local_mcp_read_resource', { server_id: 'fixture', uri: 'fixture://scene/1' });
  assert.equal(resource.isError, false);
  assert.equal(resource.content[1].type, 'resource');
  assert.equal(resource.content[1].resource.uri, 'fixture://scene/1');
  const prompt = await outer.invoke('local_mcp_get_prompt', { server_id: 'fixture', name: 'scene-help', arguments: { scene: 'test-scene' } });
  assert.equal(prompt.structuredContent.message_count, 2);
  assert.ok(prompt.content.some(block => block.type === 'image'));
  assert.ok(prompt.content.some(block => block.type === 'text' && block.text === 'Inspect test-scene'));
});

test('connected server source tampering is refused before any second tool action', async t => {
  const f = await setup(t);
  await complete(f.bridge, await f.call('before-tamper-0001'));
  f.raw.mcpServers.fixture.env.BRIDGE_PRIVATE_VALUE = 'changed-definition';
  await fs.writeFile(f.source, JSON.stringify(f.raw));
  await assert.rejects(f.bridge.tools({ server_id: 'fixture' }), { code: 'MCP_SOURCE_CHANGED' });
  await assert.rejects(f.call('after-tamper-00001'), { code: 'MCP_SOURCE_CHANGED' });
  assert.equal(await f.getCount(), 1);
});

test('internal MCP process has no public session, no public stdin/output/termination, no JSONL protocol log', async t => {
  const f = await setup(t);
  await f.bridge.tools({ server_id: 'fixture' });
  const pid = f.bridge.sessions.get('fixture').processId;
  assert.deepEqual(f.manager.list(), []);
  assert.throws(() => f.manager.output(pid), /Unknown process session/);
  await assert.rejects(f.manager.input(pid, 'test'), /Unknown process session/);
  await assert.rejects(f.manager.terminate(pid), /Unknown process session/);
  assert.equal(f.manager.getInternal(pid).output.stdout.total, 0);
  assert.deepEqual(await fs.readdir(f.config.processLogDir), []);
  assert.ok(!JSON.stringify(await f.bridge.servers()).includes(PRIVATE));
});

test('ambient control-plane credentials are stripped from the actual MCP child', async t => {
  const oldUpper = process.env.CONTROL_PLANE_API_KEY;
  const oldLower = process.env.control_plane_api_key;
  process.env['CONTROL_PLANE_API_KEY'] = 'fixture-not-real-tunnel-secret';
  process.env.control_plane_api_key = 'fixture-not-real-lowercase-secret';
  t.after(() => {
    if (oldUpper === undefined) delete process.env.CONTROL_PLANE_API_KEY; else process.env.CONTROL_PLANE_API_KEY = oldUpper;
    if (oldLower === undefined) delete process.env.control_plane_api_key; else process.env.control_plane_api_key = oldLower;
  });
  const f = await setup(t);
  const receipt = await complete(f.bridge, await f.call('environment-test-0001', {}, { tool_name: 'environment_probe' }));
  assert.deepEqual(receipt.result.structuredContent, { tunnel_credential_present: false, explicit_value_present: true });
});

test('disconnect confirms only the owned MCP child exits while a separate process remains running', async t => {
  const f = await setup(t);
  await f.bridge.tools({ server_id: 'fixture' });
  const internalId = f.bridge.sessions.get('fixture').processId;
  const other = await f.manager.start({ runtime: 'windows', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: f.dir });
  const report = await f.bridge.disconnect({ server_id: 'fixture', confirm_mutation: true });
  assert.equal(report.disconnected, true);
  assert.equal(report.process_exit_confirmed, true);
  assert.equal(f.manager.getInternal(internalId).closed, true);
  assert.equal(f.manager.get(other.session_id).closed, false);
  assert.equal(f.manager.list().length, 1);
  assert.equal(f.bridge.sessions.size, 0);
});

test('blocked executable produces a failed-preflight receipt and creates no child or effect', async t => {
  const f = await setup(t, { command: 'aihub-not-an-allowed-executable' });
  const receipt = await complete(f.bridge, await f.call('denied-command-0001'));
  assert.equal(receipt.state, 'failed_preflight');
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(await f.getCount(), 0);
});

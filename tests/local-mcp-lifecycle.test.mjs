import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalMcpBridge } from '../server/lib/local-mcp-bridge.mjs';

test('exited WSL wrapper does not hide an unconfirmed owned process group or permit unregister', async () => {
  const identity = { pid: 42001, pgid: 42001, uid: 1000, start_time: '100001' };
  const child = { stdin: { destroyed: false, end() { this.destroyed = true; } } };
  const tracked = { runtime: 'wsl', closed: false, wslIdentity: identity, child };
  const probes = [];
  let groupAbsent = false, signals = 0, unregistrations = 0;
  const manager = {
    validateCommand() {},
    async start(_args, options) {
      assert.equal(options.internal, true);
      assert.equal(options.captureOutput, false);
      assert.equal(options.logOutput, false);
      return { session_id: 'owned-wsl-fixture' };
    },
    getInternal(id) { assert.equal(id, 'owned-wsl-fixture'); return tracked; },
    async wslControl(value, signal) {
      probes.push({ value, signal });
      return { stdout: JSON.stringify({ group_absent: groupAbsent }) };
    },
    async terminateInternal() { signals++; throw new Error('An exited wrapper PID must not be signalled'); },
  };
  const registry = {
    async resolve() { return { fingerprint: 'a'.repeat(64), definition: { transport: 'stdio', runtime: 'wsl', command: 'python3', args: [] } }; },
    async unregister() { unregistrations++; return { removed: true }; },
  };
  const bridge = new LocalMcpBridge({}, {}, manager, { registry, operations: {},
    clientFactory: spec => ({
      connected: false, info: null,
      async connect() { await spec.spawnFn(); this.connected = true; },
      async listTools() { return { tools: [] }; },
      async close(options) { this.connected = false; return spec.closeFn(child, options); },
    }),
  });
  await bridge.tools({ server_id: 'wsl-fixture' });
  tracked.closed = true; // The tracked launcher/leader ended; a group member survives.

  const first = await bridge.disconnect({ server_id: 'wsl-fixture', confirm_mutation: true });
  assert.equal(first.process_exit_confirmed, true);
  assert.equal(first.disconnected, false);
  assert.equal(first.close_report.tree_exit_confirmed, false);
  assert.equal(bridge.sessions.has('wsl-fixture'), true);

  await bridge.closeAll();
  assert.equal(bridge.sessions.has('wsl-fixture'), true, 'Shutdown must retain an unconfirmed group');
  await assert.rejects(bridge.unregister({ server_id: 'wsl-fixture', force: true, confirm_mutation: true }), { code: 'MCP_PROCESS_STILL_RUNNING' });
  assert.equal(unregistrations, 0);
  assert.equal(signals, 0, 'Force must not signal a possibly recycled exited PID');
  assert(probes.every(probe => probe.value === identity && probe.signal === 'PROBE'));

  groupAbsent = true;
  const confirmed = await bridge.disconnect({ server_id: 'wsl-fixture', confirm_mutation: true });
  assert.equal(confirmed.disconnected, true);
  assert.equal(confirmed.close_report.tree_exit_confirmed, true);
  assert.equal(bridge.sessions.has('wsl-fixture'), false);
});

test('queued call stays pinned to its original server fingerprint and queued registration is refused', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-mcp-lifecycle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const oldDefinition = { fingerprint: 'a'.repeat(64), definition: { transport: 'streamable-http', url: 'http://127.0.0.1:40101/mcp' } };
  const newDefinition = { fingerprint: 'b'.repeat(64), definition: { transport: 'streamable-http', url: 'http://127.0.0.1:40102/mcp' } };
  let resolutions = 0, calls = 0, toolsReads = 0, registrations = 0, releaseQueued;
  const registry = {
    async resolve(id) {
      if (id === 'queued-fixture') return new Promise(resolve => { releaseQueued = resolve; });
      return ++resolutions === 1 ? oldDefinition : newDefinition;
    },
    async register() { registrations++; return { registered: true }; },
  };
  const bridge = new LocalMcpBridge({ __stateDir: dir }, {}, {}, { registry,
    clientFactory: () => ({
      connected: false, info: null,
      async connect() { this.connected = true; },
      async listTools() { toolsReads++; return { tools: [{ name: 'effect', inputSchema: { type: 'object' } }] }; },
      async callTool(_name, _args, options) {
        await options.onDispatched(); calls++;
        return { content: [{ type: 'text', text: 'effect performed' }] };
      },
      async close() { this.connected = false; return { closed: true }; },
    }),
  });
  t.after(() => bridge.closeAll());
  let receipt = await bridge.call({ server_id: 'swapped-fixture', tool_name: 'effect', operation_id: 'fingerprint-race-0001', arguments: {}, confirm_mutation: true, wait_ms: 1000 });
  if (receipt.pending) receipt = await bridge.operations.active.get('fingerprint-race-0001').promise;
  assert.equal(receipt.server_fingerprint, oldDefinition.fingerprint);
  assert.equal(receipt.state, 'failed_preflight');
  assert.equal(receipt.dispatched, false);
  assert.equal(calls, 0, 'The new target must not receive the original target operation');
  assert.equal(toolsReads, 0, 'Fingerprint must be checked before discovering tools on the replacement');

  const pending = bridge.withServer('queued-fixture', async () => 'ready');
  // Allow getSession to enter the deliberately blocked resolver; no session exists yet.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.sessions.has('queued-fixture'), false);
  assert.equal(bridge.queues.has('queued-fixture'), true);
  try {
    await assert.rejects(bridge.register({ server_id: 'queued-fixture', confirm_mutation: true }), { code: 'DISCONNECT_MCP_BEFORE_REGISTER' });
    assert.equal(registrations, 0);
  } finally {
    releaseQueued(newDefinition);
    await pending;
  }
});

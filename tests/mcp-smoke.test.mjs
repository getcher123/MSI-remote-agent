import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

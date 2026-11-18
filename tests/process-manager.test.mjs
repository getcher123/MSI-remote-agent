import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('starts and reads an allowlisted process', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    wsl: { distro: 'Ubuntu-22.04', user: 'testuser' },
    allowedRoots: [{ path: root, permissions: ['read','write'] }],
    deniedPathFragments: [],
    processLogDir: path.join(root, 'logs'),
    commandPolicy: { allowedExecutables: [path.basename(process.execPath).toLowerCase(), process.execPath.toLowerCase()], deniedPatterns: [], maxOutputChars: 100000 },
  };
  const policy = new PathPolicy(config);
  const manager = new ProcessManager(config, policy);
  const started = await manager.start({ runtime: 'windows', executable: process.execPath, args: ['-e', 'console.log("hello-agent")'], cwd: root });
  assert.ok(started.session_id);
  for (let i = 0; i < 150 && !manager.get(started.session_id).closed; i++) await sleep(20);
  await manager.get(started.session_id).logChain;
  const output = manager.output(started.session_id, { max_chars: 10000 });
  assert.match(output.stdout, /hello-agent/);
  assert.equal(output.status, 'completed');
});

test('denies a forbidden command pattern', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    wsl: { distro: 'Ubuntu-22.04', user: 'testuser' },
    allowedRoots: [{ path: root, permissions: ['read','write'] }], deniedPathFragments: [], processLogDir: path.join(root,'logs'),
    commandPolicy: { allowedExecutables: ['bash'], deniedPatterns: ['rm\\s+-rf\\s+/'], maxOutputChars: 10000 },
  };
  const manager = new ProcessManager(config, new PathPolicy(config));
  await assert.rejects(() => manager.start({ runtime: 'windows', executable: 'bash', args: ['-lc','rm -rf /'] }), /denied/);
});

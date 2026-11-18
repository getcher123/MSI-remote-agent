import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WSL_LAUNCH, WSL_SIGNAL } from '../server/lib/wsl-control.mjs';
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Linux helper captures owned identity and signals only its verified group', { skip: process.platform !== 'linux' }, async (t) => {
  const marker = '__AIHUB_WSL_testnonce__';
  const p = spawn('python3', ['-u', '-c', WSL_LAUNCH, 'testnonce', 'python3', '-u', '-c', "import time; print('READY',flush=True); time.sleep(30)"], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', stdout = ''; let closed = false;
  p.stderr.on('data', (b) => stderr += b); p.stdout.on('data', (b) => stdout += b); p.on('close', () => closed = true);
  let id;
  t.after(async () => { if (id && !closed) await run('python3', ['-c', WSL_SIGNAL, '' + id.pid, '' + id.uid, id.start_time, 'KILL']).catch(() => {}); if (!closed) p.kill(); });
  for (let i = 0; i < 200 && (!stderr.includes('\n') || !stdout.includes('READY')); i++) await sleep(10);
  assert.ok(stderr.startsWith(marker)); id = JSON.parse(stderr.split('\n')[0].slice(marker.length)); assert.equal(id.pgid, id.pid);
  const wrong = JSON.parse((await run('python3', ['-c', WSL_SIGNAL, '' + id.pid, '' + id.uid, '0', 'KILL'])).stdout);
  assert.equal(wrong.sent, false); assert.equal(wrong.reason, 'process_identity_mismatch');
  const result = JSON.parse((await run('python3', ['-c', WSL_SIGNAL, '' + id.pid, '' + id.uid, id.start_time, 'TERM'])).stdout);
  assert.equal(result.sent, true);
  for (let i = 0; i < 200 && !closed; i++) await sleep(10);
  assert.equal(closed, true);
  const probe = JSON.parse((await run('python3', ['-c', WSL_SIGNAL, '' + id.pid, '' + id.uid, id.start_time, 'PROBE'])).stdout);
  assert.equal(probe.group_absent, true);
});

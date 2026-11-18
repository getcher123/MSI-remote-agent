import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t, maxOutputChars = 100000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-regression-'));
  const config = { wsl: { distro: 'Ubuntu-22.04', user: 'testuser' }, allowedRoots: [{ path: root, permissions: ['read', 'write'] }], deniedPathFragments: [], processLogDir: path.join(root, 'logs'), commandPolicy: { allowedExecutables: [process.execPath.toLowerCase(), path.basename(process.execPath).toLowerCase(), 'nonexistent-aihub-executable'], deniedPatterns: [], maxOutputChars } };
  const m = new ProcessManager(config, new PathPolicy(config));
  t.after(async () => {
    for (const s of m.sessions.values()) {
      if (!s.closed && s.pid) s.child.kill('SIGKILL');
      if (s.timeout) clearTimeout(s.timeout);
      await s.logChain;
    }
    await sleep(20); await fs.rm(root, { recursive: true, force: true });
  });
  return { m, root, start: (code, extra = {}) => m.start({ runtime: 'windows', executable: process.execPath, args: ['-e', code], cwd: root, ...extra }) };
}
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('test wait timeout'); await sleep(10); }
}

test('actual complete output is not marked truncated, including exhausted offsets', async (t) => {
  const { m, start } = await fixture(t); const s = await start('process.stdout.write("abc");process.stderr.write("err")');
  await until(() => m.get(s.session_id).closed);
  const p = m.output(s.session_id); assert.equal(p.stdout, 'abc'); assert.equal(p.stderr, 'err');
  assert.equal(p.stdout_truncated, false); assert.equal(p.stderr_truncated, false); assert.equal(p.output_complete, true);
  const eof = m.output(s.session_id, { stdout_offset: p.next_stdout_offset, stderr_offset: p.next_stderr_offset });
  assert.equal(eof.stdout_truncated, false); assert.equal(eof.stderr_truncated, false);
});
test('split multibyte UTF-8 chunks are decoded without replacement characters', async (t) => {
  const { m, start } = await fixture(t);
  const s = await start('const b=Buffer.from("Проверка🙂"); for(let i=0;i<b.length;i++)setTimeout(()=>process.stdout.write(b.subarray(i,i+1)),i*5);');
  await until(() => m.get(s.session_id).closed);
  assert.equal(m.output(s.session_id).stdout, 'Проверка🙂');
});
test('real rolling output preserves absolute cursor after overflow', async (t) => {
  const { m, start } = await fixture(t, 5); const s = await start('process.stdout.write("1234567890")');
  await until(() => m.get(s.session_id).closed);
  const p = m.output(s.session_id); assert.equal(p.stdout, '67890'); assert.equal(p.stdout_total_chars, 10); assert.equal(p.stdout_lost_chars, 5);
  assert.equal(m.output(s.session_id, { stdout_offset: 10 }).stdout_truncated, false);
});
test('failed stop request leaves live process running; later natural exit remains completed', async (t) => {
  const { m, start } = await fixture(t);
  const s = await start('console.log("READY");setTimeout(()=>console.log("NATURAL_END"),350)');
  await until(() => m.output(s.session_id).stdout.includes('READY'));
  m.sendStop = async () => ({ sent: false, error: 'taskkill_failed_or_timed_out', scope: 'windows_process_tree' });
  const result = await m.terminate(s.session_id, false, 'requested', 10);
  assert.equal(result.termination_confirmed, false); assert.equal(result.status, 'running'); assert.equal(result.exit_confirmed, false);
  assert.equal(m.get(s.session_id).endedAt, null);
  await until(() => m.get(s.session_id).closed);
  assert.equal(m.output(s.session_id).status, 'completed'); assert.match(m.output(s.session_id).stdout, /NATURAL_END/);
});
test('real force-stop waits for close and is not overwritten with failed', async (t) => {
  const { m, start } = await fixture(t); const s = await start('console.log("READY");setTimeout(()=>console.log("NATURAL_END"),30000)');
  await until(() => m.output(s.session_id).stdout.includes('READY'));
  const r = await m.terminate(s.session_id, true, 'requested', 5000);
  assert.equal(r.termination_confirmed, true); assert.equal(r.exit_confirmed, true); assert.equal(r.status, 'terminated');
  await sleep(20); const p = m.output(s.session_id); assert.equal(p.status, 'terminated'); assert.doesNotMatch(p.stdout, /NATURAL_END/);
  assert.equal((await m.terminate(s.session_id, true)).already_terminal, true);
});
test('soft POSIX signal ignored by child does not claim termination or escalate', { skip: process.platform === 'win32' }, async (t) => {
  const { m, start } = await fixture(t); const s = await start('process.on("SIGTERM",()=>console.log("IGNORED"));console.log("READY");setInterval(()=>{},1000)');
  await until(() => m.output(s.session_id).stdout.includes('READY'));
  const r = await m.terminate(s.session_id, false, 'requested', 50);
  assert.equal(r.request_sent, true); assert.equal(r.termination_confirmed, false); assert.equal(r.status, 'running');
  assert.equal((await m.terminate(s.session_id, true, 'requested', 1000)).termination_confirmed, true);
});
test('automatic timeout is confirmed as a real process exit', async (t) => {
  const { m, start } = await fixture(t); const s = await start('setTimeout(()=>{},30000)', { timeout_ms: 150 });
  await until(() => m.get(s.session_id).closed, 8000);
  assert.equal(m.output(s.session_id).status, 'terminated'); assert.equal(m.output(s.session_id).termination.reason, 'timeout');
});
test('spawn failure produces error and is not overwritten as failed', async (t) => {
  const { m, root } = await fixture(t);
  const s = await m.start({ runtime: 'windows', executable: 'nonexistent-aihub-executable', cwd: root });
  await until(() => m.get(s.session_id).closed); assert.equal(m.output(s.session_id).status, 'error');
});
test('stdin supports Cyrillic and reports terminal input failure', async (t) => {
  const { m, start } = await fixture(t); const s = await start('process.stdin.once("data",b=>{console.log(b.toString());process.exit(0)})');
  await m.input(s.session_id, 'Проверка', true); await until(() => m.get(s.session_id).closed);
  assert.match(m.output(s.session_id).stdout, /Проверка/); await assert.rejects(() => m.input(s.session_id, 'x'), /not writable/);
});
test('refuses unknown process IDs and does not pass tunnel key to a child', async (t) => {
  const { m, start } = await fixture(t); await assert.rejects(() => m.terminate('proc_unknown'), /Unknown/);
  const prior = process.env.CONTROL_PLANE_API_KEY; process.env.CONTROL_PLANE_API_KEY = ['synthetic', 'test', 'value'].join('-');
  try {
    const s = await start('console.log(Boolean(process.env.CONTROL_PLANE_API_KEY))'); await until(() => m.get(s.session_id).closed);
    assert.equal(m.output(s.session_id).stdout.trim(), 'false');
  } finally { if (prior === undefined) delete process.env.CONTROL_PLANE_API_KEY; else process.env.CONTROL_PLANE_API_KEY = prior; }
});

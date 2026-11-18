// Opt-in, no credentials/Codex/project mutations. Only own temporary files/processes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager } from '../server/lib/process-manager.mjs';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { VERSION } from '../server/lib/util.mjs';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { smokeWslOptions, temporaryWslPath } from './smoke-options.mjs';
const { values } = parseArgs({ options: {
  wsl: { type: 'boolean', default: false },
  'wsl-distro': { type: 'string' }, 'wsl-user': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/smoke-windows.mjs [--wsl] [--wsl-distro NAME --wsl-user NAME]\nWSL uses the private agent configuration unless both options are supplied. All probe files/processes are isolated.');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('Run on Windows, not Linux');
const includeWsl = values.wsl;
if (!includeWsl && (values['wsl-distro'] || values['wsl-user'])) throw new Error('Use --wsl to enable WSL checks.');
const wsl = await smokeWslOptions(values, includeWsl);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-process-smoke-'));
const config = {
  wsl,
  allowedRoots: [{ path: root, permissions: ['read', 'write'] }], deniedPathFragments: [],
  processLogDir: path.join(root, 'processes'),
  commandPolicy: { allowedExecutables: ['powershell.exe', 'python3', 'node.exe'], deniedPatterns: [], maxOutputChars: 100000 },
};
const manager = new ProcessManager(config, new PathPolicy(config));
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 10000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() >= end) throw new Error('bounded smoke timeout'); await sleep(25); } }
async function check(name, action) {
  const start = Date.now();
  try { checks.push({ name, pass: true, ...(await action()), duration_ms: Date.now() - start }); }
  catch (error) { checks.push({ name, pass: false, error: error.message, duration_ms: Date.now() - start }); }
}
const windowsStart = (text) => manager.start({ runtime: 'windows', executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', text], cwd: root });
const wslCwd = includeWsl ? temporaryWslPath(root) : null;
const wslStart = (code) => manager.start({ runtime: 'wsl', executable: 'python3', args: ['-u', '-c', code], cwd: wslCwd });
try {
  await check('windows_output_and_eof_flags', async () => {
    const s = await windowsStart("[Console]::Out.Write('HELLO'); [Console]::Error.Write('ERR')");
    await until(() => manager.get(s.session_id).closed);
    const p = manager.output(s.session_id, { max_chars: 2000 });
    assert.equal(p.stdout, 'HELLO'); assert.equal(p.stderr, 'ERR'); assert.equal(p.stdout_truncated, false); assert.equal(p.stderr_truncated, false);
    const e = manager.output(s.session_id, { stdout_offset: p.next_stdout_offset, stderr_offset: p.next_stderr_offset });
    assert.equal(e.stdout, ''); assert.equal(e.stdout_truncated, false); assert.equal(e.stderr_truncated, false);
    return { exit_code: p.exit_code };
  });
  await check('windows_soft_is_truthful_and_force_confirmed', async () => {
    const s = await windowsStart("[Console]::Out.WriteLine('READY'); Start-Sleep -Seconds 30; [Console]::Out.WriteLine('NATURAL_END')");
    await until(() => manager.output(s.session_id).stdout.includes('READY'));
    const soft = await manager.terminate(s.session_id, false, 'smoke', 250);
    assert.equal(soft.exit_confirmed, manager.get(s.session_id).closed);
    if (soft.termination_confirmed) assert.equal(manager.get(s.session_id).closed, true);
    else assert.notEqual(manager.get(s.session_id).status, 'terminated');
    let force = null;
    if (!manager.get(s.session_id).closed) {
      force = await manager.terminate(s.session_id, true, 'smoke', 5000);
      assert.equal(force.termination_confirmed, true);
      assert.equal(manager.output(s.session_id).status, 'terminated');
    }
    assert.doesNotMatch(manager.output(s.session_id).stdout, /NATURAL_END/);
    return { soft_exit_confirmed: soft.exit_confirmed, soft_request_sent: soft.request_sent, force_exit_confirmed: force?.exit_confirmed ?? null };
  });
  if (includeWsl) {
    await check('wsl_utf8_stdin_and_normal_completion', async () => {
      const s = await wslStart("import sys; print('READY',flush=True); line=sys.stdin.readline().strip(); print(line,flush=True)");
      await until(() => manager.get(s.session_id).wslIdentity && manager.output(s.session_id).stdout.includes('READY'));
      await manager.input(s.session_id, 'Проверка🙂', true);
      await until(() => manager.get(s.session_id).closed);
      const p = manager.output(s.session_id); assert.match(p.stdout, /Проверка🙂/); assert.equal(p.status, 'completed'); assert.equal(p.stderr, ''); assert.equal(p.stdout_truncated, false);
      return { identity_captured: true, exit_code: p.exit_code };
    });
    await check('wsl_soft_ignored_then_force_group_confirmed', async () => {
      const s = await wslStart("import os,sys,signal,subprocess,time; signal.signal(signal.SIGTERM,lambda *a: print('IGNORED',flush=True)); child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(40)']); print('READY',flush=True); time.sleep(40)");
      await until(() => manager.get(s.session_id).wslIdentity && manager.output(s.session_id).stdout.includes('READY'));
      const soft = await manager.terminate(s.session_id, false, 'smoke', 200);
      assert.equal(soft.request_sent, true); assert.equal(soft.termination_confirmed, false); assert.equal(soft.termination.tree_exit_confirmed, false);
      const force = await manager.terminate(s.session_id, true, 'smoke', 5000);
      assert.equal(force.termination_confirmed, true); assert.equal(force.termination.tree_exit_confirmed, true);
      return { soft_kept_running: true, wsl_group_absent: true, exit_confirmed: force.exit_confirmed };
    });
  }
} finally {
  for (const s of manager.sessions.values()) {
    if (!s.closed) {
      const r = await manager.terminate(s.id, true, 'smoke_cleanup', 5000).catch((e) => ({ error: e.message }));
      if (!s.closed) checks.push({ name: 'cleanup_owned_process', pass: false, session_id: s.id, error: r.error || 'exit not confirmed' });
    }
    if (s.timeout) clearTimeout(s.timeout);
    await s.logChain;
  }
  const allClosed = [...manager.sessions.values()].every((s) => s.closed);
  if (allClosed) await fs.rm(root, { recursive: true, force: true });
  checks.push({ name: 'owned_processes_and_files_cleanup', pass: allClosed && !(await fs.stat(root).catch(() => null)) });
}
console.log(JSON.stringify({ version: VERSION, at: new Date().toISOString(), platform: process.platform, node: process.version, checks, pass: checks.every((c) => c.pass), no_codex_send: true, no_install: true }, null, 2));
if (checks.some((c) => !c.pass)) process.exitCode = 1;

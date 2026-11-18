import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, nowIso, randomId } from './util.mjs';
import { OutputBuffer } from './output-buffer.mjs';
import { WSL_LAUNCH, WSL_SIGNAL } from './wsl-control.mjs';
import { isWslEnabled } from './config.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProcessManager {
  constructor(config, pathPolicy) {
    this.config = config;
    this.pathPolicy = pathPolicy;
    this.sessions = new Map();
    this.allowedExecutables = new Set((config.commandPolicy?.allowedExecutables || []).map((x) => x.toLowerCase()));
    this.deniedPatterns = (config.commandPolicy?.deniedPatterns || []).map((x) => new RegExp(x, 'i'));
    this.maxOutputChars = config.commandPolicy?.maxOutputChars || 1_000_000;
  }

  validateCommand(executable, args) {
    if (typeof executable !== 'string' || !executable || !Array.isArray(args) || args.some((x) => typeof x !== 'string' || x.includes('\0'))) {
      throw new Error('executable and string args are required');
    }
    const base = path.win32.basename(path.posix.basename(executable)).toLowerCase();
    if (!this.allowedExecutables.has(base) && !this.allowedExecutables.has(executable.toLowerCase())) throw new Error(`Executable is not allowlisted: ${executable}`);
    const commandLine = [executable, ...args].join(' ');
    for (const pattern of this.deniedPatterns) if (pattern.test(commandLine)) throw new Error(`Command denied by policy: ${pattern}`);
  }

  async start({ runtime = 'native', executable, args = [], cwd, env = {}, timeout_ms = 0, label = '' }, internalOptions = {}) {
    this.validateCommand(executable, args);
    if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 0 || timeout_ms > 86_400_000) throw new Error('Invalid timeout_ms');
    const runtimeNormalized = String(runtime).toLowerCase();
    if (!['native', 'windows', 'wsl'].includes(runtimeNormalized)) throw new Error('runtime must be native, windows or wsl');
    if (runtimeNormalized === 'wsl' && !isWslEnabled(this.config)) throw new Error('WSL_DISABLED: configure WSL before starting a WSL process');
    if (runtimeNormalized === 'wsl' && process.platform !== 'win32') throw new Error('WSL_UNAVAILABLE_ON_HOST: use native runtime when the agent runs inside Linux/WSL');
    if (!cwd) {
      const candidates = (this.config.allowedRoots || []).filter(root => (root.permissions || ['read']).includes('read'));
      cwd = candidates.find(root => runtimeNormalized !== 'wsl' || root.path.startsWith('/'))?.path;
      if (!cwd) throw new Error('WORKSPACE_NOT_CONFIGURED: supply an authorized cwd or run npm run configure');
    }
    const id = randomId('proc');
    let command = executable;
    let commandArgs = [...args];
    let spawnCwd;
    let marker = null;
    if (cwd) await this.pathPolicy.authorize(cwd, 'read');
    if (runtimeNormalized === 'wsl') {
      command = 'wsl.exe';
      marker = `__AIHUB_WSL_${id}__`;
      commandArgs = ['-d', this.config.wsl.distro, '-u', this.config.wsl.user];
      if (cwd) commandArgs.push('--cd', cwd);
      commandArgs.push('--', 'python3', '-u', '-c', WSL_LAUNCH, id, executable, ...args);
    } else if (runtimeNormalized === 'windows' || runtimeNormalized === 'native') {
      if (cwd) spawnCwd = (await this.pathPolicy.authorize(cwd, 'read')).hostPath;
    } else throw new Error('runtime must be native, windows or wsl');

    await ensureDir(this.config.processLogDir);
    const internal = internalOptions.internal === true;
    const captureOutput = !internal || internalOptions.captureOutput !== false;
    const logOutput = !internal || internalOptions.logOutput !== false;
    const logPath = logOutput ? path.join(this.config.processLogDir, `${id}.jsonl`) : null;
    // Do not pass the tunnel authentication secret to arbitrary child processes.
    const explicitEnv = sanitizeEnv(env);
    const childEnv = { ...process.env, ...explicitEnv };
    for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'CONTROL_PLANE_API_KEY') delete childEnv[key];
    if (internal && runtimeNormalized === 'wsl') {
      if (Object.keys(explicitEnv).some((key) => key.toUpperCase() === 'WSLENV')) throw new Error('WSLENV is managed by the MCP bridge');
      for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'WSLENV') delete childEnv[key];
      childEnv.WSLENV = Object.keys(explicitEnv).map((key) => `${key}/u`).join(':');
    }
    const child = spawn(command, commandArgs, { cwd: spawnCwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const session = {
      id, label, runtime: runtimeNormalized, executable, args, cwd: cwd || null, internal,
      child, pid: child.pid ?? null, status: 'running', exitCode: null, signal: null,
      startedAt: nowIso(), exitedAt: null, endedAt: null, closed: false,
      output: { stdout: new OutputBuffer(this.maxOutputChars), stderr: new OutputBuffer(this.maxOutputChars) },
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      logPath, logChain: Promise.resolve(), timeout: null, spawnError: null,
      termination: null, terminationPromise: null, wslIdentity: null,
      marker, markerBuffer: '', markerDone: !marker,
    };
    this.sessions.set(id, session);
    const append = (stream, text) => {
      if (!text) return;
      if (captureOutput) session.output[stream].append(text);
      // Process output is intentionally local, not part of metadata audit.
      if (logOutput) session.logChain = session.logChain.then(() => fs.appendFile(logPath, `${JSON.stringify({ at: nowIso(), stream, text })}\n`, { encoding: 'utf8', mode: 0o600 })).catch(() => {});
    };
    const stderrText = (text, ended = false) => {
      if (session.markerDone) return append('stderr', text);
      session.markerBuffer += text;
      const end = session.markerBuffer.indexOf('\n');
      if (end < 0 && !ended && session.markerBuffer.length < 8192) return;
      const first = end < 0 ? session.markerBuffer : session.markerBuffer.slice(0, end);
      const rest = end < 0 ? '' : session.markerBuffer.slice(end + 1);
      session.markerDone = true;
      if (first.startsWith(marker)) {
        try {
          const identity = JSON.parse(first.slice(marker.length));
          if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.pgid !== identity.pid || !Number.isSafeInteger(identity.uid) || !/^\d+$/.test(identity.start_time)) throw new Error('invalid identity');
          session.wslIdentity = identity;
        } catch { append('stderr', '[AIHub WSL process identity unavailable]\n'); }
        append('stderr', rest);
      } else append('stderr', session.markerBuffer);
      session.markerBuffer = '';
    };
    // A protocol child keeps stdout paused until its MCP client attaches. No
    // competing consumer, output tail, or raw protocol log is created.
    if (captureOutput || logOutput) child.stdout.on('data', (chunk) => append('stdout', session.decoders.stdout.write(chunk)));
    child.stderr.on('data', (chunk) => stderrText(session.decoders.stderr.write(chunk)));
    child.stdout.on('end', () => append('stdout', session.decoders.stdout.end()));
    child.stderr.on('end', () => stderrText(session.decoders.stderr.end(), true));
    child.stdin.on('error', (error) => { session.inputError = error.code || 'stdin_error'; });
    child.on('error', (error) => {
      // A failed signal is not proof of process exit. Spawn failure has no PID.
      if (!child.pid) session.spawnError = error.code || 'spawn_failed';
      session.lastError = error.code || 'process_error';
    });
    child.on('exit', (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      session.exitedAt = nowIso();
      session.status = 'exited'; // stdout/stderr may still be draining.
      if (session.timeout) clearTimeout(session.timeout);
    });
    child.on('close', (code, signal) => {
      session.exitCode = code;
      session.signal = signal;
      session.closed = true;
      session.endedAt = nowIso();
      if (session.timeout) clearTimeout(session.timeout);
      this.finalizeStatus(session);
    });
    if (timeout_ms > 0) session.timeout = setTimeout(() => {
      void this.terminate(id, true, 'timeout', 2000, internal).catch((error) => { session.timeoutError = error.message; });
    }, timeout_ms);
    return this.describe(session, 8000);
  }

  finalizeStatus(session) {
    if (!session.closed) return;
    session.status = session.spawnError ? 'error' : session.termination?.request_status === 'sent' && (session.signal !== null || session.exitCode !== 0) ? 'terminated' : session.exitCode === 0 ? 'completed' : 'failed';
    if (session.termination) session.termination.exit_confirmed = true;
  }

  describe(session, maxChars = 20000) {
    return {
      session_id: session.id, label: session.label, runtime: session.runtime,
      executable: session.executable, args: session.args, cwd: session.cwd, pid: session.pid,
      status: session.status, exit_code: session.exitCode, signal: session.signal,
      started_at: session.startedAt, exited_at: session.exitedAt, ended_at: session.endedAt,
      output_complete: session.closed, termination: session.termination ? { ...session.termination } : null,
      ...this.outputFields(session, { max_chars: maxChars }),
    };
  }

  outputFields(session, { stdout_offset = 0, stderr_offset = 0, max_chars = 20000 } = {}) {
    const result = {};
    for (const [name, offset] of [['stdout', stdout_offset], ['stderr', stderr_offset]]) {
      const page = session.output[name].read(offset, max_chars);
      Object.assign(result, {
        [name]: page.text, [`${name}_truncated`]: page.truncated,
        [`next_${name}_offset`]: page.next, [`${name}_start_offset`]: page.start,
        [`${name}_total_chars`]: page.total, [`${name}_base_offset`]: page.base,
        [`${name}_lost_chars`]: page.lost, [`${name}_has_more`]: page.hasMore,
      });
    }
    return result;
  }

  get(id, internalAccess = false) {
    const session = this.sessions.get(id);
    if (!session || (session.internal && !internalAccess)) throw new Error(`Unknown process session: ${id}`);
    return session;
  }
  getInternal(id) { return this.get(id, true); }
  output(id, options = {}) {
    const session = this.get(id);
    return { ...this.describe(session, 0), ...this.outputFields(session, options) };
  }
  async input(id, input, appendNewline = false) {
    const session = this.get(id);
    if (session.status !== 'running' || session.child.stdin.destroyed) throw new Error(`Process stdin is not writable: ${session.status}`);
    const text = appendNewline ? `${input}\n` : input;
    await new Promise((resolve, reject) => session.child.stdin.write(text, 'utf8', (error) => error ? reject(error) : resolve()));
    return { session_id: id, written_chars: text.length };
  }
  list() { return [...this.sessions.values()].filter((session) => !session.internal).map((session) => this.describe(session, 1000)); }

  async sendStop(session, force) {
    if (session.runtime === 'wsl') {
      const identity = session.wslIdentity;
      if (!identity) return { sent: false, error: 'wsl_identity_not_ready', scope: 'wsl_process_group' };
      try {
        const { stdout } = await this.wslControl(identity, force ? 'KILL' : 'TERM');
        const result = JSON.parse(stdout.trim());
        return { sent: result.sent === true, error: result.reason || null, scope: 'wsl_process_group' };
      } catch (error) { return { sent: false, error: error.code || 'wsl_signal_failed', scope: 'wsl_process_group' }; }
    }
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(session.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
        return { sent: true, command_exit_code: 0, scope: 'windows_process_tree' };
      } catch (error) {
        return { sent: false, command_exit_code: Number.isInteger(error.code) ? error.code : null, error: 'taskkill_failed_or_timed_out', scope: 'windows_process_tree' };
      }
    }
    try { return { sent: session.child.kill(force ? 'SIGKILL' : 'SIGTERM'), scope: 'process' }; }
    catch (error) { return { sent: false, error: error.code || 'signal_failed', scope: 'process' }; }
  }

  wslControl(identity, signal) {
    return execFileAsync('wsl.exe', ['-d', this.config.wsl.distro, '-u', this.config.wsl.user, '--', 'python3', '-c', WSL_SIGNAL, String(identity.pid), String(identity.uid), identity.start_time, signal], { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  }

  async terminate(id, force = false, reason = 'requested', waitMs = 2000, internalAccess = false) {
    const session = this.get(id, internalAccess);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw new Error('wait_ms must be 0..10000');
    if (session.terminationPromise) return session.terminationPromise;
    if (session.closed) return { session_id: id, status: session.status, already_terminal: true, exit_confirmed: true, termination_confirmed: false, reason: 'already_exited' };
    session.terminationPromise = this.terminateOnce(session, force, reason, waitMs);
    try { return await session.terminationPromise; }
    finally { session.terminationPromise = null; }
  }
  terminateInternal(id, force = false, reason = 'mcp_disconnect', waitMs = 2000) {
    return this.terminate(id, force, reason, waitMs, true);
  }

  async terminateOnce(session, force, reason, waitMs) {
    // Never signal a possibly recycled PID after the tracked child has exited.
    if (session.exitedAt || !session.pid) return { session_id: session.id, status: session.status, termination_confirmed: false, exit_confirmed: session.closed, reason: 'not_signalable_or_output_draining' };
    const attempt = { requested_at: nowIso(), reason, force, request_status: 'pending', exit_confirmed: false, tree_exit_confirmed: null };
    session.termination = attempt;
    const sent = await this.sendStop(session, force);
    Object.assign(attempt, sent, { request_status: sent.sent ? 'sent' : 'failed' });
    this.finalizeStatus(session);
    const deadline = Date.now() + waitMs;
    while (!session.closed && Date.now() < deadline) await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    this.finalizeStatus(session);
    if (session.runtime === 'wsl' && session.wslIdentity) {
      try { attempt.tree_exit_confirmed = JSON.parse((await this.wslControl(session.wslIdentity, 'PROBE')).stdout.trim()).group_absent === true; }
      catch { attempt.tree_exit_confirmed = null; }
    }
    // Windows /T requests tree termination; it does not independently attest every descendant.
    return {
      session_id: session.id, status: session.status, reason,
      termination_requested: true, request_sent: sent.sent,
      termination_confirmed: session.closed && sent.sent && (session.runtime !== 'wsl' || attempt.tree_exit_confirmed === true),
      exit_confirmed: session.closed, force_required: !force && !session.closed && process.platform === 'win32' && session.runtime === 'windows',
      termination: { ...attempt },
    };
  }
}

function sanitizeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (key.toUpperCase() === 'CONTROL_PLANE_API_KEY') throw new Error('Tunnel credential cannot be passed to a child');
    if (typeof value !== 'string' || value.length > 10000) throw new Error(`Invalid environment variable ${key}`);
    out[key] = value;
  }
  return out;
}

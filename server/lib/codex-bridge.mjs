import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite, ensureDir, nowIso, parseJsonOutput, pathExists, randomId, sha256File, sha256Text } from './util.mjs';
import { isCodexEnabled, isWslEnabled } from './config.mjs';

const execFileAsync = promisify(execFile);
const UNKNOWN = new Set(['pending_send', 'ui_invoked_unobserved', 'pre_send_or_unknown_failure', 'outcome_unknown']);
const OBSERVED = new Set(['observed', 'already_observed']);

export class CodexBridge {
  constructor(config, pathPolicy) {
    this.config = config;
    this.pathPolicy = pathPolicy;
    this.receiptFile = config.receiptFile;
    this.enabled = isCodexEnabled(config);
    this.messageDirWsl = config.codex?.messageDir || (config.wsl?.user ? `/home/${config.wsl.user}/.local/share/aihub-remote-agent/messages` : null);
  }
  disabledStatus() { return { enabled: false, status: 'disabled', reason: 'Codex Connect is optional and is not configured' }; }
  assertEnabled() {
    if (!this.enabled) throw Object.assign(new Error('CODEX_DISABLED: configure the optional Codex Connect integration before using it'), { code: 'CODEX_DISABLED' });
  }
  async verifyScripts() {
    if (!this.enabled) return this.disabledStatus();
    const checks = [];
    for (const [name, wslPath, expected] of [
      ['adapter', this.config.codex.adapterPath, this.config.codex.adapterSha256],
      ['ui_sender', this.config.codex.uiSenderPath, this.config.codex.uiSenderSha256],
    ]) {
      const hostPath = this.pathPolicy.toHostPath(wslPath);
      if (!(await pathExists(hostPath))) throw new Error(`${name} not found: ${wslPath}`);
      const actual = await sha256File(hostPath);
      if (expected && actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${name} SHA256 mismatch`);
      checks.push({ name, path: wslPath, sha256: actual });
    }
    return checks;
  }
  async runWsl(executable, args, { timeoutMs = 30000, maxBuffer = 2_000_000 } = {}) {
    this.assertEnabled();
    if (!isWslEnabled(this.config)) throw Object.assign(new Error('WSL_DISABLED: Codex Connect requires configured WSL'), { code: 'WSL_DISABLED' });
    if (process.platform !== 'win32') throw Object.assign(new Error('WSL_UNAVAILABLE_ON_HOST: the Codex Connect bridge requires a Windows host with WSL'), { code: 'WSL_UNAVAILABLE_ON_HOST' });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'CONTROL_PLANE_API_KEY') delete env[key];
    try {
      const { stdout, stderr } = await execFileAsync('wsl.exe', ['-d', this.config.wsl.distro, '-u', this.config.wsl.user, '--', executable, ...args], { windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: 'utf8', env });
      return { exit_code: 0, stdout, stderr };
    } catch (error) {
      return { exit_code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '', timed_out: Boolean(error.killed || error.code === 'ETIMEDOUT') };
    }
  }
  async adapter(args, { timeoutMs = 30000 } = {}) {
    this.assertEnabled();
    await this.verifyScripts();
    const result = await this.runWsl('python3', [this.config.codex.adapterPath, ...args], { timeoutMs });
    if (result.exit_code !== 0) throw new Error(`codex_adapter_failed: exit=${result.exit_code}; timed_out=${Boolean(result.timed_out)}`);
    return parseJsonOutput(result.stdout, 'codex adapter');
  }
  async doctor() { return this.enabled ? this.adapter(['doctor'], { timeoutMs: 30000 }) : this.disabledStatus(); }

  async discover({ title, limit = 50, thread_ids = [] } = {}) {
    this.assertEnabled();
    if (thread_ids.length) {
      const threads = [];
      for (const thread_id of [...new Set(thread_ids)].slice(0, limit)) {
        try {
          const result = await this.readThread({ thread_id, limit: 1, max_chars: 1000 });
          if (title && result.title !== title) continue;
          threads.push({ thread_id: result.thread_id, title: result.title, cwd: result.cwd, runtime_status: result.runtime_status, pending_request_methods: result.pending_request_methods });
        } catch { threads.push({ thread_id, error: 'live_read_unavailable' }); }
      }
      return discoveryResult({ source: 'explicit_thread_ids', threads, ui_focus_confirmed: false });
    }
    const args = ['discover', '--limit', String(limit)];
    if (title) args.push('--title', title);
    return discoveryResult(await this.adapter(args));
  }
  async readThread({ thread_id, title, limit = 2, max_chars = 16000, timeout_seconds = 20 }) {
    this.assertEnabled();
    const args = ['--timeout', String(timeout_seconds), 'read'];
    if (thread_id) args.push('--thread', thread_id);
    else if (title) args.push('--title', title);
    else throw new Error('thread_id or title is required');
    args.push('--limit', String(limit), '--max-chars', String(max_chars));
    const result = await this.adapter(args, { timeoutMs: (timeout_seconds + 10) * 1000 });
    if (thread_id && result.thread_id !== thread_id) throw new Error('Thread UUID mismatch');
    return result;
  }
  threadHasExactUserMessage(snapshot, message, { baseline_turn_ids, enqueue_started_at_ms } = {}) {
    for (const turn of snapshot?.turns || []) {
      if (baseline_turn_ids?.includes(turn.id)) continue;
      if (enqueue_started_at_ms !== undefined && (!Number.isFinite(turn.started_at_ms) || turn.started_at_ms < enqueue_started_at_ms - 1000)) continue;
      for (const item of turn?.messages || []) {
        if (item?.role === 'user' && !item.truncated && item?.text === message) return { turn_id: turn.id, message_id: item.id, turn_status: turn.status };
      }
    }
    return null;
  }
  assertIdentity(snapshot, expected) {
    if (expected.thread_id && snapshot.thread_id !== expected.thread_id) throw new Error('Thread UUID mismatch');
    if (expected.title && snapshot.title !== expected.title) throw new Error('Thread title mismatch');
    if (expected.cwd && snapshot.cwd !== expected.cwd) throw new Error('Thread cwd mismatch');
  }
  assertThreadReady(snapshot, expected) {
    this.assertIdentity(snapshot, expected);
    const type = snapshot.runtime_status?.type;
    if (type !== 'idle') throw new Error(`Codex thread is not idle: ${type || 'unknown'}`);
    if (!Array.isArray(snapshot.pending_request_methods)) throw new Error('Codex pending status is unknown');
    if (snapshot.pending_request_methods.length) throw new Error('Codex thread has pending requests');
  }

  async withReceiptLock(action) {
    await ensureDir(path.dirname(this.receiptFile));
    const lock = `${this.receiptFile}.lock`;
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Codex delivery lock exists; reconcile the earlier operation, do not resend');
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }));
      return await action();
    } finally { await handle.close(); await fs.unlink(lock); }
  }

  async sendMessage({ thread_id, title, cwd, message, wait_seconds = 15 }) {
    this.assertEnabled();
    if (![thread_id, title, cwd, message].every((x) => typeof x === 'string' && x.length)) throw new Error('thread_id, title, cwd, and message are required');
    return this.withReceiptLock(async () => {
      const messageSha = sha256Text(message);
      const receipts = await this.loadReceipts();
      const duplicate = [...receipts].reverse().find((r) => r.thread_id === thread_id && r.message_sha256 === messageSha && r.phase !== 'not_sent_preflight_changed');
      if (duplicate) return { ...duplicate, deduplicated: true, retry_safe: false };
      const pending = receipts.find((r) => r.thread_id === thread_id && UNKNOWN.has(r.phase));
      if (pending) throw new Error(`Unresolved Codex delivery ${pending.receipt_id}; use codex_delivery_status, not send`);
      await this.verifyScripts();
      const before = await this.readThread({ thread_id, limit: 2, max_chars: 16000 });
      this.assertThreadReady(before, { thread_id, title, cwd });
      const existing = this.threadHasExactUserMessage(before, message);
      if (existing) return { phase: 'already_observed', thread_id, title, cwd, message_sha256: messageSha, ...existing, retry_safe: false };

      const receiptId = randomId('codexsend');
      const wslPath = `${this.messageDirWsl}/${receiptId}-${messageSha.slice(0, 12)}.txt`;
      const hostPath = this.pathPolicy.toHostPath(wslPath);
      await ensureDir(path.dirname(hostPath));
      await atomicWrite(hostPath, Buffer.from(message, 'utf8'));
      const receipt = {
        receipt_id: receiptId, at: nowIso(), phase: 'pending_send', thread_id, title, cwd,
        message_sha256: messageSha, message_length: message.length,
        baseline_turn_ids: (before.turns || []).map((t) => t.id),
        enqueue_started_at_ms: Date.now(), retry_safe: false,
        observed_turn_id: null, observed_message_id: null,
      };
      // Persist BEFORE UI dispatch. A crash must not erase an uncertain mutation.
      await this.saveReceipt(receipt);
      let ui;
      try {
        const recheck = await this.readThread({ thread_id, limit: 2, max_chars: 16000 });
        this.assertThreadReady(recheck, { thread_id, title, cwd });
        const ids = (recheck.turns || []).map((t) => t.id);
        if (JSON.stringify(ids) !== JSON.stringify(receipt.baseline_turn_ids)) throw new Error('thread_changed_before_dispatch');
      } catch {
        receipt.phase = 'not_sent_preflight_changed';
        receipt.retry_safe = true;
        await this.saveReceipt(receipt);
        return receipt;
      }
      try {
        ui = await this.runWsl('python3', [this.config.codex.uiSenderPath, '--thread', thread_id, '--title', title, '--expect-cwd', cwd, '--message-file', wslPath, '--wait', String(wait_seconds)], { timeoutMs: (wait_seconds + 30) * 1000 });
        receipt.ui_exit_code = ui.exit_code;
        receipt.ui_timed_out = Boolean(ui.timed_out);
        try {
          const parsed = JSON.parse(ui.stdout.trim());
          receipt.ui_result = Object.fromEntries(['phase', 'turn_id', 'queue_item_id'].filter((k) => typeof parsed[k] === 'string').map((k) => [k, parsed[k]]));
        } catch { receipt.ui_result = null; }
      } catch { receipt.ui_exit_code = null; }
      // Neither exit=0 nor a native queued receipt is a delivery attestation.
      receipt.phase = 'outcome_unknown';
      try {
        const after = await this.readThread({ thread_id, limit: 2, max_chars: Math.min(200000, Math.max(16000, message.length + 2000)) });
        this.assertIdentity(after, receipt);
        const observed = this.threadHasExactUserMessage(after, message, receipt);
        if (observed) Object.assign(receipt, { phase: 'observed', observed_at: nowIso(), observed_turn_id: observed.turn_id, observed_message_id: observed.message_id, observed_turn_status: observed.turn_status });
      } catch { /* Leave unknown, never resend. */ }
      await this.saveReceipt(receipt);
      return receipt;
    });
  }

  async deliveryStatus({ receipt_id }) {
    this.assertEnabled();
    // Read-only recovery stays usable even if a crashed dispatcher left its lock.
    const receipts = await this.loadReceipts();
    const receipt = receipts.find((r) => r.receipt_id === receipt_id);
    if (!receipt) throw new Error(`Unknown receipt: ${receipt_id}`);
    let snapshot;
    try {
      snapshot = await this.readThread({ thread_id: receipt.thread_id, limit: 2, max_chars: Math.min(200000, Math.max(16000, (receipt.message_length || 0) + 2000)) });
      this.assertIdentity(snapshot, receipt);
    } catch {
      return { ...receipt, observed: OBSERVED.has(receipt.phase), live_read_available: false, current_thread_status: 'unknown', retry_safe: false };
    }
    const messagePath = this.pathPolicy.toHostPath(`${this.messageDirWsl}/${receipt_id}-${receipt.message_sha256.slice(0, 12)}.txt`);
    let observed = null;
    if (await pathExists(messagePath)) {
      const message = await fs.readFile(messagePath, 'utf8');
      if (sha256Text(message) !== receipt.message_sha256) throw new Error('Delivery message file SHA mismatch');
      if (Array.isArray(receipt.baseline_turn_ids) && Number.isFinite(receipt.enqueue_started_at_ms)) observed = this.threadHasExactUserMessage(snapshot, message, receipt);
    }
    const updated = { ...receipt };
    if (observed) Object.assign(updated, { phase: 'observed', observed_at: receipt.observed_at || nowIso(), observed_turn_id: observed.turn_id, observed_message_id: observed.message_id, observed_turn_status: observed.turn_status });
    let persisted = !observed;
    if (observed) {
      try { await this.withReceiptLock(() => this.saveReceipt(updated)); persisted = true; }
      catch { persisted = false; }
    }
    return { ...updated, observed: Boolean(observed) || OBSERVED.has(receipt.phase), observed_in_current_tail: Boolean(observed), receipt_persisted: persisted, live_read_available: true, current_thread_status: snapshot.runtime_status?.type || 'unknown', current_pending: snapshot.pending_request_methods || [], retry_safe: false };
  }
  async loadReceipts() {
    if (!(await pathExists(this.receiptFile))) return [];
    const result = JSON.parse(await fs.readFile(this.receiptFile, 'utf8'));
    if (!Array.isArray(result)) throw new Error('Invalid Codex receipt store; fail closed');
    return result;
  }
  async saveReceipt(receipt) {
    const receipts = await this.loadReceipts();
    const index = receipts.findIndex((r) => r.receipt_id === receipt.receipt_id);
    if (index < 0) receipts.push(receipt); else receipts[index] = receipt;
    await atomicWrite(this.receiptFile, JSON.stringify(receipts, null, 2));
  }
}
function discoveryResult(result) {
  const errors = (result.threads || []).filter((t) => t.error);
  return { ...result, partial: errors.length > 0, discovery_status: errors.length ? 'partial_or_unavailable' : 'ok', errors: errors.map(({ thread_id, error }) => ({ thread_id, error })), next_action: errors.length ? 'Read a known exact thread_id; IPC failure for one thread does not prove all sessions unavailable. Do not resume or start another backend.' : null };
}

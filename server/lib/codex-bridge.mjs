import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWrite, ensureDir, nowIso, parseJsonOutput, pathExists, randomId, sha256File, sha256Text } from './util.mjs';
import { isCodexEnabled, isWslEnabled } from './config.mjs';

const execFileAsync = promisify(execFile);
const UNKNOWN = new Set(['prepared', 'pending_send', 'ui_invoked_unobserved', 'pre_send_or_unknown_failure', 'outcome_unknown']);
const OBSERVED = new Set(['observed', 'already_observed']);
const NOT_SENT = new Set(['not_sent_preflight_failed', 'not_sent_preflight_changed', 'not_sent_blocked', 'not_sent_ui_preflight', 'not_sent_ui_staged']);
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SAFE_ERRORS = new Set(['CODEX_ADAPTER_TIMEOUT', 'CODEX_ADAPTER_OUTPUT_LIMIT', 'CODEX_ADAPTER_FAILED', 'CODEX_ADAPTER_INVALID_JSON', 'CODEX_SCRIPT_NOT_FOUND', 'CODEX_SCRIPT_SHA_MISMATCH', 'CODEX_THREAD_ID_MISMATCH', 'CODEX_THREAD_TITLE_MISMATCH', 'CODEX_THREAD_CWD_MISMATCH', 'CODEX_THREAD_NOT_IDLE', 'CODEX_PENDING_UNKNOWN', 'CODEX_PENDING_REQUESTS', 'CODEX_UNCONFIRMED_SUBMISSIONS', 'CODEX_THREAD_CHANGED', 'CODEX_UI_TIMEOUT', 'CODEX_UI_FAILED', 'CODEX_MESSAGE_FILE_FAILED', 'CODEX_RECEIPT_STORE_FAILED', 'CODEX_UNRESOLVED_DELIVERY']);

function failure(code, message, detail = {}) { return Object.assign(new Error(message), { code, ...detail }); }
function checkOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw failure('CODEX_OPERATION_ID_INVALID', 'operation_id must contain 8..128 letters, digits, underscores or hyphens');
  return value;
}
function operationIds(receipt) { return [receipt.operation_id || receipt.receipt_id, ...(receipt.operation_aliases || [])]; }
function receiptView(receipt, operation_id, extra = {}) {
  const primary = receipt.operation_id || receipt.receipt_id;
  return { ...receipt, operation_id: operation_id || primary, ...(operation_id && operation_id !== primary ? { canonical_operation_id: primary } : {}), receipt_persisted: true, ...extra };
}
function threadEvidence(snapshot = {}) {
  const evidence = Object.fromEntries(['pending_state_known', 'pending_request_count', 'unconfirmed_submission_count', 'observation'].filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]]));
  const known = Array.isArray(snapshot.pending_request_methods)
    && (snapshot.pending_state_known === undefined || snapshot.pending_state_known === true)
    && ['pending_request_count', 'unconfirmed_submission_count'].every((key) => snapshot[key] === undefined || (Number.isInteger(snapshot[key]) && snapshot[key] >= 0));
  if (!known) evidence.pending_state_known = false;
  return { ...evidence, pending_request_methods: known ? snapshot.pending_request_methods : null };
}
function currentThreadEvidence(snapshot) {
  const evidence = snapshot ? threadEvidence(snapshot) : {};
  return {
    current_pending: evidence.pending_request_methods ?? null,
    current_pending_state_known: evidence.pending_state_known ?? null,
    current_pending_request_count: evidence.pending_request_count ?? null,
    current_unconfirmed_submission_count: evidence.unconfirmed_submission_count ?? null,
    current_observation: evidence.observation ?? null,
  };
}
function errorDetail(error, stage, started) {
  // Do not persist adapter output, exception messages, commands or stderr.
  return {
    code: SAFE_ERRORS.has(error?.code) ? error.code : 'CODEX_DELIVERY_FAILED',
    layer: ['adapter', 'ui_sender', 'storage', 'preflight'].includes(error?.layer) ? error.layer : 'preflight',
    stage, duration_ms: Math.max(0, Date.now() - started),
    ...(Number.isInteger(error?.exit_code) ? { exit_code: error.exit_code } : {}),
    ...(typeof error?.timed_out === 'boolean' ? { timed_out: error.timed_out } : {}),
  };
}

export class CodexBridge {
  constructor(config, pathPolicy) {
    this.config = config;
    this.pathPolicy = pathPolicy;
    this.receiptFile = config.receiptFile;
    this.enabled = isCodexEnabled(config);
    this.messageDirWsl = config.codex?.messageDir || (config.wsl?.user ? `/home/${config.wsl.user}/.local/share/aihub-remote-agent/messages` : null);
    this.activeOperations = new Map();
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
      if (!(await pathExists(hostPath))) throw failure('CODEX_SCRIPT_NOT_FOUND', `${name} not found`, { layer: 'preflight' });
      const actual = await sha256File(hostPath);
      if (expected && actual.toLowerCase() !== expected.toLowerCase()) throw failure('CODEX_SCRIPT_SHA_MISMATCH', `${name} SHA256 mismatch`, { layer: 'preflight' });
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
      const outputLimit = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      return { exit_code: Number.isInteger(error.code) ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '', timed_out: !outputLimit && Boolean(error.killed || error.code === 'ETIMEDOUT'), output_limit_exceeded: outputLimit };
    }
  }
  async adapter(args, { timeoutMs = 30000 } = {}) {
    this.assertEnabled();
    await this.verifyScripts();
    const result = await this.runWsl('python3', [this.config.codex.adapterPath, ...args], { timeoutMs });
    if (result.exit_code !== 0) throw failure(result.timed_out ? 'CODEX_ADAPTER_TIMEOUT' : result.output_limit_exceeded ? 'CODEX_ADAPTER_OUTPUT_LIMIT' : 'CODEX_ADAPTER_FAILED', `codex_adapter_failed: exit=${result.exit_code}; timed_out=${Boolean(result.timed_out)}`, { layer: 'adapter', exit_code: result.exit_code, timed_out: Boolean(result.timed_out) });
    try { return parseJsonOutput(result.stdout, 'codex adapter'); }
    catch { throw failure('CODEX_ADAPTER_INVALID_JSON', 'codex adapter returned invalid JSON', { layer: 'adapter' }); }
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
          threads.push({ thread_id: result.thread_id, title: result.title, cwd: result.cwd, runtime_status: result.runtime_status, ...threadEvidence(result) });
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
    this.assertIdentity(result, { thread_id, title });
    return result;
  }
  threadHasExactUserMessage(snapshot, message, { baseline_turn_ids, enqueue_started_at_ms } = {}) {
    const matches = [];
    let matchingTimestampUnknown = false;
    // The Windows composer can store CRLF as LF. Preserve every other byte of
    // text, including surrounding spaces and backslashes in code or paths.
    const expectedText = message.replace(/\r\n/g, '\n');
    for (const turn of snapshot?.turns || []) {
      if (baseline_turn_ids?.includes(turn.id)) continue;
      for (const item of turn?.messages || []) {
        if (item?.role !== 'user' || item.truncated || typeof item.text !== 'string' || item.text.replace(/\r\n/g, '\n') !== expectedText) continue;
        if (enqueue_started_at_ms !== undefined) {
          if (!Number.isFinite(turn.started_at_ms)) { matchingTimestampUnknown = true; continue; }
          if (turn.started_at_ms < enqueue_started_at_ms) continue;
        }
        matches.push({ turn_id: turn.id, message_id: item.id, turn_status: turn.status });
      }
    }
    const correlating = baseline_turn_ids !== undefined || enqueue_started_at_ms !== undefined;
    return !matchingTimestampUnknown && matches.length && (!correlating || matches.length === 1) ? matches[0] : null;
  }
  assertIdentity(snapshot, expected) {
    if (expected.thread_id && snapshot?.thread_id !== expected.thread_id) throw failure('CODEX_THREAD_ID_MISMATCH', 'Thread UUID mismatch');
    if (expected.title && snapshot?.title !== expected.title) throw failure('CODEX_THREAD_TITLE_MISMATCH', 'Thread title mismatch');
    if (expected.cwd && snapshot?.cwd !== expected.cwd) throw failure('CODEX_THREAD_CWD_MISMATCH', 'Thread cwd mismatch');
  }
  assertThreadReady(snapshot, expected) {
    this.assertIdentity(snapshot, expected);
    const type = snapshot.runtime_status?.type;
    if (type !== 'idle') throw failure('CODEX_THREAD_NOT_IDLE', `Codex thread is not idle: ${type || 'unknown'}`);
    if (!Array.isArray(snapshot.pending_request_methods)) throw failure('CODEX_PENDING_UNKNOWN', 'Codex pending status is unknown');
    if (snapshot.pending_state_known !== undefined && snapshot.pending_state_known !== true) throw failure('CODEX_PENDING_UNKNOWN', 'Codex pending status is unknown');
    for (const field of ['pending_request_count', 'unconfirmed_submission_count']) if (snapshot[field] !== undefined && (!Number.isInteger(snapshot[field]) || snapshot[field] < 0)) throw failure('CODEX_PENDING_UNKNOWN', 'Codex pending counters are unknown');
    if (snapshot.pending_request_count > 0) throw failure('CODEX_PENDING_REQUESTS', 'Codex thread has pending requests');
    if (snapshot.unconfirmed_submission_count > 0) throw failure('CODEX_UNCONFIRMED_SUBMISSIONS', 'Codex thread has an unconfirmed submission');
    if (snapshot.pending_request_methods.length) throw failure('CODEX_PENDING_REQUESTS', 'Codex thread has pending requests');
  }

  assertOperationBinding(receipt, request) {
    if (['thread_id', 'title', 'cwd', 'message_sha256'].some((key) => receipt[key] !== request[key])) {
      throw failure('CODEX_OPERATION_CONFLICT', 'Codex operation ID is already bound to another target or message', { operation_id: request.operation_id, receipt_id: receipt.receipt_id, phase: receipt.phase });
    }
  }
  findOperation(receipts, operation_id) {
    return receipts.find((receipt) => operationIds(receipt).includes(operation_id));
  }
  async withReceiptLock(action, { operation_id } = {}) {
    await ensureDir(path.dirname(this.receiptFile));
    const lock = `${this.receiptFile}.lock`;
    const token = randomId('codexlock');
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw failure('CODEX_DELIVERY_LOCKED', 'Codex delivery lock exists; reconcile the earlier operation, do not resend', { ...(operation_id ? { operation_id } : {}) });
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso(), token, ...(operation_id ? { operation_id } : {}) }));
      await handle.sync();
      return await action();
    } finally {
      await handle.close().catch(() => {});
      // A corrupted/replaced lock is not ours to remove.
      const current = await fs.readFile(lock, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.token === token) await fs.unlink(lock).catch(() => {});
    }
  }

  async sendMessage({ operation_id, thread_id, title, cwd, message, wait_seconds = 15 }) {
    this.assertEnabled();
    if (![thread_id, title, cwd, message].every((x) => typeof x === 'string' && x.length)) throw new Error('thread_id, title, cwd, and message are required');
    if (Buffer.byteLength(message, 'utf8') > 32768) throw failure('CODEX_MESSAGE_TOO_LARGE', 'Codex UI messages are limited to 32768 UTF-8 bytes');
    if (!Number.isInteger(wait_seconds) || wait_seconds < 1 || wait_seconds > 60) throw failure('CODEX_WAIT_INVALID', 'wait_seconds must be an integer in range 1..60');
    const callerId = operation_id !== undefined;
    const receiptId = randomId('codexsend');
    operation_id = callerId ? checkOperationId(operation_id) : receiptId;
    const request = { operation_id, thread_id, title, cwd, message_sha256: sha256Text(message) };
    const running = this.activeOperations.get(operation_id);
    if (running) {
      this.assertOperationBinding(running.request, request);
      return running.receipt ? receiptView(running.receipt, operation_id, { deduplicated: true, pending: true }) : { ...request, receipt_id: running.receipt_id, phase: 'preparing', delivery_outcome: 'pending', pending: true, receipt_persisted: false, retry_safe: false, deduplicated: true };
    }
    // A response may have been lost. A known operation is never dispatched again.
    const saved = this.findOperation(await this.loadReceipts(), operation_id);
    if (saved) { this.assertOperationBinding(saved, request); return receiptView(saved, operation_id, { deduplicated: true }); }
    const racedActive = this.activeOperations.get(operation_id);
    if (racedActive) {
      this.assertOperationBinding(racedActive.request, request);
      return racedActive.receipt ? receiptView(racedActive.receipt, operation_id, { deduplicated: true, pending: true }) : { ...request, receipt_id: racedActive.receipt_id, phase: 'preparing', delivery_outcome: 'pending', pending: true, receipt_persisted: false, retry_safe: false, deduplicated: true };
    }
    const active = { request, receipt_id: receiptId, receipt: null };
    this.activeOperations.set(operation_id, active);
    try { return await this.withReceiptLock(async () => {
      const receipts = await this.loadReceipts();
      const raced = this.findOperation(receipts, operation_id);
      if (raced) { this.assertOperationBinding(raced, request); return receiptView(raced, operation_id, { deduplicated: true }); }
      const duplicate = [...receipts].reverse().find((r) => r.thread_id === thread_id && r.title === title && r.cwd === cwd && r.message_sha256 === request.message_sha256 && !NOT_SENT.has(r.phase));
      if (duplicate) {
        // Keep legacy hash dedup and make a caller's new ID recoverable too.
        if (callerId) { duplicate.operation_aliases = [...new Set([...(duplicate.operation_aliases || []), operation_id])]; await this.saveReceipt(duplicate); }
        return receiptView(duplicate, callerId ? operation_id : undefined, { deduplicated: true, retry_safe: false });
      }
      const pending = receipts.find((r) => r.thread_id === thread_id && (UNKNOWN.has(r.phase) || (!NOT_SENT.has(r.phase) && !OBSERVED.has(r.phase))));
      const receipt = {
        schema_version: 2, receipt_id: receiptId, ...request, at: nowIso(), updated_at: nowIso(),
        phase: 'prepared', stage: 'prepared', last_completed_stage: 'prepared', delivery_outcome: 'pending',
        message_length: message.length, ui_dispatch_started: false, retry_safe: false,
        observed_turn_id: null, observed_message_id: null,
      };
      const progress = async (stage) => {
        receipt.stage = stage; receipt.updated_at = nowIso();
        try { await this.saveReceipt(receipt); }
        catch { throw failure('CODEX_RECEIPT_STORE_FAILED', 'Codex receipt progress could not be persisted', { layer: 'storage' }); }
        active.receipt = { ...receipt };
      };
      const finish = async () => {
        receipt.updated_at = nowIso();
        try { await this.saveReceipt(receipt); active.receipt = { ...receipt }; return receiptView(receipt); }
        catch { return receiptView(receipt, undefined, { receipt_persisted: false, persistence_error: 'CODEX_RECEIPT_STORE_FAILED', retry_safe: false }); }
      };
      // Receipt exists even if script validation or the FIRST IPC read times out.
      try { await progress('prepared'); }
      catch { throw failure('CODEX_RECEIPT_STORE_FAILED', 'Codex receipt could not be persisted; UI was not invoked', { operation_id, receipt_id: receiptId, phase: 'not_sent_preflight_failed' }); }
      if (pending) {
        Object.assign(receipt, { phase: 'not_sent_blocked', delivery_outcome: 'not_sent', stage: 'blocked', blocked_by_receipt_id: pending.receipt_id, error: { code: 'CODEX_UNRESOLVED_DELIVERY', layer: 'preflight', stage: 'prepared' } });
        return finish();
      }
      let stageStarted = Date.now(), dispatchEntered = false;
      try {
        await progress('verify_scripts'); stageStarted = Date.now();
        await this.verifyScripts(); receipt.last_completed_stage = 'scripts_verified';
        await progress('preflight_read'); stageStarted = Date.now();
        const before = await this.readThread({ thread_id, limit: 2, max_chars: Math.min(200000, Math.max(16000, message.length + 2000)) });
        this.assertThreadReady(before, request); receipt.last_completed_stage = 'preflight_verified';
        const existing = this.threadHasExactUserMessage(before, message);
        if (existing) {
          Object.assign(receipt, { phase: 'already_observed', delivery_outcome: 'already_present', stage: 'completed', observed_at: nowIso(), observed_turn_id: existing.turn_id, observed_message_id: existing.message_id, observed_turn_status: existing.turn_status, ...existing });
          return finish();
        }
        receipt.baseline_turn_ids = (before.turns || []).map((turn) => turn.id);
        await progress('prepare_message'); stageStarted = Date.now();
        const wslPath = `${this.messageDirWsl}/${receiptId}-${request.message_sha256.slice(0, 12)}.txt`;
        const hostPath = this.pathPolicy.toHostPath(wslPath);
        try { await ensureDir(path.dirname(hostPath)); await atomicWrite(hostPath, Buffer.from(message, 'utf8')); }
        catch { throw failure('CODEX_MESSAGE_FILE_FAILED', 'Codex message file could not be prepared', { layer: 'storage' }); }
        receipt.last_completed_stage = 'message_prepared';
        await progress('preflight_recheck'); stageStarted = Date.now();
        const recheck = await this.readThread({ thread_id, limit: 2, max_chars: 16000 });
        this.assertThreadReady(recheck, request);
        const ids = (recheck.turns || []).map((t) => t.id);
        if (JSON.stringify(ids) !== JSON.stringify(receipt.baseline_turn_ids)) throw failure('CODEX_THREAD_CHANGED', 'thread_changed_before_dispatch');
        receipt.last_completed_stage = 'preflight_rechecked';
        Object.assign(receipt, { phase: 'pending_send', delivery_outcome: 'unknown', ui_dispatch_started: true, enqueue_started_at_ms: Date.now() });
        await progress('ui_dispatch'); stageStarted = Date.now();
        dispatchEntered = true;
        const ui = await this.runWsl('python3', [this.config.codex.uiSenderPath, '--thread', thread_id, '--title', title, '--expect-cwd', cwd, '--message-file', wslPath, '--wait', String(wait_seconds)], { timeoutMs: (wait_seconds + 30) * 1000 });
        receipt.ui_exit_code = ui.exit_code;
        receipt.ui_timed_out = Boolean(ui.timed_out);
        try {
          const parsed = JSON.parse(ui.stdout.trim());
          receipt.ui_result = Object.fromEntries(['phase', 'turn_id', 'queue_item_id', 'outcome', 'last_confirmed_phase'].filter((k) => typeof parsed[k] === 'string' && parsed[k].length <= 128).map((k) => [k, parsed[k]]));
          if (typeof parsed.submit_attempted === 'boolean') receipt.ui_result.submit_attempted = parsed.submit_attempted;
          if (!ui.timed_out && parsed.outcome === 'not_sent' && parsed.submit_attempted === false && ['failed_before_send', 'staged_not_submitted'].includes(parsed.phase)) {
            Object.assign(receipt, { phase: parsed.phase === 'staged_not_submitted' ? 'not_sent_ui_staged' : 'not_sent_ui_preflight', delivery_outcome: 'not_sent', stage: 'completed', last_completed_stage: parsed.phase, draft_retained: parsed.phase === 'staged_not_submitted', retry_safe: parsed.phase !== 'staged_not_submitted' });
            return finish();
          }
        } catch { receipt.ui_result = null; }
        if (ui.timed_out || ui.exit_code !== 0) receipt.error = errorDetail(failure(ui.timed_out ? 'CODEX_UI_TIMEOUT' : 'CODEX_UI_FAILED', 'UI sender did not confirm completion', { layer: 'ui_sender', exit_code: ui.exit_code, timed_out: Boolean(ui.timed_out) }), 'ui_dispatch', stageStarted);
        if (!ui.timed_out) receipt.last_completed_stage = 'ui_sender_finished';
      } catch (error) {
        receipt.error = errorDetail(error, receipt.stage, stageStarted);
        if (!dispatchEntered) {
          Object.assign(receipt, { phase: receipt.stage === 'preflight_recheck' ? 'not_sent_preflight_changed' : 'not_sent_preflight_failed', delivery_outcome: 'not_sent', ui_dispatch_started: false, retry_safe: true });
          return finish();
        }
      }
      // Neither exit=0 nor a native queued receipt is a delivery attestation.
      receipt.phase = 'outcome_unknown'; receipt.delivery_outcome = 'unknown'; receipt.retry_safe = false;
      try {
        await progress('observe_delivery'); stageStarted = Date.now();
        const after = await this.readThread({ thread_id, limit: 2, max_chars: Math.min(200000, Math.max(16000, message.length + 2000)) });
        this.assertIdentity(after, receipt);
        const observed = this.threadHasExactUserMessage(after, message, receipt);
        receipt.observation = { at: nowIso(), live_read_available: true, exact_turn_found: Boolean(observed) };
        if (observed) Object.assign(receipt, { phase: 'observed', delivery_outcome: 'delivered', stage: 'completed', last_completed_stage: 'delivery_observed', observed_at: nowIso(), observed_turn_id: observed.turn_id, observed_message_id: observed.message_id, observed_turn_status: observed.turn_status });
      } catch (error) {
        receipt.observation = { at: nowIso(), live_read_available: false, exact_turn_found: false };
        receipt.observation_error = errorDetail(error, 'observe_delivery', stageStarted);
      }
      if (!OBSERVED.has(receipt.phase)) receipt.stage = 'awaiting_observation';
      return finish();
    }, { operation_id }); }
    finally { if (this.activeOperations.get(operation_id) === active) this.activeOperations.delete(operation_id); }
  }

  async deliveryStatus({ receipt_id, operation_id, refresh } = {}) {
    this.assertEnabled();
    if (operation_id !== undefined) checkOperationId(operation_id);
    if (!receipt_id && !operation_id) throw failure('CODEX_RECEIPT_ID_REQUIRED', 'receipt_id or operation_id is required');
    if (refresh !== undefined && typeof refresh !== 'boolean') throw failure('CODEX_STATUS_INVALID', 'refresh must be a boolean');
    const receipts = await this.loadReceipts();
    const byId = receipt_id ? receipts.find((r) => r.receipt_id === receipt_id) : null;
    const byOperation = operation_id ? this.findOperation(receipts, operation_id) : null;
    if (receipt_id && operation_id && (!byId || !byOperation || byId.receipt_id !== byOperation.receipt_id)) throw failure('CODEX_OPERATION_CONFLICT', 'receipt_id and operation_id do not identify the same delivery', { operation_id });
    const receipt = byId || byOperation;
    if (!receipt) {
      const active = operation_id ? this.activeOperations.get(operation_id) : null;
      if (active) return { ...active.request, receipt_id: active.receipt_id, phase: 'preparing', delivery_outcome: 'pending', pending: true, receipt_persisted: false, retry_safe: false };
      if (operation_id && !receipt_id) return { operation_id, phase: 'not_found', delivery_outcome: 'unknown', found: false, receipt_persisted: false, retry_safe: false };
      throw failure('CODEX_RECEIPT_NOT_FOUND', 'Unknown Codex receipt', { receipt_id });
    }
    const lockPresent = await pathExists(`${this.receiptFile}.lock`);
    // Default polling stays bounded while a dispatcher owns the UI lock. A lock
    // is not proof of a live worker; explicit refresh can reconcile a stale lock.
    if (refresh === false || NOT_SENT.has(receipt.phase) || (refresh !== true && lockPresent)) {
      return receiptView(receipt, operation_id, {
        observed: OBSERVED.has(receipt.phase), live_read_available: null, current_thread_status: 'unknown', ...currentThreadEvidence(),
        observation_source: 'persisted_receipt', dispatch_lock_present: lockPresent,
        retry_safe: NOT_SENT.has(receipt.phase) && receipt.retry_safe === true,
      });
    }
    let snapshot; const observationStarted = Date.now();
    try {
      snapshot = await this.readThread({ thread_id: receipt.thread_id, limit: 2, max_chars: Math.min(200000, Math.max(16000, (receipt.message_length || 0) + 2000)) });
      this.assertIdentity(snapshot, receipt);
    } catch (error) {
      return receiptView(receipt, operation_id, { observed: OBSERVED.has(receipt.phase), live_read_available: false, current_thread_status: 'unknown', ...currentThreadEvidence(), retry_safe: false, observation_error: errorDetail(error, 'observe_delivery', observationStarted) });
    }
    const messagePath = this.pathPolicy.toHostPath(`${this.messageDirWsl}/${receipt.receipt_id}-${receipt.message_sha256.slice(0, 12)}.txt`);
    let observed = null;
    if (await pathExists(messagePath)) {
      const message = await fs.readFile(messagePath, 'utf8');
      if (sha256Text(message) !== receipt.message_sha256) throw new Error('Delivery message file SHA mismatch');
      if (Array.isArray(receipt.baseline_turn_ids) && Number.isFinite(receipt.enqueue_started_at_ms)) observed = this.threadHasExactUserMessage(snapshot, message, receipt);
    }
    const updated = { ...receipt };
    if (observed) Object.assign(updated, { phase: 'observed', delivery_outcome: 'delivered', stage: 'completed', last_completed_stage: 'delivery_observed', updated_at: nowIso(), observed_at: receipt.observed_at || nowIso(), observed_turn_id: observed.turn_id, observed_message_id: observed.message_id, observed_turn_status: observed.turn_status });
    let persisted = !observed;
    if (observed) {
      try { await this.withReceiptLock(() => this.saveReceipt(updated)); persisted = true; }
      catch { persisted = false; }
    }
    return receiptView(updated, operation_id, { observed: Boolean(observed) || OBSERVED.has(receipt.phase), observed_in_current_tail: Boolean(observed), receipt_persisted: persisted, live_read_available: true, current_thread_status: snapshot.runtime_status?.type || 'unknown', ...currentThreadEvidence(snapshot), retry_safe: false });
  }
  async loadReceipts() {
    if (!(await pathExists(this.receiptFile))) return [];
    try {
      const result = JSON.parse(await fs.readFile(this.receiptFile, 'utf8'));
      if (!Array.isArray(result)) throw Error();
      const receiptIds = new Set(), ids = new Set();
      for (const receipt of result) {
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.receipt_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.receipt_id) || receiptIds.has(receipt.receipt_id) || typeof receipt.thread_id !== 'string' || !receipt.thread_id || typeof receipt.phase !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(receipt.phase) || typeof receipt.message_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.message_sha256)) throw Error();
        if (receipt.operation_aliases !== undefined && (!Array.isArray(receipt.operation_aliases) || receipt.operation_aliases.some((id) => typeof id !== 'string' || !OPERATION_ID.test(id)))) throw Error();
        if (receipt.operation_id !== undefined && (typeof receipt.operation_id !== 'string' || !OPERATION_ID.test(receipt.operation_id))) throw Error();
        receiptIds.add(receipt.receipt_id);
        for (const id of new Set(operationIds(receipt))) { if (ids.has(id)) throw Error(); ids.add(id); }
      }
      return result;
    } catch { throw failure('CODEX_RECEIPT_STORE_CORRUPT', 'Invalid Codex receipt store; fail closed'); }
  }
  async saveReceipt(receipt) {
    const receipts = await this.loadReceipts();
    const index = receipts.findIndex((r) => r.receipt_id === receipt.receipt_id);
    if (index < 0) receipts.push(receipt);
    else receipts[index] = { ...receipt, ...(receipts[index].operation_aliases || receipt.operation_aliases ? { operation_aliases: [...new Set([...(receipts[index].operation_aliases || []), ...(receipt.operation_aliases || [])])] } : {}) };
    await ensureDir(path.dirname(this.receiptFile));
    const temporary = `${this.receiptFile}.${randomId('write')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(receipts, null, 2));
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, this.receiptFile);
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(this.receiptFile), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
}
function discoveryResult(result) {
  const errors = (result.threads || []).filter((t) => t.error);
  return { ...result, partial: errors.length > 0, discovery_status: errors.length ? 'partial_or_unavailable' : 'ok', errors: errors.map(({ thread_id, error }) => ({ thread_id, error })), next_action: errors.length ? 'Read a known exact thread_id; IPC failure for one thread does not prove all sessions unavailable. Do not resume or start another backend.' : null };
}

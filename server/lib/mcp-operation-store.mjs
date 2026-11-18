import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { nowIso, sha256Text } from './util.mjs';

const DEFAULT_RESULT_LIMIT = 8 * 1024 * 1024;
const STATES = new Set(['prepared', 'in_flight', 'completed', 'failed_preflight', 'outcome_unknown']);
const TERMINAL = new Set(['completed', 'failed_preflight', 'outcome_unknown']);
const REQUEST_KEYS = ['operation_id', 'server_id', 'tool_name', 'arguments_hash', 'server_fingerprint'];
const RECORD_KEYS = new Set([...REQUEST_KEYS, 'schema_version', 'state', 'created_at', 'updated_at', 'dispatched', 'retry_safe', 'dispatched_at', 'completed_at', 'error_code', 'result', 'result_sha256', 'result_bytes']);
// Error messages, peer errors, URLs, headers, commands and arguments are never recorded.
const SAFE_ERRORS = new Set([
  'REQUEST_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'CLIENT_CLOSED', 'CONNECTION_CLOSED', 'CONNECTION_FAILED', 'CONNECT_FAILED',
  'SPAWN_FAILED', 'SPAWN_TIMEOUT', 'PROCESS_EXITED', 'PROCESS_ERROR', 'STDIN_CLOSED',
  'SEND_FAILED', 'HTTP_CONNECTION_FAILED', 'HTTP_REDIRECT_DENIED', 'HTTP_STATUS', 'SESSION_CHANGED', 'INVALID_SESSION',
  'RPC_ERROR', 'INVALID_RPC_ERROR', 'INVALID_RPC_MESSAGE', 'INVALID_RPC_RESPONSE',
  'RESPONSE_ID_MISMATCH', 'RESPONSE_STREAM_ENDED', 'EMPTY_RESPONSE', 'INVALID_JSON', 'INVALID_UTF8',
  'MESSAGE_TOO_LARGE', 'INCOMPLETE_FRAME', 'UNSUPPORTED_CONTENT_TYPE',
  'UNSUPPORTED_PROTOCOL', 'UNSUPPORTED_NEGOTIATED_PROTOCOL', 'UNSUPPORTED_TRANSPORT',
  'INVALID_TOOL_ARGUMENTS', 'INVALID_REQUEST_OPTIONS', 'INVALID_JSON_ARGUMENTS',
  'MCP_SOURCE_CHANGED', 'MCP_SERVER_NOT_REGISTERED', 'MCP_SERVER_DISABLED',
  'MCP_TOOL_NOT_ALLOWED', 'MCP_OPERATION_RESULT_TOO_LARGE', 'MCP_OPERATION_RESULT_INVALID',
  'MCP_OPERATION_DISPATCH_NOT_MARKED', 'MCP_OPERATION_ALREADY_DISPATCHED',
]);

const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = value => JSON.parse(JSON.stringify(value));

function failure(code, { dispatched = false, outcomeUnknown = false } = {}) {
  const error = new Error(`Local MCP operations: ${code}`);
  error.name = 'McpOperationStoreError';
  error.code = code;
  error.dispatched = dispatched;
  error.outcomeUnknown = outcomeUnknown;
  error.retry_safe = !dispatched && !outcomeUnknown;
  return error;
}

function operationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) throw failure('MCP_OPERATION_ID_INVALID');
  return value;
}

function requestIdentity(input) {
  if (!object(input)) throw failure('MCP_OPERATION_REQUEST_INVALID');
  const result = Object.fromEntries(REQUEST_KEYS.map(key => [key, input[key]]));
  operationId(result.operation_id);
  if (typeof result.server_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(result.server_id)) throw failure('MCP_OPERATION_REQUEST_INVALID');
  if (typeof result.tool_name !== 'string' || !result.tool_name || result.tool_name.length > 256 || /[\x00-\x1f\x7f]/.test(result.tool_name)) throw failure('MCP_OPERATION_REQUEST_INVALID');
  for (const field of ['arguments_hash', 'server_fingerprint']) {
    if (typeof result[field] !== 'string' || !/^[a-fA-F0-9]{64}$/.test(result[field])) throw failure('MCP_OPERATION_REQUEST_INVALID');
    result[field] = result[field].toLowerCase();
  }
  return result;
}

function assertSame(record, request) {
  if (REQUEST_KEYS.some(key => record[key] !== request[key])) throw failure('MCP_OPERATION_CONFLICT', { outcomeUnknown: true });
}

function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

/**
 * Durable no-replay receipts. A receipt protects one operation ID, not logically
 * equivalent calls with newly minted IDs. Stale locks are never auto-removed.
 * Result files are private local data, not redacted metadata logs.
 */
export class McpOperationStore {
  constructor(config = {}) {
    if (!config.__stateDir || typeof config.__stateDir !== 'string') throw failure('MCP_OPERATION_CONFIG_INVALID');
    this.directory = config.localMcp?.operationsDir || path.join(config.__stateDir, 'local-mcp-operations');
    this.maxResultBytes = config.localMcp?.maxResultBytes ?? DEFAULT_RESULT_LIMIT;
    if (typeof this.directory !== 'string' || !path.isAbsolute(this.directory) || !Number.isSafeInteger(this.maxResultBytes) || this.maxResultBytes < 1024 || this.maxResultBytes > 64 * 1024 * 1024) throw failure('MCP_OPERATION_CONFIG_INVALID');
    this.active = new Map();
  }

  async run(input, invoke) {
    const request = requestIdentity(input);
    if (typeof invoke !== 'function') throw failure('MCP_OPERATION_INVOKE_INVALID');
    const previous = this.active.get(request.operation_id);
    if (previous) {
      assertSame(previous.request, request);
      return { ...clone(await previous.promise), deduplicated: true };
    }
    const active = { request, receipt: null, dispatched: false, markStarted: false, markPromise: null, invokeFinished: false, promise: null };
    active.promise = this._run(request, invoke, active);
    this.active.set(request.operation_id, active);
    try { return clone(await active.promise); }
    finally { if (this.active.get(request.operation_id) === active) this.active.delete(request.operation_id); }
  }

  async status(id) {
    operationId(id);
    const active = this.active.get(id);
    if (active?.receipt) return { ...clone(active.receipt), pending: !TERMINAL.has(active.receipt.state), persisted: true };
    // An owned run may be creating its first receipt/lock. Do not misclassify
    // that brief interval as a crashed foreign dispatcher.
    if (active) return { ...active.request, state: 'prepared', pending: true, persisted: false, dispatched: false, retry_safe: false };
    const record = await this._read(id);
    if (record) return this._external(record);
    const lock = await this._lockInfo(id);
    if (lock.present) return this._locked(id, lock);
    return { operation_id: id, state: 'not_found', pending: false, persisted: false, dispatched: false, retry_safe: true };
  }

  async _run(request, invoke, active) {
    await this._ensureDirectory();
    const existing = await this._read(request.operation_id);
    if (existing) { assertSame(existing, request); return { ...this._external(existing), deduplicated: true }; }
    const lockPath = this._path(request.operation_id, 'lock');
    const token = crypto.randomUUID();
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw failure('MCP_OPERATION_STORE_UNAVAILABLE');
      const record = await this._read(request.operation_id);
      if (record) { assertSame(record, request); return { ...this._external(record), deduplicated: true }; }
      const info = await this._lockInfo(request.operation_id);
      if (info.request) assertSame(info.request, request);
      return { ...request, ...this._locked(request.operation_id, info), deduplicated: true };
    }
    try {
      await lock.writeFile(JSON.stringify({ schema_version: 1, request, lock_token: token, created_at: nowIso() }));
      await lock.sync();
      // A previous dispatcher may have completed between our first read and lock acquisition.
      const raced = await this._read(request.operation_id);
      if (raced) { assertSame(raced, request); return { ...this._external(raced), deduplicated: true }; }
      const at = nowIso();
      let receipt = { schema_version: 1, ...request, state: 'prepared', created_at: at, updated_at: at, dispatched: false, retry_safe: false };
      await this._write(receipt);
      active.receipt = receipt;
      const markDispatched = () => {
        if (active.markStarted || active.invokeFinished) return Promise.reject(failure('MCP_OPERATION_ALREADY_DISPATCHED', { dispatched: active.dispatched, outcomeUnknown: active.dispatched }));
        active.markStarted = true;
        active.markPromise = (async () => {
          const time = nowIso();
          const marked = { ...receipt, state: 'in_flight', dispatched: true, dispatched_at: time, updated_at: time };
          await this._write(marked);
          active.dispatched = true;
          active.receipt = receipt = marked;
        })();
        return active.markPromise;
      };
      let outcome;
      try {
        const result = await invoke({ markDispatched });
        active.invokeFinished = true;
        if (active.markPromise) await active.markPromise;
        if (!active.dispatched) throw failure('MCP_OPERATION_DISPATCH_NOT_MARKED', { outcomeUnknown: true });
        const serialized = this._serializeResult(result);
        const time = nowIso();
        outcome = { ...receipt, state: 'completed', updated_at: time, completed_at: time, retry_safe: false, result: JSON.parse(serialized), result_sha256: sha256Text(serialized), result_bytes: Buffer.byteLength(serialized) };
      } catch (error) {
        active.invokeFinished = true;
        // A transport timeout may fire while the write-before-dispatch hook
        // still awaits fsync. Finish that write before persisting the outcome,
        // so a late marker can never overwrite the terminal receipt.
        if (active.markPromise) await active.markPromise.catch(() => {});
        const unknown = active.dispatched || error?.dispatched === true || error?.outcomeUnknown === true;
        outcome = { ...receipt, state: unknown ? 'outcome_unknown' : 'failed_preflight', updated_at: nowIso(), dispatched: unknown, retry_safe: !unknown, error_code: SAFE_ERRORS.has(error?.code) ? error.code : 'MCP_OPERATION_FAILED' };
      }
      try { await this._write(outcome); }
      catch {
        // The prepared/in-flight receipt remains a replay barrier even if completion cannot be saved.
        throw failure('MCP_OPERATION_STORE_WRITE_FAILED', { dispatched: outcome.dispatched, outcomeUnknown: true });
      }
      active.receipt = outcome;
      return { ...outcome, pending: false, persisted: true, deduplicated: false };
    } catch (error) {
      if (error?.name === 'McpOperationStoreError') throw error;
      throw failure('MCP_OPERATION_STORE_UNAVAILABLE', { dispatched: active.dispatched, outcomeUnknown: active.dispatched });
    } finally {
      await lock.close().catch(() => {});
      // Never unlink another owner's lock, nor an unreadable/corrupted lock.
      const info = await this._lockInfo(request.operation_id).catch(() => null);
      if (info?.token === token) await fs.unlink(lockPath).catch(() => {});
    }
  }

  _serializeResult(result) {
    if (!object(result) || !Array.isArray(result.content) || (own(result, 'isError') && typeof result.isError !== 'boolean')) throw failure('MCP_OPERATION_RESULT_INVALID', { outcomeUnknown: true });
    let serialized;
    try {
      serialized = JSON.stringify(result, (_key, value) => {
        if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw Error();
        return value;
      });
    } catch { throw failure('MCP_OPERATION_RESULT_INVALID', { outcomeUnknown: true }); }
    if (Buffer.byteLength(serialized) > this.maxResultBytes) throw failure('MCP_OPERATION_RESULT_TOO_LARGE', { outcomeUnknown: true });
    return serialized;
  }

  _path(id, extension = 'json') { return path.join(this.directory, `${operationId(id)}.${extension}`); }

  async _ensureDirectory() {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
    } catch { throw failure('MCP_OPERATION_STORE_UNAVAILABLE'); }
  }

  async _read(id) {
    const file = this._path(id);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxResultBytes + 16384) throw Error();
      const bytes = await fs.readFile(file);
      if (bytes.length > this.maxResultBytes + 16384) throw Error();
      const record = JSON.parse(bytes.toString('utf8'));
      if (!object(record) || Object.keys(record).some(key => !RECORD_KEYS.has(key)) || record.schema_version !== 1 || record.operation_id !== id || !STATES.has(record.state) || !timestamp(record.created_at) || !timestamp(record.updated_at) || typeof record.dispatched !== 'boolean' || typeof record.retry_safe !== 'boolean') throw Error();
      assertSame(record, requestIdentity(record));
      if (record.state === 'completed') {
        if (!record.dispatched || record.retry_safe || !timestamp(record.completed_at)) throw Error();
        const serialized = this._serializeResult(record.result);
        if (record.result_sha256 !== sha256Text(serialized) || record.result_bytes !== Buffer.byteLength(serialized)) throw Error();
      } else if (own(record, 'result') || own(record, 'result_sha256') || own(record, 'result_bytes')) throw Error();
      if (record.state === 'failed_preflight' && (record.dispatched || !record.retry_safe)) throw Error();
      if (record.state !== 'failed_preflight' && record.retry_safe) throw Error();
      if (record.state === 'prepared' && record.dispatched || record.state === 'in_flight' && !record.dispatched) throw Error();
      if (own(record, 'dispatched_at') && !timestamp(record.dispatched_at)) throw Error();
      if (own(record, 'error_code') && !SAFE_ERRORS.has(record.error_code) && record.error_code !== 'MCP_OPERATION_FAILED') throw Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('MCP_OPERATION_STORE_CORRUPT', { outcomeUnknown: true });
    }
  }

  _external(record) {
    if (!TERMINAL.has(record.state)) return { ...record, state: 'outcome_unknown', recorded_state: record.state, dispatched: null, dispatch_recorded: record.dispatched, pending: false, owner_activity: 'unknown', retry_safe: false, persisted: true };
    return { ...record, pending: false, persisted: true };
  }

  async _lockInfo(id) {
    const file = this._path(id, 'lock');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { present: true };
      let value;
      try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return { present: true }; }
      if (!object(value) || value.schema_version !== 1 || typeof value.lock_token !== 'string') return { present: true };
      try { return { present: true, request: requestIdentity(value.request), token: value.lock_token }; }
      catch { return { present: true }; }
    } catch (error) {
      if (error.code === 'ENOENT') return { present: false };
      throw failure('MCP_OPERATION_STORE_UNAVAILABLE', { outcomeUnknown: true });
    }
  }

  _locked(id, info) {
    return { ...(info.request || {}), operation_id: id, state: 'outcome_unknown', pending: false, owner_activity: 'unknown', lock_present: info.present, persisted: false, dispatched: null, retry_safe: false, error_code: 'MCP_OPERATION_LOCKED' };
  }

  async _write(receipt) {
    const file = this._path(receipt.operation_id);
    const temp = path.join(this.directory, `.${receipt.operation_id}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(receipt));
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temp, file);
      // POSIX directory fsync makes the rename durable; Windows has no portable directory fsync.
      if (process.platform !== 'win32') {
        const dir = await fs.open(this.directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } catch {
      throw failure('MCP_OPERATION_STORE_WRITE_FAILED', { dispatched: receipt.dispatched, outcomeUnknown: receipt.dispatched });
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
    }
  }
}

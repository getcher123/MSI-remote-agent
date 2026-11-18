import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const SUPPORTED_MCP_PROTOCOLS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

// Deliberately never contains the command, URL, headers, stderr, or peer error text.
export class McpClientError extends Error {
  constructor(code, { dispatched = false, outcomeUnknown = false, rpcCode, httpStatus } = {}) {
    super(`Local MCP: ${code}`);
    this.name = 'McpClientError';
    this.code = code;
    this.dispatched = dispatched;
    this.outcomeUnknown = outcomeUnknown;
    if (Number.isSafeInteger(rpcCode)) this.rpcCode = rpcCode;
    if (Number.isSafeInteger(httpStatus)) this.httpStatus = httpStatus;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const errorFor = (code, ctx = {}, details = {}) => new McpClientError(code, {
  dispatched: ctx.dispatched === true,
  outcomeUnknown: ctx.dispatched === true && ctx.method === 'tools/call',
  ...details,
});

/**
 * An intentionally small client for the initialize-based MCP protocol versions.
 * Caller owns endpoint/command authorization and durable tools/call receipts.
 * No reconnect, request replay, OAuth flow, or server-initiated AI capabilities.
 * spawnFn may be async ONLY if stdout remains paused until its child is returned.
 */
export class LocalMcpClient {
  constructor({ transport, command, args = [], cwd, env, url, headers = {}, protocol = 'legacy',
    protocolVersion = '2025-11-25', timeoutMs = 15000, maxMessageBytes = 8 * 1024 * 1024,
    spawnFn = spawn, fetchFn = globalThis.fetch, closeFn, clientInfo } = {}) {
    if (!['stdio', 'streamable-http'].includes(transport)) throw errorFor('UNSUPPORTED_TRANSPORT');
    if (protocol !== 'legacy' || !SUPPORTED_MCP_PROTOCOLS.includes(protocolVersion)) throw errorFor('UNSUPPORTED_PROTOCOL');
    if (!integer(timeoutMs, 1, 300000) || !integer(maxMessageBytes, 1024, 64 * 1024 * 1024)) throw errorFor('INVALID_LIMIT');
    if (typeof spawnFn !== 'function' || typeof fetchFn !== 'function' || (closeFn !== undefined && typeof closeFn !== 'function')) throw errorFor('INVALID_ADAPTER');
    if (transport === 'stdio' && (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw errorFor('INVALID_COMMAND');
    if (env !== undefined && (!object(env) || Object.values(env).some(value => typeof value !== 'string'))) throw errorFor('INVALID_ENV');
    this.transport = transport;
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = { ...(env || process.env) };
    for (const key of Object.keys(this.env)) if (key.toUpperCase() === 'CONTROL_PLANE_API_KEY') delete this.env[key];
    this.timeoutMs = timeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.spawnFn = spawnFn;
    this.fetchFn = fetchFn;
    this.closeFn = closeFn;
    this.protocolVersion = protocolVersion;
    this.clientInfo = clientInfo || { name: 'aihub-remote-agent-mcp-bridge', version: '1.0.0' };
    this._headers = new Headers();
    try {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value !== 'string') throw new Error();
        if (['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'].includes(key.toLowerCase())) throw new Error();
        this._headers.set(key, value);
      }
    } catch { throw errorFor('INVALID_HEADERS'); }
    if (transport === 'streamable-http') {
      let parsed;
      try { parsed = new URL(url); } catch { throw errorFor('INVALID_ENDPOINT'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw errorFor('INVALID_ENDPOINT');
      this._url = parsed.href;
    }
    this.child = null;
    this.connected = false;
    this.info = null;
    this._closed = false;
    this._failed = false;
    this._connectPromise = null;
    this._pending = new Map();
    this._nextId = 1;
    this._httpSession = null;
    this._httpControllers = new Set();
    this._stdoutChunks = [];
    this._stdoutBytes = 0;
    this._stderrBytes = 0;
    this._childExited = false;
    this._closeReport = null;
    this._closePromise = null;
  }

  async connect() {
    if (this._closed) throw errorFor('CLIENT_CLOSED');
    if (this._failed) throw errorFor('CONNECTION_FAILED');
    if (this.connected) return this.info;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect();
    return this._connectPromise;
  }

  async _connect() {
    try {
      if (this.transport === 'stdio') await this._startStdio();
      const init = await this._rawRequest('initialize', {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      });
      if (!object(init) || !SUPPORTED_MCP_PROTOCOLS.includes(init.protocolVersion)) throw errorFor('UNSUPPORTED_NEGOTIATED_PROTOCOL');
      if (!object(init.serverInfo) || typeof init.serverInfo.name !== 'string' || typeof init.serverInfo.version !== 'string' || !object(init.capabilities)) throw errorFor('INVALID_INITIALIZE_RESULT');
      this.protocolVersion = init.protocolVersion;
      this.info = {
        transport: this.transport,
        protocol_version: this.protocolVersion,
        server: { name: init.serverInfo.name.slice(0, 160), version: init.serverInfo.version.slice(0, 80) },
        capabilities: capabilitySummary(init.capabilities),
      };
      await this._notification('notifications/initialized', {});
      if (this._closed || this._failed) throw errorFor('CONNECTION_CLOSED');
      this.connected = true;
      return this.info;
    } catch (error) {
      this._failed = true;
      this.connected = false;
      // Initialization must never leave an otherwise-unreachable owned subprocess.
      if (this.child) await this._closeChild({ force: false, waitMs: 250 }).catch(() => {});
      throw error instanceof McpClientError ? error : errorFor('CONNECT_FAILED');
    }
  }

  async _startStdio() {
    let spawned;
    try {
      spawned = this.spawnFn(this.command, this.args, {
        cwd: this.cwd, env: this.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = spawned && typeof spawned.then === 'function' ? await spawned : spawned;
    } catch { throw errorFor('SPAWN_FAILED'); }
    const child = this.child;
    if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.on !== 'function') throw errorFor('INVALID_CHILD');
    child.stdout.on('data', chunk => this._onStdioChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', chunk => { this._stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this._stderrBytes + Buffer.byteLength(chunk)); });
    child.stdin.on('error', () => this._failConnection('STDIN_CLOSED'));
    child.on('error', () => this._failConnection('PROCESS_ERROR'));
    child.on('close', () => {
      this._childExited = true;
      if (this._stdoutBytes !== 0) this._failConnection('INCOMPLETE_FRAME');
      else this._failConnection('CONNECTION_CLOSED');
    });
    child.stdout.resume(); // An async adapter must hand over a paused, unconsumed stream.
    if (child.exitCode !== null && child.exitCode !== undefined) throw errorFor('PROCESS_EXITED');
    // For a custom already-spawned child, pid is enough; attach before awaiting anything.
    if (child.pid) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(errorFor('SPAWN_TIMEOUT')), this.timeoutMs);
      const onSpawn = () => done();
      const onError = () => done(errorFor('SPAWN_FAILED'));
      const done = error => {
        clearTimeout(timer);
        child.off('spawn', onSpawn);
        child.off('error', onError);
        child.off('close', onError);
        error ? reject(error) : resolve();
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.once('close', onError);
    });
  }

  _onStdioChunk(chunk) {
    if (this._closed || this._failed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(10, offset);
      const end = lf < 0 ? chunk.length : lf;
      const part = chunk.subarray(offset, end);
      this._stdoutBytes += part.length;
      if (this._stdoutBytes > this.maxMessageBytes) {
        this._stdoutChunks = [];
        this._stdoutBytes = 0;
        this._failConnection('MESSAGE_TOO_LARGE');
        return;
      }
      this._stdoutChunks.push(part);
      if (lf < 0) return;
      let line;
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this._stdoutChunks, this._stdoutBytes)).trim(); }
      catch { this._failConnection('INVALID_UTF8'); return; }
      this._stdoutChunks = [];
      this._stdoutBytes = 0;
      if (line) {
        let message;
        try { message = JSON.parse(line); } catch { this._failConnection('INVALID_JSON'); return; }
        this._handleStdioMessage(message);
        if (this._failed) return;
      }
      offset = lf + 1;
    }
  }

  _handleStdioMessage(message) {
    if (!object(message) || message.jsonrpc !== '2.0') { this._failConnection('INVALID_RPC_MESSAGE'); return; }
    if (typeof message.method === 'string') {
      if (own(message, 'id')) void this._writeStdio(serverReply(message)).catch(() => this._failConnection('STDIN_CLOSED'));
      return; // No advertised client-side capabilities, notifications need no response.
    }
    const pending = this._pending.get(message.id);
    if (!pending) return; // Late response to a timed-out call does not trigger another call.
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    try { pending.resolve(rpcResult(message, pending)); }
    catch (error) { pending.reject(error); }
  }

  _failConnection(code) {
    this._failed = true;
    this.connected = false;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(errorFor(code, pending));
    }
    this._pending.clear();
  }

  async request(method, params = {}, options = {}) {
    validateMethod(method);
    if (method === 'initialize' || method.startsWith('notifications/')) throw errorFor('RESERVED_METHOD');
    try { await this.connect(); }
    catch (error) {
      // Handshake traffic is not dispatch of the caller's tool/resource request.
      throw errorFor(error instanceof McpClientError ? error.code : 'CONNECT_FAILED', {}, { rpcCode: error.rpcCode, httpStatus: error.httpStatus });
    }
    if (!this.connected || this._failed) throw errorFor('CONNECTION_CLOSED');
    return this._rawRequest(method, params, options);
  }

  async _rawRequest(method, params, { timeoutMs = this.timeoutMs, onDispatched } = {}) {
    validateMethod(method);
    if (!integer(timeoutMs, 1, 300000) || (onDispatched !== undefined && typeof onDispatched !== 'function')) throw errorFor('INVALID_REQUEST_OPTIONS');
    if (this._closed || this._failed) throw errorFor('CONNECTION_CLOSED');
    const id = this._nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const body = this._encode(message);
    const ctx = { method, dispatched: false };
    if (this.transport === 'streamable-http') return this._httpRequest(message, body, { timeoutMs, onDispatched, ctx });
    return new Promise((resolve, reject) => {
      const pending = { ...ctx, resolve, reject, timer: null };
      this._pending.set(id, pending);
      pending.timer = setTimeout(() => {
        if (!this._pending.delete(id)) return;
        reject(errorFor('REQUEST_TIMEOUT', pending));
        if (pending.dispatched) void this._notification('notifications/cancelled', { requestId: id, reason: 'Client timeout' }).catch(() => {});
      }, timeoutMs);
      void (async () => {
        try {
          if (onDispatched) await onDispatched(); // Durable write-before-dispatch hook.
          if (!this._pending.has(id)) return;
          if (this._closed || this._failed || this.child.stdin.destroyed) throw errorFor('CONNECTION_CLOSED');
          pending.dispatched = true;
          await this._writeStdio(body, true);
        } catch (error) {
          if (!this._pending.delete(id)) return;
          clearTimeout(pending.timer);
          reject(error instanceof McpClientError && !pending.dispatched ? error : errorFor('SEND_FAILED', pending));
        }
      })();
    });
  }

  _encode(message) {
    let body;
    try { body = JSON.stringify(message); } catch { throw errorFor('INVALID_JSON_ARGUMENTS'); }
    if (Buffer.byteLength(body) > this.maxMessageBytes) throw errorFor('MESSAGE_TOO_LARGE');
    return body;
  }

  async _writeStdio(message, encoded = false) {
    const body = encoded ? message : this._encode(message);
    if (!this.child?.stdin || this.child.stdin.destroyed) throw errorFor('STDIN_CLOSED');
    await new Promise((resolve, reject) => this.child.stdin.write(`${body}\n`, 'utf8', error => error ? reject(errorFor('SEND_FAILED')) : resolve()));
  }

  _requestHeaders() {
    const headers = new Headers(this._headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json, text/event-stream');
    headers.set('MCP-Protocol-Version', this.protocolVersion);
    if (this._httpSession) headers.set('Mcp-Session-Id', this._httpSession);
    return headers;
  }

  async _httpRequest(message, body, { timeoutMs, onDispatched, ctx }) {
    const controller = new AbortController();
    this._httpControllers.add(controller);
    let timedOut = false;
    let response;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      if (onDispatched) await onDispatched();
      if (controller.signal.aborted) throw errorFor('REQUEST_TIMEOUT', ctx);
      if (this._closed || this._failed) throw errorFor('CONNECTION_CLOSED', ctx);
      ctx.dispatched = true;
      response = await this.fetchFn(this._url, {
        method: 'POST', headers: this._requestHeaders(), body, redirect: 'manual', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) { await cancelBody(response); throw errorFor('HTTP_REDIRECT_DENIED', ctx, { httpStatus: response.status }); }
      if (response.status !== 200) {
        if (response.status === 404) {
          // Expired/missing HTTP session needs an explicit new connection.
          // Do not leave a cached handshake advertised as a live connection.
          this._failed = true;
          this.connected = false;
        }
        await cancelBody(response);
        throw errorFor('HTTP_STATUS', ctx, { httpStatus: response.status });
      }
      const session = response.headers.get('mcp-session-id');
      if (session) {
        if (message.method !== 'initialize' && session !== this._httpSession) throw errorFor('SESSION_CHANGED', ctx);
        if (session.length > 1024 || /[^\x21-\x7e]/.test(session)) throw errorFor('INVALID_SESSION', ctx);
        this._httpSession = session;
      }
      const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (type === 'application/json') {
        const text = await readBounded(response, this.maxMessageBytes);
        let reply;
        try { reply = JSON.parse(text); } catch { throw errorFor('INVALID_JSON', ctx); }
        if (!object(reply) || reply.id !== message.id) throw errorFor('RESPONSE_ID_MISMATCH', ctx);
        return rpcResult(reply, ctx);
      }
      if (type === 'text/event-stream') return await this._readSse(response, message.id, ctx, controller.signal);
      await cancelBody(response);
      throw errorFor('UNSUPPORTED_CONTENT_TYPE', ctx);
    } catch (error) {
      if (timedOut) throw errorFor('REQUEST_TIMEOUT', ctx);
      if (error instanceof McpClientError) {
        // rpcResult already identifies an explicit JSON-RPC rejection as a known result.
        if (error.code === 'RPC_ERROR') throw error;
        throw errorFor(error.code, ctx, { httpStatus: error.httpStatus });
      }
      throw errorFor(this._closed ? 'CLIENT_CLOSED' : 'HTTP_CONNECTION_FAILED', ctx);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response) await cancelBody(response);
      this._httpControllers.delete(controller);
    }
  }

  async _readSse(response, id, ctx, signal) {
    if (!response.body) throw errorFor('EMPTY_RESPONSE', ctx);
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', data = [], bytes = 0;
    const consumeLine = async line => {
      if (line === '') {
        if (!data.length) return null;
        const encoded = data.join('\n');
        data = [];
        let message;
        try { message = JSON.parse(encoded); } catch { throw errorFor('INVALID_JSON', ctx); }
        if (!object(message) || message.jsonrpc !== '2.0') throw errorFor('INVALID_RPC_MESSAGE', ctx);
        if (typeof message.method === 'string') {
          if (own(message, 'id')) await this._httpNotificationBody(this._encode(serverReply(message)), signal);
          return null;
        }
        if (message.id !== id) return null;
        return { result: rpcResult(message, ctx) };
      }
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      return null;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer) await consumeLine(buffer.replace(/\r$/, ''));
          const final = await consumeLine('');
          if (final) return final.result;
          throw errorFor('RESPONSE_STREAM_ENDED', ctx);
        }
        bytes += value.byteLength;
        if (bytes > this.maxMessageBytes) throw errorFor('MESSAGE_TOO_LARGE', ctx);
        buffer += decoder.decode(value, { stream: true });
        let lf;
        while ((lf = buffer.search(/[\r\n]/)) >= 0) {
          // Preserve a trailing CR until the next chunk can distinguish CRLF.
          if (buffer[lf] === '\r' && lf === buffer.length - 1) break;
          const line = buffer.slice(0, lf);
          const width = buffer[lf] === '\r' && buffer[lf + 1] === '\n' ? 2 : 1;
          buffer = buffer.slice(lf + width);
          const found = await consumeLine(line);
          if (found) return found.result;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }

  async _notification(method, params) {
    const body = this._encode({ jsonrpc: '2.0', method, params });
    if (this.transport === 'stdio') return this._writeStdio(body, true);
    return this._httpNotificationBody(body);
  }

  async _httpNotificationBody(body, existingSignal) {
    const controller = existingSignal ? null : new AbortController();
    if (controller) this._httpControllers.add(controller);
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetchFn(this._url, { method: 'POST', headers: this._requestHeaders(), body, redirect: 'manual', signal: existingSignal || controller.signal });
      await cancelBody(response);
      if (![200, 202, 204].includes(response.status)) throw errorFor('NOTIFICATION_REJECTED', {}, { httpStatus: response.status });
    } catch (error) { throw error instanceof McpClientError ? error : errorFor('NOTIFICATION_FAILED'); }
    finally { if (timer) clearTimeout(timer); if (controller) this._httpControllers.delete(controller); }
  }

  async listTools({ cursor } = {}) { return this.request('tools/list', pagination(cursor)); }
  async listResources({ cursor } = {}) { return this.request('resources/list', pagination(cursor)); }
  async listResourceTemplates({ cursor } = {}) { return this.request('resources/templates/list', pagination(cursor)); }
  async listPrompts({ cursor } = {}) { return this.request('prompts/list', pagination(cursor)); }
  async readResource(uri, options = {}) {
    if (typeof uri !== 'string' || !uri || uri.length > 16384) throw errorFor('INVALID_RESOURCE_URI');
    return this.request('resources/read', { uri }, options);
  }
  async getPrompt(name, args = {}, options = {}) {
    validateName(name);
    if (!object(args) || Object.values(args).some(value => typeof value !== 'string')) throw errorFor('INVALID_PROMPT_ARGUMENTS');
    return this.request('prompts/get', { name, arguments: args }, options);
  }
  async callTool(name, args = {}, options = {}) {
    validateName(name);
    if (!object(args)) throw errorFor('INVALID_TOOL_ARGUMENTS');
    return this.request('tools/call', { name, arguments: args }, options);
  }

  async close({ force = false, waitMs = 500 } = {}) {
    if (!integer(waitMs, 0, 10000) || typeof force !== 'boolean') throw errorFor('INVALID_CLOSE_OPTIONS');
    if (this._closePromise) return this._closePromise;
    if (this._closed && (this.transport !== 'stdio' || !this.child || this._closeReport?.closed === true)) return this._closeReport;
    this._closePromise = this._closeOnce({ force, waitMs });
    try { return await this._closePromise; }
    finally { this._closePromise = null; }
  }

  async _closeOnce({ force, waitMs }) {
    this._closed = true;
    this._failConnection('CLIENT_CLOSED');
    for (const controller of this._httpControllers) controller.abort();
    if (this.transport === 'stdio') this._closeReport = await this._closeChild({ force, waitMs });
    else {
      let sessionClosed = null;
      if (this._httpSession) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.timeoutMs, waitMs || 500)));
        try {
          const response = await this.fetchFn(this._url, { method: 'DELETE', headers: this._requestHeaders(), redirect: 'manual', signal: controller.signal });
          sessionClosed = response.ok || response.status === 404;
          await cancelBody(response);
        } catch { sessionClosed = false; }
        finally { clearTimeout(timer); }
      }
      this._closeReport = { closed: true, session_closed: sessionClosed };
    }
    return this._closeReport;
  }

  async _closeChild({ force, waitMs }) {
    const child = this.child;
    if (!child) return { closed: true, process_exit_confirmed: true };
    if (this.closeFn) {
      try { return await this.closeFn(child, { force, waitMs }); }
      catch { return { closed: false, process_exit_confirmed: this._childExited, error: 'CLOSE_ADAPTER_FAILED' }; }
    }
    if (!child.stdin.destroyed) child.stdin.end();
    const deadline = Date.now() + waitMs;
    while (!this._childExited && Date.now() < deadline) await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    if (!this._childExited && child.pid && child.exitCode === null && child.signalCode === null) {
      try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
      const signalDeadline = Date.now() + Math.min(500, waitMs);
      while (!this._childExited && Date.now() < signalDeadline) await delay(Math.min(20, Math.max(1, signalDeadline - Date.now())));
    }
    return { closed: this._childExited, process_exit_confirmed: this._childExited, process_tree_confirmed: false };
  }
}

function rpcResult(message, ctx) {
  if (!object(message) || message.jsonrpc !== '2.0' || (own(message, 'result') === own(message, 'error'))) throw errorFor('INVALID_RPC_RESPONSE', ctx);
  if (own(message, 'error')) {
    if (!object(message.error) || !Number.isInteger(message.error.code)) throw errorFor('INVALID_RPC_ERROR', ctx);
    throw errorFor('RPC_ERROR', ctx, { outcomeUnknown: false, rpcCode: message.error.code });
  }
  return message.result;
}

function serverReply(message) {
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability unavailable' } };
}

function validateMethod(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\r\n\0]/.test(value)) throw errorFor('INVALID_METHOD');
}
function validateName(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value)) throw errorFor('INVALID_NAME');
}
function pagination(cursor) {
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 16384)) throw errorFor('INVALID_CURSOR');
  return cursor === undefined ? {} : { cursor };
}
function capabilitySummary(value) {
  const result = {};
  for (const key of ['tools', 'resources', 'prompts', 'logging', 'completions']) {
    if (!object(value[key])) continue;
    result[key] = {};
    for (const flag of ['listChanged', 'subscribe']) if (typeof value[key][flag] === 'boolean') result[key][flag] = value[key][flag];
  }
  return result;
}
async function cancelBody(response) { try { await response.body?.cancel(); } catch {} }
async function readBounded(response, maxBytes) {
  if (!response.body) throw errorFor('EMPTY_RESPONSE');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw errorFor('MESSAGE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw errorFor('INVALID_UTF8'); }
  } finally { await reader.cancel().catch(() => {}); }
}

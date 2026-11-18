import { setTimeout as delay } from 'node:timers/promises';
import { LocalMcpClient } from './mcp-client.mjs';
import { LocalMcpRegistry } from './mcp-registry.mjs';
import { McpOperationStore } from './mcp-operation-store.mjs';
import { stableJson, sha256Text, VERSION } from './util.mjs';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function fault(code) { return Object.assign(new Error(code), { code, dispatched: false }); }
function bounded(value, fallback, min, max, name) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw fault(`INVALID_${name}`);
  return number;
}
function envValue(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ['CONTROL_PLANE_API_KEY', 'WSLENV'].includes(name.toUpperCase())) throw fault('MCP_ENV_REFERENCE_DENIED');
  const found = Object.keys(process.env).find((key) => process.platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name);
  if (!found) throw fault('MCP_ENV_REFERENCE_UNAVAILABLE');
  return process.env[found];
}

/** Explicit local MCP registrations, persistent connections and durable calls. */
export class LocalMcpBridge {
  constructor(config, pathPolicy, processManager, options = {}) {
    this.config = config;
    this.pathPolicy = pathPolicy;
    this.processManager = processManager;
    this.registry = options.registry || new LocalMcpRegistry(config, pathPolicy);
    this.operations = options.operations || new McpOperationStore(config);
    this.clientFactory = options.clientFactory || ((spec) => new LocalMcpClient(spec));
    this.sessions = new Map();
    this.queues = new Map();
  }

  discover(args = {}) { return this.registry.discover(args); }
  async register(args) {
    if (this.sessions.has(args.server_id) || this.queues.has(args.server_id)) throw fault('DISCONNECT_MCP_BEFORE_REGISTER');
    return this.registry.register(args);
  }
  async servers() {
    const list = await this.registry.list();
    return { ...list, servers: list.servers.map((entry) => {
      const session = this.sessions.get(entry.server_id);
      return { ...entry, connection: session ? (session.client.connected ? 'connected' : 'disconnected_or_failed') : 'not_connected',
        active_requests: session?.active || 0, protocol: session?.client.info || null };
    }) };
  }

  async withServer(id, action) {
    if (typeof id !== 'string' || !id) throw fault('MCP_SERVER_ID_REQUIRED');
    const previous = this.queues.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.queues.set(id, tail);
    await previous.catch(() => {});
    let session;
    try {
      session = await this.getSession(id);
      session.active++;
      return await action(session);
    } finally {
      if (session) session.active--;
      release();
      if (this.queues.get(id) === tail) this.queues.delete(id);
    }
  }

  async getSession(serverId) {
    const resolved = await this.registry.resolve(serverId);
    let existing = this.sessions.get(serverId);
    if (existing) {
      if (existing.fingerprint !== resolved.fingerprint) throw fault('MCP_CONFIGURATION_CHANGED');
      if (!existing.client.connected) throw fault('MCP_RECONNECT_REQUIRES_DISCONNECT');
      return existing;
    }
    const d = resolved.definition;
    const timeoutMs = bounded(d.startupTimeoutMs, Math.min(d.timeoutMs || 15000, 30000), 1, 300000, 'MCP_TIMEOUT');
    const session = { fingerprint: resolved.fingerprint, definition: d, client: null, active: 0, processId: null };
    const spec = { transport: d.transport, protocol: 'legacy', timeoutMs,
      maxMessageBytes: this.config.localMcp?.maxResultBytes || 8 * 1024 * 1024,
      clientInfo: { name: 'aihub-remote-agent', version: VERSION } };
    if (d.transport === 'stdio') {
      let command = d.command;
      if (d.runtime === 'windows' && process.platform === 'win32' && /^\/mnt\/[a-z]\//i.test(command)) command = this.pathPolicy.toHostPath(command);
      this.processManager.validateCommand(command, d.args || []);
      if (d.cwd) await this.pathPolicy.authorize(d.cwd, 'read');
      const env = { ...(d.env || {}) };
      for (const name of d.envVars || []) env[name] = envValue(name);
      for (const key of Object.keys(env)) if (['CONTROL_PLANE_API_KEY', 'WSLENV'].includes(key.toUpperCase())) throw fault('MCP_ENV_REFERENCE_DENIED');
      Object.assign(spec, { command, args: d.args || [], cwd: d.cwd, env,
        spawnFn: async () => {
          const started = await this.processManager.start({ runtime: d.runtime, executable: command, args: d.args || [], cwd: d.cwd, env,
            timeout_ms: 0, label: `MCP ${serverId}` }, { internal: true, captureOutput: false, logOutput: false });
          session.processId = started.session_id;
          return this.processManager.getInternal(started.session_id).child;
        },
        closeFn: async (child, { force = false, waitMs = 1000 } = {}) => {
          if (!child.stdin.destroyed) child.stdin.end();
          const until = Date.now() + Math.min(waitMs, 1000);
          let tracked = this.processManager.getInternal(session.processId);
          while (!tracked.closed && Date.now() < until) await delay(20);
          if (tracked.closed) return this.confirmProcessClose(tracked);
          const stopped = await this.processManager.terminateInternal(session.processId, force, 'mcp_disconnect', Math.min(waitMs, 2000));
          const confirmed = await this.confirmProcessClose(tracked);
          return { ...stopped, ...confirmed };
        },
      });
    } else {
      let endpoint;
      try { endpoint = new URL(d.url); } catch { throw fault('INVALID_MCP_ENDPOINT'); }
      if (endpoint.username || endpoint.password || endpoint.hash) throw fault('INVALID_MCP_ENDPOINT');
      const allowedHttp = new Set(['localhost', '127.0.0.1', '[::1]', ...(this.config.localMcp?.allowedHttpHosts || [])]);
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && allowedHttp.has(endpoint.hostname.toLowerCase()))) throw fault('MCP_HTTP_HOST_NOT_ALLOWED');
      const headers = { ...(d.headers || {}) };
      for (const [header, name] of Object.entries(d.headerEnv || {})) headers[header] = envValue(name);
      if (d.bearerTokenEnvVar) headers.Authorization = `Bearer ${envValue(d.bearerTokenEnvVar)}`;
      Object.assign(spec, { url: endpoint.href, headers });
    }
    session.client = this.clientFactory(spec);
    this.sessions.set(serverId, session);
    await session.client.connect();
    return session;
  }

  toolAllowed(definition, name) {
    return (!definition.enabledTools || definition.enabledTools.includes(name)) && !(definition.disabledTools || []).includes(name);
  }
  async tools({ server_id, cursor } = {}) {
    return this.withServer(server_id, async ({ client, definition }) => {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      return { ...page, tools: (page.tools || []).filter((tool) => this.toolAllowed(definition, tool.name)), protocol: client.info, server_id };
    });
  }
  async findTool(session, name) {
    if (!this.toolAllowed(session.definition, name)) throw fault('MCP_TOOL_DISABLED');
    let cursor;
    const cursors = new Set();
    for (let pages = 0; pages < 50; pages++) {
      const page = await session.client.listTools(cursor === undefined ? {} : { cursor });
      const tool = page.tools?.find((item) => item.name === name);
      if (tool) return tool;
      if (page.nextCursor === undefined) break;
      if (cursors.has(page.nextCursor)) throw fault('MCP_PAGINATION_CYCLE');
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    throw fault('MCP_TOOL_NOT_FOUND');
  }

  async call({ server_id, tool_name, arguments: args = {}, operation_id, confirm_mutation, timeout_ms, wait_ms = 1000 }) {
    if (confirm_mutation !== true) throw fault('CONFIRM_MUTATION_REQUIRED');
    if (typeof tool_name !== 'string' || !tool_name || tool_name.length > 256 || !object(args)) throw fault('INVALID_MCP_CALL');
    const serialized = stableJson(args);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw fault('MCP_ARGUMENTS_TOO_LARGE');
    const registered = await this.registry.resolve(server_id);
    const timeoutMs = bounded(timeout_ms, registered.definition.timeoutMs || 60000, 1, 300000, 'MCP_TIMEOUT');
    const waitMs = bounded(wait_ms, 1000, 0, 10000, 'MCP_WAIT');
    const promise = this.operations.run({ operation_id, server_id, tool_name, arguments_hash: sha256Text(serialized), server_fingerprint: registered.fingerprint },
      async ({ markDispatched }) => this.withServer(server_id, async (session) => {
        if (session.fingerprint !== registered.fingerprint) throw fault('MCP_CONFIGURATION_CHANGED');
        await this.findTool(session, tool_name);
        return session.client.callTool(tool_name, args, { timeoutMs, onDispatched: markDispatched });
      }));
    let timer;
    try {
      const value = await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
      if (value !== null) return value;
      // Reading this receipt never dispatches a request or changes the operation id.
      return await this.operations.status(operation_id);
    } finally { clearTimeout(timer); }
  }
  operation({ operation_id }) { return this.operations.status(operation_id); }

  resources({ server_id, cursor }) { return this.withServer(server_id, async ({ client }) => ({ ...await client.listResources(cursor === undefined ? {} : { cursor }), server_id })); }
  readResource({ server_id, uri }) {
    if (typeof uri !== 'string' || !uri || uri.length > 8192) throw fault('INVALID_RESOURCE_URI');
    return this.withServer(server_id, async ({ client }) => ({ ...await client.readResource(uri), server_id }));
  }
  prompts({ server_id, cursor }) { return this.withServer(server_id, async ({ client }) => ({ ...await client.listPrompts(cursor === undefined ? {} : { cursor }), server_id })); }
  getPrompt({ server_id, name, arguments: args = {} }) {
    if (typeof name !== 'string' || !name || !object(args) || Object.values(args).some((v) => typeof v !== 'string')) throw fault('INVALID_PROMPT_ARGUMENTS');
    return this.withServer(server_id, async ({ client }) => ({ ...await client.getPrompt(name, args), server_id }));
  }

  async disconnect({ server_id, force = false, confirm_mutation }) {
    if (confirm_mutation !== true) throw fault('CONFIRM_MUTATION_REQUIRED');
    if (this.queues.has(server_id)) throw fault('MCP_REQUEST_ACTIVE');
    const session = this.sessions.get(server_id);
    if (!session) return { server_id, disconnected: true, already_disconnected: true };
    const report = await session.client.close({ force, waitMs: 1500 });
    const tracked = session.processId ? this.processManager.getInternal(session.processId) : null;
    const closed = !tracked || report.closed === true;
    if (closed) this.sessions.delete(server_id);
    return { server_id, disconnected: closed, process_exit_confirmed: tracked ? tracked.closed : null, close_report: report };
  }
  async unregister(args) {
    const stopped = await this.disconnect(args);
    if (!stopped.disconnected) throw fault('MCP_PROCESS_STILL_RUNNING');
    return this.registry.unregister(args);
  }
  async closeAll() {
    for (const [server_id, session] of this.sessions) {
      const report = await session.client.close({ force: false, waitMs: 500 }).catch(() => ({ closed: false }));
      if (!session.processId || report.closed === true) this.sessions.delete(server_id);
    }
  }
  async confirmProcessClose(tracked) {
    if (tracked.runtime !== 'wsl') return { closed: tracked.closed, exit_confirmed: tracked.closed, tree_exit_confirmed: null };
    let absent = null;
    if (tracked.wslIdentity) {
      try { absent = JSON.parse((await this.processManager.wslControl(tracked.wslIdentity, 'PROBE')).stdout.trim()).group_absent === true; }
      catch {}
    }
    return { closed: tracked.closed && absent === true, exit_confirmed: tracked.closed, tree_exit_confirmed: absent,
      ...(tracked.closed && absent !== true ? { reason: 'owned_wsl_group_cleanup_not_confirmed' } : {}) };
  }
}

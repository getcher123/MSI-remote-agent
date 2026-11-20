import readline from 'node:readline';
import { LEGACY_PROTOCOL_VERSION, SERVER_NAME, VERSION, randomId } from './util.mjs';
import { NATIVE_MCP_REPLY } from './mcp-reply.mjs';

// These handlers only inspect an already-created operation. Do not infer this
// privilege from caller annotations or from a tool's general read-only label.
const STATUS_TOOLS = new Set(['local_mcp_operation', 'codex_delivery_status']);

export class McpServer {
  constructor({ tools, handlers, audit, input = process.stdin, output = process.stdout }) {
    this.tools = tools;
    this.handlers = handlers;
    this.audit = audit;
    this.input = input;
    this.output = output;
    this.initialized = false;
  }

  async serveStdio() {
    const rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    const pending = new Set();
    let toolTail = Promise.resolve();
    let failure = null;
    const fail = error => { failure ??= error; rl.close(); };
    const track = promise => {
      // Observe every rejection immediately; a failed output stream must not
      // leave an unhandled rejection or silently keep dispatching queued tools.
      const task = Promise.resolve(promise).catch(fail);
      pending.add(task);
      void task.then(() => pending.delete(task));
      return task;
    };
    const schedule = message => {
      if (Array.isArray(message)) {
        for (const item of message) schedule(item);
        return;
      }
      const run = () => {
        if (failure) throw failure;
        return this.handle(message);
      };
      const name = message?.params?.name;
      const isStatus = STATUS_TOOLS.has(name) && this.handlers.get(name)?.mutation !== true;
      const serialized = message?.method === 'tools/call' && !isStatus;
      const task = track(serialized ? toolTail.then(run) : Promise.resolve().then(run));
      if (serialized) toolTail = task;
    };
    this.output.on('error', fail);
    try {
      for await (const line of rl) {
        if (failure) break;
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          track(this.writeError(null, -32700, 'Parse error', String(error)));
          continue;
        }
        // A slow tool must not block ping, handshake traffic, or receipt reads.
        // Other tool handlers keep their original serial mutation ordering.
        schedule(message);
      }
    } finally {
      // EOF ends input, not an accepted operation. Its final response must be
      // written before the owner closes its MCP children and exits.
      await Promise.all([...pending]);
      this.output.off('error', fail);
    }
    if (failure) throw failure;
  }

  async handle(message) {
    if (Array.isArray(message)) {
      for (const item of message) await this.handle(item);
      return;
    }
    if (!message || message.jsonrpc !== '2.0') {
      if (message?.id !== undefined) return this.writeError(message.id, -32600, 'Invalid Request');
      return;
    }
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized') this.initialized = true;
      if (message.method === 'notifications/cancelled') return;
      return;
    }
    try {
      switch (message.method) {
        case 'initialize':
          return this.writeResult(message.id, {
            protocolVersion: selectVersion(message.params?.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: VERSION },
            instructions: 'AIHub Remote Agent управляет разрешёнными локальными файлами, процессами, WSL, существующими Codex-сессиями и явно зарегистрированными локальными MCP. Перед mutation используйте confirm_mutation=true; queued не считается доставкой Codex. Для MCP сохраняйте operation_id: prepared/in_flight проверяйте через local_mcp_operation, outcome_unknown не повторяйте.',
          });
        case 'ping':
          return this.writeResult(message.id, {});
        case 'tools/list':
          return this.writeResult(message.id, { tools: this.tools });
        case 'tools/call':
          return await this.callTool(message.id, message.params);
        default:
          return this.writeError(message.id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return this.writeError(message.id, -32603, 'Internal error', String(error?.stack || error));
    }
  }

  async callTool(id, params) {
    const name = params?.name;
    const args = params?.arguments || {};
    const entry = this.handlers.get(name);
    if (!entry) return this.writeError(id, -32602, `Unknown tool: ${name}`);
    const started = Date.now();
    const callId = randomId('call');
    try {
      const result = await entry.handler(args);
      const native = result?.[NATIVE_MCP_REPLY] === true;
      await this.audit.record({ tool: name, args, status: native && result.isError ? 'error' : 'ok', durationMs: Date.now() - started, mutation: entry.mutation, result: native ? result.metadata : result });
      if (native) return this.writeResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ ...result.metadata, call_id: callId }, null, 2) }, ...result.content],
        structuredContent: { ...result.structuredContent, call_id: callId },
        isError: result.isError === true,
        ...(result.upstream?._meta === undefined ? {} : { _meta: result.upstream._meta }),
      });
      return this.writeResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ call_id: callId, ...result }, null, 2) }],
        structuredContent: { call_id: callId, ...result },
        isError: false,
      });
    } catch (error) {
      await this.audit.record({ tool: name, args, status: 'error', durationMs: Date.now() - started, mutation: entry.mutation, error });
      const result = { call_id: callId, error: String(error?.message || error), ...safeErrorMetadata(error) };
      return this.writeResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: true,
      });
    }
  }

  writeResult(id, result) {
    return this.writeMessage({ jsonrpc: '2.0', id, result });
  }

  writeError(id, code, message, data) {
    return this.writeMessage({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  }

  writeMessage(message) {
    const encoded = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      this.output.write(encoded, error => error ? reject(error) : resolve());
    });
  }
}

function safeErrorMetadata(error) {
  const result = {};
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)) result.error_code = error.code;
  for (const key of ['operation_id', 'receipt_id']) {
    if (typeof error?.[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(error[key])) result[key] = error[key];
  }
  return result;
}

function selectVersion(requested) {
  const supported = ['2025-11-25', '2025-06-18', '2025-03-26'];
  return supported.includes(requested) ? requested : LEGACY_PROTOCOL_VERSION;
}

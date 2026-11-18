import readline from 'node:readline';
import { LEGACY_PROTOCOL_VERSION, SERVER_NAME, VERSION, randomId } from './util.mjs';
import { NATIVE_MCP_REPLY } from './mcp-reply.mjs';

export class McpServer {
  constructor({ tools, handlers, audit }) {
    this.tools = tools;
    this.handlers = handlers;
    this.audit = audit;
    this.initialized = false;
  }

  async serveStdio() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.writeError(null, -32700, 'Parse error', String(error));
        continue;
      }
      await this.handle(message);
    }
  }

  async handle(message) {
    if (Array.isArray(message)) {
      for (const item of message) await this.handle(item);
      return;
    }
    if (!message || message.jsonrpc !== '2.0') {
      if (message?.id !== undefined) this.writeError(message.id, -32600, 'Invalid Request');
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
      return this.writeResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ call_id: callId, error: String(error?.message || error) }, null, 2) }],
        structuredContent: { call_id: callId, error: String(error?.message || error) },
        isError: true,
      });
    }
  }

  writeResult(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  writeError(id, code, message, data) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })}\n`);
  }
}

function selectVersion(requested) {
  const supported = ['2025-11-25', '2025-06-18', '2025-03-26'];
  return supported.includes(requested) ? requested : LEGACY_PROTOCOL_VERSION;
}

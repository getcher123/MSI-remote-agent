import readline from 'node:readline';
import fs from 'node:fs';

let initialized = false, calls = 0, asking = null;
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'PRIVATE_PEER_DETAIL_DO_NOT_LOG' } })}\n`);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const m = JSON.parse(line);
  if (!m.method && asking) {
    asking.replies.push({ id: m.id, error: m.error?.code ?? null });
    if (asking.replies.length === 2) { send(asking.id, { content: [{ type: 'text', text: JSON.stringify(asking.replies) }] }); asking = null; }
    continue;
  }
  if (m.method === 'initialize') {
    if (process.env.FIXTURE_STALL_INIT === '1') continue;
    process.stderr.write('PRIVATE_STDERR_DO_NOT_LOG\n');
    send(m.id, { protocolVersion: process.env.FIXTURE_PROTOCOL || m.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: 'fixture', version: '1' } });
  } else if (m.method === 'notifications/initialized') initialized = true;
  else if (m.method === 'notifications/cancelled') continue;
  else if (!initialized) fail(m.id, -32000);
  else if (m.method === 'tools/list') send(m.id, m.params?.cursor ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }], nextCursor: 'page:2' });
  else if (m.method === 'resources/list') send(m.id, { resources: [{ uri: 'fixture://one', name: 'One' }] });
  else if (m.method === 'resources/templates/list') send(m.id, { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'Fixture' }] });
  else if (m.method === 'resources/read') send(m.id, { contents: [{ uri: m.params.uri, mimeType: 'text/plain', text: 'resource text' }] });
  else if (m.method === 'prompts/list') send(m.id, { prompts: [{ name: 'greet' }] });
  else if (m.method === 'prompts/get') send(m.id, { messages: [{ role: 'user', content: { type: 'text', text: `Hello ${m.params.arguments.name}` } }] });
  else if (m.method === 'ping') send(m.id, {});
  else if (m.method === 'tools/call') {
    if (m.params.name === 'stats') { send(m.id, { content: [{ type: 'text', text: String(calls) }] }); continue; }
    calls++;
    if (process.env.FIXTURE_COUNTER_FILE) fs.appendFileSync(process.env.FIXTURE_COUNTER_FILE, `${m.params.name}\n`);
    if (m.params.name === 'crash') { process.exit(9); }
    else if (m.params.name === 'slow') { setTimeout(() => send(m.id, { content: [{ type: 'text', text: 'eventual' }] }), 150); }
    else if (m.params.name === 'error') fail(m.id, -32602);
    else if (m.params.name === 'huge') send(m.id, { content: [{ type: 'text', text: 'x'.repeat(12000) }] });
    else if (m.params.name === 'ask_client') {
      asking = { id: m.id, replies: [] };
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9101, method: 'ping' })}\n`);
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9102, method: 'sampling/createMessage', params: {} })}\n`);
    } else {
      const result = { content: [{ type: 'text', text: 'Русский текст 🧪' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'resource', resource: { uri: 'fixture://item', mimeType: 'text/plain', text: 'embedded' } }, { type: 'resource_link', uri: 'fixture://download', name: 'Download' }], structuredContent: { args: m.params.arguments, calls }, isError: false };
      const data = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n`);
      for (let pos = 0; pos < data.length; pos += 7) process.stdout.write(data.subarray(pos, pos + 7));
    }
  } else fail(m.id, -32601);
}

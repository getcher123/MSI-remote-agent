import readline from 'node:readline';
import fs from 'node:fs/promises';

// Test-only server, deliberately standalone: never imports the implementation
// whose behavior the integration tests exercise.
const counterPath = process.env.BRIDGE_COUNTER_FILE;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfS8AAAAASUVORK5CYII=';
const audio = Buffer.from('fixture-audio-bytes').toString('base64');
const tools = [
  { name: 'increment', description: 'Increment persistent counter once.', inputSchema: { type: 'object', properties: { delay_ms: { type: 'integer' }, drop_reply: { type: 'boolean' } } } },
  { name: 'forbidden', description: 'Must be filtered by local configuration.', inputSchema: { type: 'object' } },
  { name: 'mixed_content', description: 'Return native MCP content types.', inputSchema: { type: 'object' } },
  { name: 'environment_probe', description: 'Return only presence flags, never environment values.', inputSchema: { type: 'object' } },
];
const result = (id, value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
const error = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
const count = async () => {
  try { return Number(await fs.readFile(counterPath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
};
if (process.env.BRIDGE_PRIVATE_VALUE) process.stderr.write(`Private fixture stderr: ${process.env.BRIDGE_PRIVATE_VALUE}\n`);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('close', () => process.exit(0));
for await (const line of rl) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    result(id, { protocolVersion: '2025-11-25', serverInfo: { name: 'aihub-bridge-fixture', version: '1.0.0' }, capabilities: { tools: {}, resources: {}, prompts: {} } });
  } else if (method === 'ping') result(id, {});
  else if (method === 'tools/list') {
    if (params.cursor === 'second') result(id, { tools: tools.slice(2) });
    else result(id, { tools: tools.slice(0, 2), nextCursor: 'second' });
  } else if (method === 'tools/call') {
    const args = params.arguments || {};
    if (params.name === 'increment' || params.name === 'forbidden') {
      const next = await count() + 1;
      await fs.writeFile(counterPath, String(next));
      if (args.drop_reply) continue;
      if (args.delay_ms) await new Promise(resolve => setTimeout(resolve, args.delay_ms));
      result(id, { content: [{ type: 'text', text: `counter=${next}` }], structuredContent: { counter: next }, isError: false });
    } else if (params.name === 'mixed_content') {
      result(id, { content: [
        { type: 'text', text: 'Сцена доступна' },
        { type: 'image', mimeType: 'image/png', data: png },
        { type: 'audio', mimeType: 'audio/wav', data: audio },
        { type: 'resource', resource: { uri: 'fixture://scene/1', mimeType: 'application/json', text: '{"objects":1}' } },
        { type: 'resource_link', uri: 'fixture://render/1', name: 'render', mimeType: 'image/png' },
      ], structuredContent: { object_count: 1 }, isError: args.fail === true, _meta: { fixture: 'preserved' } });
    } else if (params.name === 'environment_probe') {
      const keys = Object.keys(process.env).map(key => key.toUpperCase());
      result(id, { content: [{ type: 'text', text: 'environment presence only' }], structuredContent: {
        tunnel_credential_present: keys.includes('CONTROL_PLANE_API_KEY'),
        explicit_value_present: process.env.BRIDGE_PRIVATE_VALUE !== undefined,
      } });
    } else error(id, -32602, 'Unknown fixture tool');
  } else if (method === 'resources/list') result(id, { resources: [{ uri: 'fixture://scene/1', name: 'Scene', mimeType: 'application/json' }] });
  else if (method === 'resources/read') result(id, { contents: [{ uri: params.uri, mimeType: 'application/json', text: '{"objects":1}' }] });
  else if (method === 'prompts/list') result(id, { prompts: [{ name: 'scene-help', description: 'Fixture instructions' }] });
  else if (method === 'prompts/get') result(id, { description: 'Fixture prompt', messages: [
    { role: 'user', content: { type: 'text', text: `Inspect ${params.arguments?.scene || 'scene'}` } },
    { role: 'assistant', content: { type: 'image', mimeType: 'image/png', data: png } },
  ] });
  else error(id, -32601, 'Method unavailable');
}

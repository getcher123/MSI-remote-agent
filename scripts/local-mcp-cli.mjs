#!/usr/bin/env node
// Local command-line access through the same bridge. A long call is awaited to
// completion so closing this CLI cannot silently abandon its protocol client.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/lib/config.mjs';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';
import { LocalMcpBridge } from '../server/lib/local-mcp-bridge.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'request-file': { type: 'string' } } });
const command = positionals[0] || 'discover';
const methods = { discover: 'discover', register: 'register', servers: 'servers', tools: 'tools', call: 'call', operation: 'operation',
  resources: 'resources', 'read-resource': 'readResource', prompts: 'prompts', 'get-prompt': 'getPrompt', unregister: 'unregister' };
if (!methods[command] || positionals.length > 1) throw Error('Supported commands: discover, register, servers, tools, call, operation, resources, read-resource, prompts, get-prompt, unregister');
const config = await loadConfig(), policy = new PathPolicy(config), manager = new ProcessManager(config, policy), bridge = new LocalMcpBridge(config, policy, manager);
try {
  let request = {};
  if (values['request-file']) {
    const auth = await policy.authorize(values['request-file'], 'read');
    const data = await fs.readFile(auth.realPath);
    if (data.length > 1024 * 1024) throw Error('REQUEST_FILE_TOO_LARGE');
    request = JSON.parse(data.toString('utf8'));
  }
  let result = await bridge[methods[command]](request);
  if (command === 'call') {
    while (['prepared', 'in_flight'].includes(result.state)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await bridge.operation({ operation_id: request.operation_id });
    }
    if (result.state !== 'completed' || result.result?.isError) process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error_code: error.code || 'LOCAL_MCP_CLI_FAILED' })}\n`);
  process.exitCode = 1;
} finally { await bridge.closeAll(); }

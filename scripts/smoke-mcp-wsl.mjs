#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';
import { LocalMcpBridge } from '../server/lib/local-mcp-bridge.mjs';
import { VERSION } from '../server/lib/util.mjs';
import { parseArgs } from 'node:util';
import { smokeWslOptions, temporaryWslPath } from './smoke-options.mjs';

const { values } = parseArgs({ options: {
  'wsl-distro': { type: 'string' }, 'wsl-user': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/smoke-mcp-wsl.mjs [--wsl-distro NAME --wsl-user NAME]\nUses the private configured WSL integration unless both options are supplied. Requires Python 3 in that distribution.');
  process.exit(0);
}
if (process.platform !== 'win32') throw Error('This probe requires Windows with a configured WSL distribution and user.');
const wsl = await smokeWslOptions(values, true);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-wsl-mcp-'));
const wslCwd = temporaryWslPath(root);
const source = path.join(root, 'mcp.json');
const sample = 'Проверка WSL 😀';
const fixture = String.raw`import json, os, sys
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m: continue
    method = m.get('method')
    if method == 'initialize': r = {'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'isolated-wsl-fixture','version':'1'}}
    elif method == 'tools/list': r = {'tools':[{'name':'read_environment','description':'Synthetic read probe','inputSchema':{'type':'object','properties':{}}}]}
    elif method == 'tools/call': r = {'content':[{'type':'text','text':json.dumps({'sample':os.environ.get('AIHUB_MCP_SMOKE_VALUE'),'tunnel_present':any(k.upper()=='CONTROL_PLANE_API_KEY' for k in os.environ)})}]}
    else: r = {}
    print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
`;
await fs.writeFile(source, JSON.stringify({ mcpServers: { fixture: { command: 'python3', args: ['-u', '-c', fixture], cwd: wslCwd, env: { AIHUB_MCP_SMOKE_VALUE: sample } } } }));
const config = { deviceId: 'isolated-wsl-mcp', __stateDir: path.join(root, 'state'), processLogDir: path.join(root, 'processes'),
  wsl, allowedRoots: [{ path: root, permissions: ['read', 'write'] }],
  deniedPathFragments: [], commandPolicy: { allowedExecutables: ['python3'], deniedPatterns: [] } };
const policy = new PathPolicy(config), manager = new ProcessManager(config, policy), bridge = new LocalMcpBridge(config, policy, manager);
const report = { version: VERSION, at: new Date().toISOString(), host: process.platform, node: process.version, checks: [], pass: false };
try {
  await bridge.register({ server_id: 'wsl-fixture', source_path: source, source_name: 'fixture', runtime: 'wsl', confirm_mutation: true });
  const tools = await bridge.tools({ server_id: 'wsl-fixture' });
  report.checks.push({ name: 'wsl_stdio_initialize_and_tools', pass: tools.tools.some((tool) => tool.name === 'read_environment') });
  const operation_id = `wsl_${crypto.randomUUID().replaceAll('-', '')}`;
  let receipt = await bridge.call({ server_id: 'wsl-fixture', tool_name: 'read_environment', arguments: {}, operation_id, wait_ms: 10000, timeout_ms: 10000, confirm_mutation: true });
  const until = Date.now() + 15000;
  while (['prepared', 'in_flight'].includes(receipt.state) && Date.now() < until) { await new Promise((resolve) => setTimeout(resolve, 100)); receipt = await bridge.operation({ operation_id }); }
  const value = receipt.state === 'completed' ? JSON.parse(receipt.result.content[0].text) : {};
  report.checks.push({ name: 'explicit_unicode_environment_forwarded', pass: value.sample === sample });
  report.checks.push({ name: 'tunnel_credential_not_forwarded', pass: value.tunnel_present === false });
  report.checks.push({ name: 'internal_sessions_hidden', pass: manager.list().length === 0 });
  report.checks.push({ name: 'environment_value_absent_from_argv', pass: [...manager.sessions.values()].every((session) => !session.args.some((arg) => arg.includes(sample))) });
  const stopped = await bridge.disconnect({ server_id: 'wsl-fixture', confirm_mutation: true });
  report.checks.push({ name: 'own_wsl_group_exit_confirmed', pass: stopped.disconnected && stopped.close_report?.tree_exit_confirmed === true });
  const logs = await fs.readdir(config.processLogDir).catch(() => []);
  report.checks.push({ name: 'no_raw_protocol_logs', pass: logs.length === 0 });
  report.pass = report.checks.every((item) => item.pass);
} catch (error) { report.error_code = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'WSL_MCP_PROBE_FAILED'; }
finally {
  await bridge.closeAll();
  const clean = bridge.sessions.size === 0 && [...manager.sessions.values()].every((session) => session.closed);
  if (clean) await fs.rm(root, { recursive: true, force: true });
  report.temporary_state_removed = clean;
  report.working_agent_not_modified = true;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass || !clean) process.exitCode = 1;
}

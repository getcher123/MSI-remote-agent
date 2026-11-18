#!/usr/bin/env node
// Isolated acceptance probe. Reads the registered server's catalog and a named
// read-only tool; never changes the running AIHub installation or source config.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';
import { LocalMcpBridge } from '../server/lib/local-mcp-bridge.mjs';
import { VERSION } from '../server/lib/util.mjs';
import { smokeWslOptions } from './smoke-options.mjs';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, server: { type: 'string' }, runtime: { type: 'string', default: 'native' },
  tool: { type: 'string' }, 'arguments-json': { type: 'string', default: '{}' },
  'wsl-user': { type: 'string' }, 'wsl-distro': { type: 'string' },
  'read-root': { type: 'string', multiple: true, default: [] },
  help: { type: 'boolean', short: 'h', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/smoke-local-mcp.mjs --source PATH --server NAME [--runtime native|windows|wsl] [--read-root PATH] [--tool NAME --arguments-json JSON]\nUse an existing MCP definition. Default action reads its catalog; --tool permits only explicitly enumerated read probes. WSL identity comes from private config or both --wsl-distro and --wsl-user.');
  process.exit(0);
}
if (!values.source || !values.server) throw Error('--source and --server are required');
if (!['native', 'windows', 'wsl'].includes(values.runtime)) throw Error('--runtime must be native, windows or wsl');
if (values.tool && !['get_scene_info', 'get_studio_state', 'list_roblox_studios'].includes(values.tool)) throw Error('Smoke allows only its explicitly enumerated read-only probes');
values.source = values.source.startsWith('/') || path.win32.isAbsolute(values.source) ? values.source : path.resolve(values.source);
const needsWsl = values.runtime === 'wsl' || process.platform === 'win32' && values.source.startsWith('/') && !/^\/mnt\/[a-z]\//i.test(values.source);
const wsl = await smokeWslOptions(values, needsWsl);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-mcp-smoke-'));
const sourceParent = values.source.startsWith('/') ? path.posix.dirname(values.source) : path.win32.dirname(values.source);
const config = { deviceId: 'isolated-mcp-smoke', __stateDir: temporary, processLogDir: path.join(temporary, 'processes'),
  wsl,
  allowedRoots: [{ path: sourceParent, permissions: ['read'] }, ...values['read-root'].map((root) => ({ path: root, permissions: ['read'] })), { path: temporary, permissions: ['read', 'write'] }], deniedPathFragments: [],
  commandPolicy: { allowedExecutables: ['python.exe', 'python3', 'python', 'node', 'node.exe', 'cmd.exe'], deniedPatterns: [] },
};
const policy = new PathPolicy(config), manager = new ProcessManager(config, policy), bridge = new LocalMcpBridge(config, policy, manager);
const report = { version: VERSION, at: new Date().toISOString(), host: process.platform, node: process.version, server: values.server, checks: [], pass: false };
let cleanupAllowed = false;
try {
  const discovery = await bridge.discover({ paths: [values.source] });
  const found = discovery.servers.some((entry) => entry.source_path === values.source && entry.source_name === values.server);
  report.checks.push({ name: 'existing_configuration_discovered', pass: found });
  if (!found) throw Error('EXISTING_CONFIGURATION_NOT_DISCOVERED');
  await bridge.register({ server_id: 'smoke-local', source_path: values.source, source_name: values.server, runtime: values.runtime, confirm_mutation: true });
  const catalog = await bridge.tools({ server_id: 'smoke-local' });
  report.protocol = catalog.protocol;
  report.tool_names = catalog.tools.map((tool) => tool.name);
  report.checks.push({ name: 'live_mcp_tools_list', pass: catalog.tools.length > 0 });
  report.checks.push({ name: 'protocol_process_not_public', pass: manager.list().length === 0 });
  if (values.tool) {
    const args = JSON.parse(values['arguments-json']);
    const targetTool = catalog.tools.find((tool) => tool.name === values.tool);
    const missing = (targetTool?.inputSchema?.required || []).filter((key) => !Object.prototype.hasOwnProperty.call(args, key));
    if (missing.length) { report.missing_argument_names = missing; throw Error('READ_PROBE_ARGUMENTS_REQUIRED'); }
    const operation_id = `smoke_${crypto.randomUUID().replaceAll('-', '')}`;
    const request = { server_id: 'smoke-local', tool_name: values.tool, arguments: args, operation_id, timeout_ms: 45000, wait_ms: 10000, confirm_mutation: true };
    let receipt = await bridge.call(request);
    const until = Date.now() + 50000;
    while (['prepared', 'in_flight'].includes(receipt.state) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      receipt = await bridge.operation({ operation_id });
    }
    let succeeded = receipt.state === 'completed' && receipt.result?.isError !== true;
    if (succeeded && values.tool === 'get_scene_info') {
      let scene = receipt.result.structuredContent;
      if (!scene) {
        for (const block of receipt.result.content || []) {
          if (block.type === 'text') { try { scene = JSON.parse(block.text); break; } catch {} }
        }
      }
      if (typeof scene?.result === 'string') { try { scene = JSON.parse(scene.result); } catch {} }
      const count = scene?.object_count ?? (Array.isArray(scene?.objects) ? scene.objects.length : undefined);
      succeeded = scene !== null && typeof scene === 'object' && !scene.error && Number.isSafeInteger(count) && count >= 0;
      report.scene_object_count = succeeded ? count : null;
      report.scene_response_validated = succeeded;
    }
    report.checks.push({ name: 'live_read_only_tool', tool: values.tool, pass: succeeded, state: receipt.state, error_code: receipt.error_code || null });
    report.response_summary = { block_types: receipt.result?.content?.map((item) => item.type) || [], result_bytes: receipt.result_bytes || 0 };
    if (succeeded) {
      const cached = await bridge.call(request);
      report.checks.push({ name: 'same_operation_returns_cached_result', pass: cached.deduplicated === true && cached.result_sha256 === receipt.result_sha256 });
    }
  }
  const disconnected = await bridge.disconnect({ server_id: 'smoke-local', confirm_mutation: true });
  report.checks.push({ name: 'own_mcp_process_closed', pass: disconnected.disconnected });
  cleanupAllowed = disconnected.disconnected;
  const logs = await fs.readdir(config.processLogDir).catch(() => []);
  report.checks.push({ name: 'no_raw_protocol_process_logs', pass: logs.length === 0 });
  report.pass = report.checks.every((check) => check.pass);
} catch (error) {
  report.error_code = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : String(error.message).match(/^[A-Z][A-Z0-9_]+$/)?.[0] || 'LIVE_MCP_PROBE_FAILED';
} finally {
  await bridge.closeAll();
  cleanupAllowed = cleanupAllowed || bridge.sessions.size === 0 && [...manager.sessions.values()].every((session) => session.closed);
  if (cleanupAllowed) { await fs.rm(temporary, { recursive: true, force: true }); report.temporary_state_removed = true; }
  else { report.temporary_state_removed = false; report.owned_process_cleanup_pending = true; }
  report.pass = report.pass && cleanupAllowed;
  report.working_agent_not_modified = true;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

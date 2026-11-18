#!/usr/bin/env node
import { loadConfig } from './lib/config.mjs';
import { PathPolicy } from './lib/path-policy.mjs';
import { AuditLog } from './lib/audit.mjs';
import { ProcessManager } from './lib/process-manager.mjs';
import { CodexBridge } from './lib/codex-bridge.mjs';
import { buildTools } from './lib/tools.mjs';
import { McpServer } from './lib/mcp-server.mjs';
import { VERSION } from './lib/util.mjs';
import { LocalMcpBridge } from './lib/local-mcp-bridge.mjs';

async function main() {
  const config = await loadConfig();
  const pathPolicy = new PathPolicy(config);
  const audit = new AuditLog(config);
  const processManager = new ProcessManager(config, pathPolicy);
  const codexBridge = new CodexBridge(config, pathPolicy);
  const localMcpBridge = new LocalMcpBridge(config, pathPolicy, processManager);
  const { tools, handlers } = buildTools({ config, pathPolicy, processManager, codexBridge, localMcpBridge });

  if (process.argv.includes('--self-test')) {
    const scriptChecks = await codexBridge.verifyScripts().catch((error) => ({ error: String(error) }));
    process.stdout.write(`${JSON.stringify({ ok: true, name: 'AIHub Remote Agent', version: VERSION, device_id: config.deviceId, setup_required: config.allowedRoots.length === 0, tools: tools.map((tool) => tool.name), codex_scripts: scriptChecks }, null, 2)}\n`);
    return;
  }

  if (!process.argv.includes('--stdio')) {
    process.stderr.write('Use --stdio for MCP or --self-test for local validation.\n');
    process.exitCode = 2;
    return;
  }
  const server = new McpServer({ tools, handlers, audit });
  try { await server.serveStdio(); }
  finally { await localMcpBridge.closeAll(); }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

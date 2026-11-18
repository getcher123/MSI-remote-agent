import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isWslEnabled, isCodexEnabled, validateConfig } from '../server/lib/config.mjs';
import { PathPolicy } from '../server/lib/path-policy.mjs';
import { ProcessManager } from '../server/lib/process-manager.mjs';
import { CodexBridge } from '../server/lib/codex-bridge.mjs';
import { LocalMcpBridge } from '../server/lib/local-mcp-bridge.mjs';
import { LocalMcpClient } from '../server/lib/mcp-client.mjs';
import { buildTools } from '../server/lib/tools.mjs';
import { sha256Text } from '../server/lib/util.mjs';

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configureScript = path.join(repo, 'scripts', 'configure.mjs');
const serverScript = path.join(repo, 'server', 'index.mjs');
const template = JSON.parse(await fs.readFile(path.join(repo, 'config', 'default-config.json'), 'utf8'));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-portable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const appData = path.join(root, 'private-data');
  const configPath = path.join(appData, 'AIHubRemoteAgent', 'config.json');
  await fs.mkdir(workspace);
  const env = { ...process.env, LOCALAPPDATA: appData };
  delete env.AIHUB_REMOTE_AGENT_CONFIG;
  delete env.AIHUB_REMOTE_AGENT_STATE;
  const runConfigure = (args = [], extraEnv = {}) => execFileAsync(process.execPath, [configureScript, ...args], { cwd: workspace, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 5000, maxBuffer: 200000 });
  return { root, workspace, appData, configPath, env, runConfigure };
}
async function configuredRuntime(t, { empty = false } = {}) {
  const f = await fixture(t);
  const config = structuredClone(template);
  config.deviceId = 'portable-fixture';
  config.allowedRoots = empty ? [] : [{ path: f.workspace, permissions: ['read', 'write'] }];
  config.__stateDir = path.join(f.appData, 'state');
  config.auditLog = path.join(config.__stateDir, 'audit.jsonl');
  config.receiptFile = path.join(config.__stateDir, 'codex-receipts.json');
  config.processLogDir = path.join(config.__stateDir, 'processes');
  config.commandPolicy.allowedExecutables = [process.execPath];
  const policy = new PathPolicy(config);
  const processes = new ProcessManager(config, policy);
  const codex = new CodexBridge(config, policy);
  const bridge = new LocalMcpBridge(config, policy, processes);
  t.after(async () => {
    await bridge.closeAll();
    for (const session of processes.sessions.values()) if (!session.closed) await processes.terminateInternal(session.id, true, 'test_cleanup', 1000);
  });
  return { ...f, config, policy, processes, codex, bridge };
}

test('first-run configure chooses the actual cwd and creates only private external config', async t => {
  const f = await fixture(t);
  const { stdout } = await f.runConfigure();
  const output = JSON.parse(stdout);
  assert.equal(output.config_path, await fs.realpath(f.configPath));
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(config.allowedRoots, [{ path: await fs.realpath(f.workspace), permissions: ['read', 'write'] }]);
  assert.deepEqual(config.wsl, { enabled: false });
  assert.deepEqual(config.codex, { enabled: false });
  assert.deepEqual(await fs.readdir(f.workspace), []);
  const before = await fs.readFile(f.configPath, 'utf8');
  await assert.rejects(f.runConfigure(['--read-only']), /Configuration already exists/);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
});

test('configure explicit multiple roots and read-only direct file permissions', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'second-workspace');
  await fs.mkdir(other);
  await f.runConfigure(['--root', '.', '--root', other, '--root', '.', '--read-only']);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(config.allowedRoots, [
    { path: await fs.realpath(f.workspace), permissions: ['read'] },
    { path: await fs.realpath(other), permissions: ['read'] },
  ]);
  await assert.rejects(new PathPolicy(config).authorize(path.join(f.workspace, 'new.txt'), 'write', { targetMayNotExist: true }), /Permission write denied/);
});

test('configure rejects repository config destinations and filesystem-wide roots', async t => {
  const f = await fixture(t);
  const forbidden = path.join(repo, `private-config-${path.basename(f.root)}.json`);
  await assert.rejects(f.runConfigure([], { AIHUB_REMOTE_AGENT_CONFIG: forbidden }), /outside this repository/);
  await assert.rejects(fs.stat(forbidden), { code: 'ENOENT' });
  const checkout = path.join(f.root, 'other-repository');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await assert.rejects(f.runConfigure([], { AIHUB_REMOTE_AGENT_CONFIG: path.join(checkout, 'config.json') }), /inside a Git checkout/);
  await assert.rejects(f.runConfigure(['--root', path.parse(f.workspace).root]), /filesystem root is too broad/);
  await assert.rejects(fs.stat(f.configPath), { code: 'ENOENT' });
});

test('WSL configure flags are paired and do not add implicit filesystem roots', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runConfigure(['--wsl-user', 'fixtureuser']), /must be supplied together/);
  await f.runConfigure(['--wsl-distro', 'FixtureDistribution', '--wsl-user', 'fixtureuser']);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.deepEqual(config.wsl, { enabled: true, distro: 'FixtureDistribution', user: 'fixtureuser' });
  assert.equal(config.allowedRoots.length, 1);
  assert.equal(config.allowedRoots[0].path, await fs.realpath(f.workspace));
  assert.equal(config.codex.enabled, false);
});

test('unconfigured bundled defaults report healthy optional-disabled status and deny file/process work', async t => {
  const f = await fixture(t);
  const { stdout } = await execFileAsync(process.execPath, [serverScript, '--self-test'], { env: f.env, encoding: 'utf8', timeout: 5000 });
  const selfTest = JSON.parse(stdout);
  assert.equal(selfTest.ok, true);
  assert.equal(selfTest.codex_scripts.status, 'disabled');
  const client = new LocalMcpClient({ transport: 'stdio', command: process.execPath, args: [serverScript, '--stdio'], env: f.env, timeoutMs: 3000 });
  t.after(() => client.close());
  await client.connect();
  const status = await client.callTool('device_status', {});
  assert.equal(status.structuredContent.setup_required, true);
  assert.deepEqual(status.structuredContent.integrations, { wsl_enabled: false, codex_enabled: false });
  const deniedFile = await client.callTool('read_file', { path: configureScript });
  assert.equal(deniedFile.isError, true);
  const deniedProcess = await client.callTool('start_process', { runtime: 'native', executable: process.execPath, args: ['-e', 'process.stdout.write("must-not-run")'] });
  assert.equal(deniedProcess.isError, true);
  assert.match(deniedProcess.structuredContent.error, /WORKSPACE_NOT_CONFIGURED/);
});

test('explicit missing config fails instead of silently using unrelated defaults', async t => {
  const f = await fixture(t);
  await assert.rejects(execFileAsync(process.execPath, [serverScript, '--self-test'], { env: { ...f.env, AIHUB_REMOTE_AGENT_CONFIG: f.configPath }, encoding: 'utf8', timeout: 5000 }), /does not exist/);
});

test('native file/process core works with WSL and Codex entirely absent', async t => {
  const f = await configuredRuntime(t);
  delete f.config.wsl;
  delete f.config.codex;
  const policy = new PathPolicy(f.config);
  const processes = new ProcessManager(f.config, policy);
  const codex = new CodexBridge(f.config, policy);
  assert.equal((await codex.doctor()).status, 'disabled');
  const started = await processes.start({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] });
  const until = Date.now() + 3000;
  while (!processes.get(started.session_id).closed) {
    assert.ok(Date.now() < until, 'Native process must finish');
    await delay(10);
  }
  assert.equal(processes.output(started.session_id).stdout, await fs.realpath(f.workspace));
  assert.equal(processes.output(started.session_id).exit_code, 0);
  await assert.rejects(processes.start({ runtime: 'wsl', executable: process.execPath, cwd: f.workspace }), /WSL_DISABLED/);
  await assert.rejects(codex.discover(), { code: 'CODEX_DISABLED' });
});

test('native MCP discovery/registration/stdio use work without any WSL settings', async t => {
  const f = await configuredRuntime(t);
  delete f.config.wsl;
  const source = path.join(f.workspace, 'mcp.json');
  const counter = path.join(f.workspace, 'counter.txt');
  await fs.writeFile(source, JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath,
    args: [path.join(repo, 'tests', 'fixtures', 'bridge-fixture.mjs')],
    env: { BRIDGE_COUNTER_FILE: counter },
  } } }));
  assert.deepEqual((await f.bridge.discover()).sources, []);
  const found = await f.bridge.discover({ paths: [source] });
  assert.equal(found.servers.length, 1);
  await f.bridge.register({ server_id: 'native-fixture', source_path: source, source_name: 'fixture', runtime: 'native', confirm_mutation: true });
  const tools = await f.bridge.tools({ server_id: 'native-fixture' });
  assert.ok(tools.tools.some(tool => tool.name === 'increment'));
  let receipt = await f.bridge.call({ server_id: 'native-fixture', tool_name: 'increment', arguments: {}, operation_id: 'native-portability-0001', confirm_mutation: true, wait_ms: 1000 });
  const until = Date.now() + 3000;
  while (['prepared', 'in_flight'].includes(receipt.state)) {
    assert.ok(Date.now() < until);
    await delay(10); receipt = await f.bridge.operation({ operation_id: receipt.operation_id });
  }
  assert.equal(receipt.state, 'completed');
  assert.equal(await fs.readFile(counter, 'utf8'), '1');
  assert.equal((await f.bridge.disconnect({ server_id: 'native-fixture', confirm_mutation: true })).disconnected, true);
});

test('legacy integration flags remain compatible and explicit disabled flags take precedence', () => {
  const config = structuredClone(template);
  config.wsl = { distro: 'FixtureDistribution', user: 'fixtureuser' };
  config.codex = { adapterPath: '/opt/fixture/adapter.py', uiSenderPath: '/opt/fixture/sender.py' };
  assert.equal(isWslEnabled(config), true);
  assert.equal(isCodexEnabled(config), true);
  assert.doesNotThrow(() => validateConfig(config));
  config.codex.enabled = true;
  assert.throws(() => validateConfig(config), /pinned/);
  config.codex.adapterSha256 = 'a'.repeat(64);
  config.codex.uiSenderSha256 = 'b'.repeat(64);
  assert.doesNotThrow(() => validateConfig(config));
  config.codex.enabled = false;
  config.wsl.enabled = false;
  assert.equal(isWslEnabled(config), false);
  assert.equal(isCodexEnabled(config), false);
  assert.doesNotThrow(() => validateConfig(config));
});

test('write_file requires the expected current SHA when replacing an existing file', async t => {
  const f = await configuredRuntime(t);
  const { handlers } = buildTools({ config: f.config, pathPolicy: f.policy, processManager: f.processes, codexBridge: f.codex });
  const write = handlers.get('write_file').handler;
  const file = path.join(f.workspace, 'document.txt');
  await write({ path: file, content: 'first', confirm_mutation: true });
  await assert.rejects(write({ path: file, content: 'second', confirm_mutation: true }), /expected_sha256 is required/);
  assert.equal(await fs.readFile(file, 'utf8'), 'first');
  await assert.rejects(write({ path: file, content: 'second', expected_sha256: '0'.repeat(64), confirm_mutation: true }), /SHA mismatch/);
  await write({ path: file, content: 'second', expected_sha256: sha256Text('first'), confirm_mutation: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'second');
  await assert.rejects(write({ path: file, content: 'third', create_only: true, confirm_mutation: true }), /Target already exists/);
});

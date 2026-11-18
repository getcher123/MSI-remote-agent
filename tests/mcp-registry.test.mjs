import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalMcpRegistry } from '../server/lib/mcp-registry.mjs';
import { PathPolicy } from '../server/lib/path-policy.mjs';

async function fixture(t, content, suffix = 'toml') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, `source.${suffix}`);
  await fs.writeFile(source, typeof content === 'string' ? content : JSON.stringify(content));
  const config = {
    __stateDir: path.join(dir, 'state'),
    wsl: { user: 'registry-fixture-user', distro: 'fixture' },
    allowedRoots: [{ path: dir, permissions: ['read', 'write'] }],
    deniedPathFragments: [], localMcp: { sources: [{ path: source, runtime: 'windows' }] },
  };
  const registry = new LocalMcpRegistry(config, new PathPolicy(config));
  return { dir, source, config, registry, register: (extra = {}) => registry.register({ server_id: 'blender', source_path: source, source_name: 'blender', confirm_mutation: true, ...extra }) };
}

test('Codex multiline arguments, comments, quoted keys and nested env parse without disclosure', async t => {
  const secret = 'registry-fixture-not-a-real-token';
  const f = await fixture(t, `
model = "codex"
date = 2024-01-01T10:00:00Z
developer_instructions = '''
[mcp_servers.fake]
command = 'must-not-appear'
'''
[mcp_servers."blender"]
command = '/mnt/c/Users/FixtureUser/AppData/Local/BlenderMCP/venv/Scripts/python.exe'
args = [
  "C:/Users/FixtureUser/AppData/Local/BlenderMCP/launch_mcp.py", # annotation
  "Русский текст # literal",
]
startup_timeout_sec = 30.0
tool_timeout_sec = 180.0
enabled_tools = ["get_scene_info"]
disabled_tools = ["execute_code"]
[mcp_servers.blender.env]
BLENDER_HOST = '127.0.0.1'
API_TOKEN = '${secret}'
`);
  const discovery = await f.registry.discover();
  assert.deepEqual(discovery.servers.map(x => x.source_name), ['blender']);
  assert.equal(discovery.servers[0].environment_configured, true);
  assert.ok(!JSON.stringify(discovery).includes(secret));
  assert.ok(!JSON.stringify(discovery).includes('launch_mcp.py'));
  const registered = await f.register({ runtime: 'windows' });
  assert.equal(registered.runtime, 'windows');
  const { definition } = await f.registry.resolve('blender');
  assert.equal(definition.args[1], 'Русский текст # literal');
  assert.equal(definition.env.API_TOKEN, secret);
  assert.equal(definition.timeoutMs, 180000);
  assert.equal(definition.startupTimeoutMs, 30000);
  assert.deepEqual(definition.enabledTools, ['get_scene_info']);
  assert.deepEqual(definition.disabledTools, ['execute_code']);
  const onDisk = await fs.readFile(f.registry.file, 'utf8');
  assert.ok(!onDisk.includes(secret));
  assert.ok(!onDisk.includes('launch_mcp.py'));
  assert.ok(!JSON.stringify(await f.registry.list()).includes(secret));
});

test('JSON VSCode servers support Streamable HTTP environment credentials without disclosure', async t => {
  const secret = 'http-fixture-not-a-real-secret';
  const f = await fixture(t, { servers: { blender: {
    type: 'http', url: `http://127.0.0.1:8989/mcp?key=${secret}`,
    http_headers: { 'X-Test-Token': secret }, env_http_headers: { Authorization: 'LOCAL_AUTHORIZATION' },
    bearer_token_env_var: 'LOCAL_TOKEN',
  } } }, 'json');
  const result = await f.registry.discover();
  assert.equal(result.servers[0].transport, 'streamable-http');
  assert.equal(result.servers[0].endpoint_scope, 'loopback');
  assert.equal(result.servers[0].authentication_configured, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  await f.register();
  const resolved = await f.registry.resolve('blender');
  assert.equal(resolved.definition.headers['X-Test-Token'], secret);
  assert.equal(resolved.definition.headerEnv.Authorization, 'LOCAL_AUTHORIZATION');
  assert.equal(resolved.definition.bearerTokenEnvVar, 'LOCAL_TOKEN');
  assert.ok(!JSON.stringify(await f.registry.list()).includes(secret));
});

test('registration requires confirmation and disabled server cannot be registered', async t => {
  const f = await fixture(t, { mcpServers: { blender: { command: 'node', args: [], disabled: true } } }, 'json');
  assert.equal((await f.registry.discover()).servers[0].enabled, false);
  await assert.rejects(f.register({ confirm_mutation: false }), { code: 'MCP_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.register(), { code: 'MCP_SERVER_DISABLED' });
});

test('registration is idempotent, survives reload and rejects changed source until explicit registration', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand = "node"\nargs = ["one.mjs"]\n');
  const first = await f.register();
  const again = await f.register();
  assert.equal(first.unchanged, false);
  assert.equal(again.unchanged, true);
  const reload = new LocalMcpRegistry(f.config, new PathPolicy(f.config));
  assert.equal((await reload.resolve('blender')).definition.args[0], 'one.mjs');
  await fs.writeFile(f.source, '[mcp_servers.blender]\ncommand = "node"\nargs = ["two.mjs"]\n');
  await assert.rejects(reload.resolve('blender'), { code: 'MCP_SOURCE_CHANGED' });
  assert.equal((await f.register()).unchanged, false);
  assert.equal((await reload.resolve('blender')).definition.args[0], 'two.mjs');
});

test('changes to another server do not invalidate the explicitly selected definition', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand="node"\n[mcp_servers.other]\ncommand="node"\n');
  await f.register();
  await fs.appendFile(f.source, 'args=["other-change"]\n');
  assert.equal((await f.registry.resolve('blender')).definition.command, 'node');
});

test('dotted keys and inline env are supported and relative cwd resolves deterministically', async t => {
  const f = await fixture(t, `mcp_servers.blender.command = "node"
mcp_servers.blender.args = ["file.mjs", ""]
mcp_servers.blender.env = { ACTIVE = "yes", COUNT = "2" }
mcp_servers.blender.cwd = "child"
`);
  await f.register();
  const { definition } = await f.registry.resolve('blender');
  assert.equal(definition.env.COUNT, '2');
  assert.equal(definition.cwd, path.join(f.dir, 'child'));
});

test('duplicate TOML keys and unsupported MCP values fail closed', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand="node"\ncommand="python"\n');
  await assert.rejects(f.register(), { code: 'MCP_TOML_INVALID' });
  await fs.writeFile(f.source, '[mcp_servers.blender]\ncommand="node"\nargs=2024-01-01\n');
  await assert.rejects(f.register(), { code: 'MCP_TOML_UNSUPPORTED' });
  await fs.writeFile(f.source, '[mcp_servers.blender]\ncommand="""node"""\n');
  await assert.rejects(f.register(), { code: 'MCP_TOML_UNSUPPORTED' });
});

test('unrecognized JSON schemas, legacy SSE and host-specific placeholders have clear errors', async t => {
  const f = await fixture(t, { wrong: {} }, 'json');
  await assert.rejects(f.register(), { code: 'MCP_JSON_SCHEMA_UNSUPPORTED' });
  await fs.writeFile(f.source, JSON.stringify({ mcpServers: { blender: { type: 'sse', url: 'http://127.0.0.1/sse' } } }));
  await assert.rejects(f.register(), { code: 'MCP_TRANSPORT_UNSUPPORTED' });
  await fs.writeFile(f.source, JSON.stringify({ mcpServers: { blender: { command: 'node', args: ['${workspaceFolder}/server.mjs'] } } }));
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_PLACEHOLDER_UNSUPPORTED' });
});

test('malformed JSON and malicious object keys never pollute prototypes or expose values', async t => {
  const f = await fixture(t, '{"mcpServers":{"__proto__":{"polluted":true}}}', 'json');
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_INVALID' });
  assert.equal({}.polluted, undefined);
  await fs.writeFile(f.source, '{"mcpServers": bad-private-source');
  const discovered = await f.registry.discover();
  assert.ok(!JSON.stringify(discovered).includes('bad-private-source'));
  assert.ok(discovered.warnings.some(x => x.code === 'MCP_JSON_INVALID'));
});

test('source access respects PathPolicy and source byte bound', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand="node"');
  await assert.rejects(f.register({ source_path: path.join(f.dir, '..', 'outside.toml') }), /outside configured roots/);
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-registry-outside-'));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(outsideDir, 'outside.toml'), '[mcp_servers.blender]\ncommand="node"');
  await fs.symlink(outsideDir, path.join(f.dir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.register({ source_path: path.join(f.dir, 'outside', 'outside.toml') }), /escapes configured root/);
  await fs.writeFile(f.source, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(f.register(), { code: 'MCP_SOURCE_TOO_LARGE' });
});

test('registry corruption, duplicate IDs and active lock fail closed', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand="node"');
  await f.register();
  const data = JSON.parse(await fs.readFile(f.registry.file, 'utf8'));
  await fs.writeFile(`${f.registry.file}.lock`, 'test');
  await assert.rejects(f.register(), { code: 'MCP_REGISTRY_LOCKED' });
  await fs.unlink(`${f.registry.file}.lock`);
  data.servers.push({ ...data.servers[0] });
  await fs.writeFile(f.registry.file, JSON.stringify(data));
  await assert.rejects(f.registry.list(), { code: 'MCP_REGISTRY_CORRUPT' });
  await fs.writeFile(f.registry.file, '{broken');
  await assert.rejects(f.registry.resolve('blender'), { code: 'MCP_REGISTRY_CORRUPT' });
  data.servers.pop();
  data.servers[0].metadata.authentication_configured = 'must-not-be-disclosed';
  await fs.writeFile(f.registry.file, JSON.stringify(data));
  await assert.rejects(f.registry.list(), { code: 'MCP_REGISTRY_CORRUPT' });
});

test('concurrent registrations preserve every entry and unregister is explicit/idempotent', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand="node"');
  await Promise.all(['blender', 'blender-2', 'blender-3'].map(id => f.register({ server_id: id })));
  assert.equal((await f.registry.list()).servers.length, 3);
  await assert.rejects(f.registry.unregister({ server_id: 'blender' }), { code: 'MCP_CONFIRMATION_REQUIRED' });
  assert.equal((await f.registry.unregister({ server_id: 'blender', confirm_mutation: true })).removed, true);
  assert.equal((await f.registry.unregister({ server_id: 'blender', confirm_mutation: true })).removed, false);
  await assert.rejects(f.registry.resolve('blender'), { code: 'MCP_SERVER_UNREGISTERED' });
});

test('sensitive tunnel variables and WSLENV are denied case-insensitively', async t => {
  const f = await fixture(t, { mcpServers: { blender: { command: 'node', env: { control_plane_api_key: 'not-real' } } } }, 'json');
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_INVALID' });
  await fs.writeFile(f.source, JSON.stringify({ mcpServers: { blender: { command: 'node', env_vars: ['WsLeNv'] } } }));
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_INVALID' });
});

test('HTTP URL credentials, forged protocol headers and invalid timeout types are denied', async t => {
  const f = await fixture(t, { mcpServers: { blender: { url: 'http://user:private@127.0.0.1/mcp' } } }, 'json');
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_INVALID' });
  await fs.writeFile(f.source, JSON.stringify({ mcpServers: { blender: { url: 'http://127.0.0.1/mcp', headers: { 'Mcp-Session-Id': 'private' } } } }));
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_INVALID' });
  await fs.writeFile(f.source, JSON.stringify({ mcpServers: { blender: { command: 'node', tool_timeout_sec: '30' } } }));
  await assert.rejects(f.register(), { code: 'MCP_CONFIG_INVALID' });
});

test('registration rejects invalid identifiers and oversized source lists', async t => {
  const f = await fixture(t, '[mcp_servers.blender]\ncommand="node"');
  await assert.rejects(f.register({ server_id: '../blender' }), { code: 'MCP_SERVER_ID_INVALID' });
  await assert.rejects(f.registry.discover({ paths: Array(11).fill(f.source) }), { code: 'MCP_CONFIG_INVALID' });
});

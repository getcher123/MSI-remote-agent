import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { VERSION } from '../server/lib/util.mjs';
import { collectReleaseFiles } from './lib/release-files.mjs';
import { scanFiles } from './lib/privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async relative => JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
const plugin = await json('plugin.json'), pkg = await json('package.json');
const manifest = await json('release-manifest.json'), mcp = await json('mcp.json');
if (plugin.name !== pkg.name || plugin.name !== 'aihub-remote-agent' || plugin.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw Error('Invalid plugin manifest');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || [plugin.version, manifest.version, VERSION].some(v => v !== pkg.version)) throw Error('Release versions differ');
const subtitle = plugin.extensions?.['com.openai']?.interface?.shortDescription;
if (!subtitle?.trim() || subtitle.length > 30) throw Error('Invalid shortDescription');
const server = mcp.mcpServers?.['aihub-remote-agent'];
if (mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' || server?.type !== 'stdio' || server.command !== 'node' || server.args?.[0] !== '${PLUGIN_ROOT}/server/index.mjs' || server.args?.[1] !== '--stdio') throw Error('Invalid stdio MCP declaration');
if (manifest.name !== pkg.name || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid release manifest');
const expected = new Map(), lower = new Set();
for (const item of manifest.files) {
  const relative = item.path;
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..') || relative === 'release-manifest.json') throw Error('Unsafe manifest path');
  if (lower.has(relative.toLowerCase())) throw Error(`Duplicate/case-conflicting path: ${relative}`);
  if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error(`Invalid manifest record: ${relative}`);
  lower.add(relative.toLowerCase()); expected.set(relative, item);
}
const required = ['plugin.json', 'package.json', 'mcp.json', 'server/index.mjs', 'config/default-config.json', 'skills/remote-machine/SKILL.md', 'launcher/AIHub-Remote-Agent-Install.cmd', 'README.md', 'AGENTS.md'];
for (const relative of required) if (!expected.has(relative)) throw Error(`Missing manifest entry: ${relative}`);
const files = await collectReleaseFiles(root);
if (files.length !== expected.size || files.some(relative => !expected.has(relative))) throw Error('Manifest inventory differs from public source; run npm run build:manifest after review.');
for (const relative of files) {
  const item = expected.get(relative);
  const data = await fs.readFile(path.join(root, relative));
  if (data.length !== item.bytes || crypto.createHash('sha256').update(data).digest('hex') !== item.sha256) throw Error(`Integrity mismatch: ${relative}`);
  if (relative.endsWith('.json')) JSON.parse(data.toString('utf8'));
}
const findings = await scanFiles(root, files);
for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
if (findings.length) throw Error('Publication privacy check failed');
for (const field of ['logo', 'composerIcon']) {
  const asset = plugin[field];
  if (typeof asset !== 'string' || !asset.startsWith('./') || !expected.has(asset.slice(2))) throw Error(`Invalid plugin asset: ${field}`);
}
console.log(JSON.stringify({ ok: true, plugin: plugin.name, version: pkg.version, manifest_files: files.length, private_state_excluded: true }, null, 2));

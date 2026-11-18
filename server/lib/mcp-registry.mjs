import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, ensureDir, nowIso, sha256Text, stableJson } from './util.mjs';
import { isWslEnabled } from './config.mjs';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SERVERS = 100;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const OWN = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = () => Object.create(null);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function fail(code, message) { throw failure(code, message); }
function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MCP_CONFIG_INVALID', `${label} must be an object`);
  return value;
}
function string(value, label, max = 20000) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) fail('MCP_CONFIG_INVALID', `${label} must be a bounded non-empty string`);
  return value;
}
function safeKey(key) {
  if (typeof key !== 'string' || !key || key.length > 256 || BAD_KEYS.has(key) || /[\x00-\x1f\x7f]/.test(key)) fail('MCP_CONFIG_INVALID', 'Invalid configuration key');
  return key;
}
function safeTree(value, depth = 0) {
  if (depth > 32) fail('MCP_CONFIG_INVALID', 'Configuration nesting limit exceeded');
  if (Array.isArray(value)) {
    if (value.length > 1000) fail('MCP_CONFIG_INVALID', 'Configuration array limit exceeded');
    for (const child of value) safeTree(child, depth + 1);
  } else if (value && typeof value === 'object') {
    if (Object.keys(value).length > 1000) fail('MCP_CONFIG_INVALID', 'Configuration object limit exceeded');
    for (const [key, child] of Object.entries(value)) { safeKey(key); safeTree(child, depth + 1); }
  }
}
function serverId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail('MCP_SERVER_ID_INVALID', 'server_id must be 1..128 ASCII letters, digits, dot, underscore, colon or hyphen');
  return value;
}
function runtimeName(value) {
  if (!['native', 'windows', 'wsl'].includes(value)) fail('MCP_CONFIG_INVALID', 'runtime must be native, windows or wsl');
  return value;
}
function isWindowsPath(value) { return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'); }
function inferRuntime(sourcePath) { return isWindowsPath(sourcePath) ? 'windows' : process.platform === 'win32' ? 'wsl' : 'native'; }
function inferFormat(sourcePath, supplied) {
  if (supplied !== undefined && !['json', 'toml'].includes(supplied)) fail('MCP_CONFIG_INVALID', 'format must be json or toml');
  if (supplied) return supplied;
  if (/\.toml$/i.test(sourcePath)) return 'toml';
  if (/\.json$/i.test(sourcePath)) return 'json';
  fail('MCP_CONFIG_INVALID', 'Source format must be json or toml');
}

// A strict, non-evaluating TOML subset for MCP tables. Unrelated Codex fields
// are skipped, while multiline strings/arrays are still scanned correctly.
// Supported values: basic/literal strings, booleans, finite numbers, arrays,
// inline tables, dotted keys and nested MCP tables. Date/time and multiline
// strings inside relevant MCP values are intentionally rejected.
function tomlStatements(text) {
  const out = [];
  let part = '', quote = null, triple = false, escaped = false, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      part += ch;
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && ch === '\\') { escaped = true; continue; }
      if (ch === quote) {
        if (triple && text.slice(i, i + 3) === quote.repeat(3)) { part += quote.repeat(2); i += 2; quote = null; triple = false; }
        else if (!triple) quote = null;
      }
      continue;
    }
    if (ch === '#' ) {
      while (i < text.length && text[i] !== '\n') i++;
      if (i === text.length) break;
      if (depth === 0) { if (part.trim()) out.push(part.trim()); part = ''; } else part += '\n';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch; triple = text.slice(i, i + 3) === ch.repeat(3);
      part += triple ? ch.repeat(3) : ch;
      if (triple) i += 2;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (depth < 0 || depth > 32) fail('MCP_TOML_INVALID', 'Invalid TOML bracket nesting');
    if (ch === '\n' && depth === 0) { if (part.trim()) out.push(part.trim()); part = ''; }
    else part += ch;
  }
  if (quote || depth !== 0) fail('MCP_TOML_INVALID', 'Unclosed TOML string or collection');
  if (part.trim()) out.push(part.trim());
  return out;
}

class TomlValueParser {
  constructor(text) { this.text = text; this.at = 0; this.depth = 0; }
  ws() { while (/\s/.test(this.text[this.at] || '') && this.at < this.text.length) this.at++; }
  error() { fail('MCP_TOML_UNSUPPORTED', 'Unsupported or invalid syntax in MCP TOML configuration'); }
  quoted() {
    const quote = this.text[this.at++];
    if (this.text.slice(this.at - 1, this.at + 2) === quote.repeat(3)) this.error();
    let result = '';
    while (this.at < this.text.length) {
      const ch = this.text[this.at++];
      if (ch === quote) return result;
      if (ch === '\n' || ch === '\r' || ch.charCodeAt(0) < 0x20 && ch !== '\t') this.error();
      if (quote === '"' && ch === '\\') {
        const escape = this.text[this.at++];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (OWN(simple, escape)) result += simple[escape];
        else if (escape === 'u' || escape === 'U') {
          const length = escape === 'u' ? 4 : 8;
          const hex = this.text.slice(this.at, this.at + length);
          if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) this.error();
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) this.error();
          result += String.fromCodePoint(cp); this.at += length;
        } else this.error();
      } else result += ch;
    }
    this.error();
  }
  keys() {
    const keys = [];
    while (true) {
      this.ws();
      let key;
      if (this.text[this.at] === '"' || this.text[this.at] === "'") key = this.quoted();
      else {
        const m = this.text.slice(this.at).match(/^[A-Za-z0-9_-]+/);
        if (!m) this.error();
        key = m[0]; this.at += key.length;
      }
      keys.push(safeKey(key)); this.ws();
      if (this.text[this.at] !== '.') break;
      this.at++;
    }
    return keys;
  }
  value() {
    this.ws();
    if (++this.depth > 32) this.error();
    const ch = this.text[this.at];
    let result;
    if (ch === '"' || ch === "'") result = this.quoted();
    else if (ch === '[') {
      this.at++; result = []; this.ws();
      while (this.text[this.at] !== ']') {
        if (result.length >= 1000) this.error();
        result.push(this.value()); this.ws();
        if (this.text[this.at] === ']') break;
        if (this.text[this.at++] !== ',') this.error();
        this.ws();
      }
      if (this.text[this.at++] !== ']') this.error();
    } else if (ch === '{') {
      this.at++; result = record(); this.ws();
      while (this.text[this.at] !== '}') {
        const keys = this.keys();
        if (this.text[this.at++] !== '=') this.error();
        assign(result, keys, this.value()); this.ws();
        if (this.text[this.at] === '}') break;
        if (this.text[this.at++] !== ',') this.error();
        this.ws();
        if (this.text[this.at] === '}') this.error();
      }
      if (this.text[this.at++] !== '}') this.error();
    } else {
      const m = this.text.slice(this.at).match(/^[^\s,\]}]+/);
      if (!m) this.error();
      const token = m[0]; this.at += token.length;
      if (token === 'true' || token === 'false') result = token === 'true';
      else if (/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(token)) {
        result = Number(token.replaceAll('_', ''));
        if (!Number.isFinite(result) || Number.isInteger(result) && !Number.isSafeInteger(result)) this.error();
      } else this.error();
    }
    this.depth--; return result;
  }
  end() { this.ws(); if (this.at !== this.text.length) this.error(); }
}
function assign(root, keys, value) {
  let current = root;
  for (const key of keys.slice(0, -1)) {
    safeKey(key);
    if (!OWN(current, key)) current[key] = record();
    requireRecord(current[key], 'TOML table'); current = current[key];
  }
  const last = safeKey(keys.at(-1));
  if (OWN(current, last)) fail('MCP_TOML_INVALID', 'Duplicate MCP TOML key');
  current[last] = value;
}
function parseCodexToml(text) {
  const root = record(), seenTables = new Set();
  let current = [];
  for (const statement of tomlStatements(text)) {
    if (statement.startsWith('[')) {
      const arrayTable = statement.startsWith('[[');
      const brackets = arrayTable ? 2 : 1;
      if (!statement.endsWith(']'.repeat(brackets))) fail('MCP_TOML_INVALID', 'Malformed TOML table');
      const p = new TomlValueParser(statement.slice(brackets, -brackets));
      current = p.keys(); p.end();
      if (current[0] === 'mcp_servers') {
        if (arrayTable) fail('MCP_TOML_UNSUPPORTED', 'MCP array tables are unsupported');
        const key = JSON.stringify(current);
        if (seenTables.has(key)) fail('MCP_TOML_INVALID', 'Duplicate MCP TOML table');
        seenTables.add(key);
        let cursor = root;
        for (const item of current) {
          if (!OWN(cursor, item)) cursor[item] = record();
          requireRecord(cursor[item], 'MCP TOML table'); cursor = cursor[item];
        }
      }
      continue;
    }
    // Parse key syntax first; unrelated values may use arbitrary valid TOML.
    const p = new TomlValueParser(statement);
    const keys = p.keys();
    if (p.text[p.at++] !== '=') fail('MCP_TOML_INVALID', 'Invalid TOML assignment');
    const full = [...current, ...keys];
    if (full[0] !== 'mcp_servers') continue;
    const value = p.value(); p.end(); assign(root, full, value);
  }
  return OWN(root, 'mcp_servers') ? requireRecord(root.mcp_servers, 'mcp_servers') : record();
}

function parseSource(text, format) {
  let servers;
  if (format === 'toml') servers = parseCodexToml(text);
  else {
    let parsed;
    try { parsed = JSON.parse(text); } catch { fail('MCP_JSON_INVALID', 'Source is not valid JSON'); }
    requireRecord(parsed, 'MCP source'); safeTree(parsed);
    const fields = ['mcpServers', 'servers'].filter(key => OWN(parsed, key));
    if (fields.length !== 1) fail('MCP_JSON_SCHEMA_UNSUPPORTED', 'JSON source must contain exactly one mcpServers or servers object');
    servers = requireRecord(parsed[fields[0]], fields[0]);
  }
  safeTree(servers);
  if (Object.keys(servers).length > MAX_SERVERS) fail('MCP_CONFIG_INVALID', 'Too many MCP servers in source');
  return servers;
}

function bool(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail('MCP_CONFIG_INVALID', `${label} must be boolean`);
  return value;
}
function stringArray(value, label, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 1000 || value.some(v => typeof v !== 'string' || v.length > 20000 || v.includes('\0'))) fail('MCP_CONFIG_INVALID', `${label} must be a bounded string array`);
  return [...value];
}
function stringMap(value, label, { variables = false, headers = false } = {}) {
  if (value === undefined) return record();
  requireRecord(value, label);
  const out = record();
  for (const [key, item] of Object.entries(value)) {
    safeKey(key);
    if (typeof item !== 'string' || item.length > 20000 || item.includes('\0')) fail('MCP_CONFIG_INVALID', `${label} must contain bounded string values`);
    if (variables && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail('MCP_CONFIG_INVALID', 'Invalid environment variable name');
    if (variables && ['CONTROL_PLANE_API_KEY', 'WSLENV'].includes(key.toUpperCase())) fail('MCP_CONFIG_INVALID', 'Tunnel credential and ambient WSL forwarding cannot be passed to MCP servers');
    if (headers && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(item))) fail('MCP_CONFIG_INVALID', 'Invalid HTTP header');
    out[key] = item;
  }
  return out;
}
function variableName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || ['CONTROL_PLANE_API_KEY', 'WSLENV'].includes(value.toUpperCase())) fail('MCP_CONFIG_INVALID', 'Invalid environment reference');
  return value;
}
function combineMaps(first, second, label, options) {
  const a = stringMap(first, label, options), b = stringMap(second, label, options);
  for (const [key, value] of Object.entries(b)) {
    if (OWN(a, key) && a[key] !== value) fail('MCP_CONFIG_INVALID', `Conflicting ${label} values`);
    a[key] = value;
  }
  return a;
}
function normalizedCwd(value, runtime, sourcePath) {
  const mod = isWindowsPath(sourcePath) ? path.win32 : path.posix;
  const base = mod.dirname(sourcePath);
  if (value !== undefined) string(value, 'cwd');
  let result = value === undefined ? base : isWindowsPath(value) ? path.win32.normalize(value) : value.startsWith('/') ? path.posix.normalize(value) : mod.resolve(base, value);
  if (runtime === 'wsl' && isWindowsPath(result)) {
    const drive = result.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!drive) fail('MCP_CONFIG_INVALID', 'WSL cwd cannot use an unmapped Windows UNC path');
    result = `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`;
  }
  // Windows bridge converts POSIX/WSL paths through PathPolicy.toHostPath.
  return result;
}
function normalize(raw, source, runtimeOverride) {
  requireRecord(raw, 'MCP server'); safeTree(raw);
  const runtime = runtimeName(runtimeOverride || raw.runtime || source.runtime);
  const type = raw.type ?? raw.transport ?? (raw.command ? 'stdio' : raw.url ? 'streamable-http' : undefined);
  const transport = ['http', 'streamable-http', 'streamableHttp'].includes(type) ? 'streamable-http' : type;
  if (!['stdio', 'streamable-http'].includes(transport)) fail('MCP_TRANSPORT_UNSUPPORTED', 'Only stdio and Streamable HTTP transports are supported; legacy SSE is unsupported');
  const enabled = bool(raw.enabled, 'enabled', true) && !bool(raw.disabled, 'disabled', false);
  const definition = { transport, runtime, enabled };
  if (raw.tool_timeout_sec !== undefined && typeof raw.tool_timeout_sec !== 'number') fail('MCP_CONFIG_INVALID', 'tool_timeout_sec must be numeric');
  const timeout = raw.timeoutMs ?? raw.timeout_ms ?? (raw.tool_timeout_sec === undefined ? 15000 : raw.tool_timeout_sec * 1000);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) fail('MCP_CONFIG_INVALID', 'MCP timeout must be 100..300000ms');
  definition.timeoutMs = timeout;
  if (raw.startup_timeout_sec !== undefined) {
    if (typeof raw.startup_timeout_sec !== 'number') fail('MCP_CONFIG_INVALID', 'startup_timeout_sec must be numeric');
    const startup = raw.startup_timeout_sec * 1000;
    if (!Number.isSafeInteger(startup) || startup < 100 || startup > 300000) fail('MCP_CONFIG_INVALID', 'MCP startup timeout must be 100..300000ms');
    definition.startupTimeoutMs = startup;
  }
  definition.env = stringMap(raw.env, 'env', { variables: true });
  definition.envVars = stringArray(raw.env_vars ?? raw.envVars, 'env_vars').map(variableName);
  definition.enabledTools = raw.enabled_tools === undefined ? null : stringArray(raw.enabled_tools, 'enabled_tools');
  definition.disabledTools = stringArray(raw.disabled_tools, 'disabled_tools');
  if (raw.oauth !== undefined || raw.auth !== undefined) fail('MCP_AUTH_UNSUPPORTED', 'Interactive OAuth configuration is unsupported by the local bridge');
  if (transport === 'stdio') {
    if (raw.url !== undefined) fail('MCP_CONFIG_INVALID', 'stdio server cannot also specify a URL');
    definition.command = string(raw.command, 'command', 32768);
    if (/[\r\n]/.test(definition.command)) fail('MCP_CONFIG_INVALID', 'Command must not contain a newline');
    definition.args = stringArray(raw.args, 'args');
    definition.cwd = normalizedCwd(raw.cwd, runtime, source.path);
  } else {
    if (raw.command !== undefined) fail('MCP_CONFIG_INVALID', 'HTTP server cannot also specify a command');
    definition.url = string(raw.url, 'url', 8192);
    let url;
    try { url = new URL(definition.url); } catch { fail('MCP_CONFIG_INVALID', 'Invalid MCP endpoint URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('MCP_CONFIG_INVALID', 'MCP endpoint must be HTTP(S) without userinfo or fragment');
    definition.headers = combineMaps(raw.headers, raw.http_headers, 'headers', { headers: true });
    definition.headerEnv = combineMaps(raw.headerEnv, raw.env_http_headers, 'header environment references', { headers: true });
    for (const value of Object.values(definition.headerEnv)) variableName(value);
    for (const key of [...Object.keys(definition.headers), ...Object.keys(definition.headerEnv)]) {
      if (/^(host|content-length|content-type|accept|transfer-encoding|connection|mcp-session-id|mcp-protocol-version|mcp-method|mcp-name)$/i.test(key)) fail('MCP_CONFIG_INVALID', 'Protocol-managed HTTP header cannot be overridden');
    }
    if (raw.bearer_token_env_var !== undefined) definition.bearerTokenEnvVar = variableName(raw.bearer_token_env_var);
  }
  // VS Code placeholders need its host/input state; treating them as literal
  // commands or credentials would create a misleading, broken connection.
  if (/\$\{(?:input:|env:|workspaceFolder\b|userHome\b|config:)/.test(stableJson(definition))) fail('MCP_CONFIG_PLACEHOLDER_UNSUPPORTED', 'Host-specific configuration placeholders are unsupported; use concrete local paths or environment references');
  return definition;
}
function metadata(source, sourceName, definition) {
  const value = {
    source_path: source.path, source_name: sourceName, format: source.format,
    transport: definition.transport, runtime: definition.runtime, enabled: definition.enabled,
    configured: true, command_configured: Boolean(definition.command), endpoint_configured: Boolean(definition.url),
    environment_configured: Object.keys(definition.env || {}).length > 0 || (definition.envVars || []).length > 0,
    authentication_configured: Object.keys(definition.headers || {}).length > 0 || Object.keys(definition.headerEnv || {}).length > 0 || Boolean(definition.bearerTokenEnvVar),
  };
  if (definition.url) {
    const hostname = new URL(definition.url).hostname;
    value.endpoint_scope = ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? 'loopback' : 'network';
  }
  return value;
}

export class LocalMcpRegistry {
  constructor(config, pathPolicy) {
    this.config = config; this.pathPolicy = pathPolicy;
    if (!config.__stateDir) fail('MCP_CONFIG_INVALID', 'Registry requires config.__stateDir');
    this.file = path.join(config.__stateDir, 'local-mcp-registry.json');
    this.queue = Promise.resolve();
  }
  sourceDescriptor(input) {
    const value = typeof input === 'string' ? { path: input } : requireRecord(input, 'source');
    const sourcePath = string(value.path, 'source path', 32768);
    if (!sourcePath.startsWith('/') && !isWindowsPath(sourcePath)) fail('MCP_CONFIG_INVALID', 'Source path must be absolute');
    return { path: sourcePath, runtime: runtimeName(value.runtime || inferRuntime(sourcePath)), format: inferFormat(sourcePath, value.format) };
  }
  configuredSources() {
    const extras = this.config.localMcp?.sources || [];
    if (!Array.isArray(extras) || extras.length > 16) fail('MCP_CONFIG_INVALID', 'localMcp.sources must contain at most 16 sources');
    const sources = [];
    // Preserve the historical WSL Codex source only for configured WSL users.
    // Native installations discover explicit files/sources, never another user's home.
    if (isWslEnabled(this.config)) {
      const user = this.config.wsl.user;
      if (typeof user !== 'string' || !/^[A-Za-z0-9_-]+$/.test(user)) fail('MCP_CONFIG_INVALID', 'Invalid WSL user for default source');
      sources.push({ path: `/home/${user}/.codex/config.toml`, runtime: 'wsl', format: 'toml' });
    }
    return [...sources, ...extras.map(item => this.sourceDescriptor(item))];
  }
  descriptorFor(sourcePath, runtime) {
    const existing = this.configuredSources().find(source => source.path === sourcePath);
    return this.sourceDescriptor({ ...(existing || { path: sourcePath }), ...(runtime ? { runtime } : {}) });
  }
  async readSource(source) {
    const auth = await this.pathPolicy.authorize(source.path, 'read');
    const handle = await fs.open(auth.realPath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) fail('MCP_SOURCE_TOO_LARGE', 'MCP source must be a regular file of at most 1MiB');
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
        total += bytesRead; if (bytesRead === 0) break;
      }
      if (total > MAX_SOURCE_BYTES) fail('MCP_SOURCE_TOO_LARGE', 'MCP source exceeds 1MiB');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)); }
      catch { fail('MCP_CONFIG_INVALID', 'MCP source must contain valid UTF-8'); }
      return parseSource(text.replace(/^\uFEFF/, ''), source.format);
    } finally { await handle.close(); }
  }
  async discover({ paths = [] } = {}) {
    if (!Array.isArray(paths) || paths.length > 10) fail('MCP_CONFIG_INVALID', 'paths must contain at most 10 sources');
    const sources = [...this.configuredSources(), ...paths.map(item => this.sourceDescriptor(item))];
    const result = { sources: [], servers: [], warnings: [] }, seen = new Set();
    for (const source of sources) {
      if (seen.has(source.path)) continue;
      seen.add(source.path);
      const entry = { source_path: source.path, runtime: source.runtime, format: source.format, status: 'ok', servers: [], warnings: [] };
      try {
        const servers = await this.readSource(source);
        for (const [name, raw] of Object.entries(servers)) {
          try {
            const definition = normalize(raw, source);
            const server = metadata(source, name, definition);
            entry.servers.push(server); result.servers.push(server);
          } catch (error) {
            const warning = { source_path: source.path, source_name: name, code: safeErrorCode(error) };
            entry.warnings.push(warning); result.warnings.push(warning);
          }
        }
      } catch (error) {
        entry.status = 'unavailable';
        const warning = { source_path: source.path, code: safeErrorCode(error) };
        entry.warnings.push(warning); result.warnings.push(warning);
      }
      result.sources.push(entry);
    }
    return result;
  }
  async readRegistry() {
    let text;
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) fail('MCP_REGISTRY_CORRUPT', 'MCP registry size or file type is invalid');
      text = await fs.readFile(this.file, 'utf8');
      if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) fail('MCP_REGISTRY_CORRUPT', 'MCP registry size limit exceeded');
    }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, servers: [] }; throw error; }
    let registry;
    try { registry = JSON.parse(text); } catch { fail('MCP_REGISTRY_CORRUPT', 'MCP registry is not valid JSON'); }
    if (registry?.version !== 1 || !Array.isArray(registry.servers) || registry.servers.length > MAX_SERVERS) fail('MCP_REGISTRY_CORRUPT', 'MCP registry schema is invalid');
    const ids = new Set();
    for (const entry of registry.servers) {
      try {
        serverId(entry.server_id); string(entry.source_path, 'source path'); safeKey(entry.source_name); runtimeName(entry.runtime); inferFormat(entry.source_path, entry.format);
        if (!/^[a-f0-9]{64}$/.test(entry.fingerprint) || ids.has(entry.server_id)) throw Error();
        requireRecord(entry.metadata, 'registry metadata'); safeTree(entry.metadata);
        if (!['stdio', 'streamable-http'].includes(entry.metadata.transport)) throw Error();
        for (const key of ['enabled', 'configured', 'command_configured', 'endpoint_configured', 'environment_configured', 'authentication_configured']) if (typeof entry.metadata[key] !== 'boolean') throw Error();
        if (entry.metadata.endpoint_scope !== undefined && !['loopback', 'network'].includes(entry.metadata.endpoint_scope)) throw Error();
        for (const key of ['registered_at', 'updated_at']) if (typeof entry[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry[key])) throw Error();
      } catch { fail('MCP_REGISTRY_CORRUPT', 'MCP registry entry is invalid'); }
      ids.add(entry.server_id);
    }
    return registry;
  }
  async list() {
    const registry = await this.readRegistry();
    return { servers: registry.servers.map(entry => this.publicEntry(entry)) };
  }
  publicEntry(entry) {
    // Explicit output allowlist also protects against a manually corrupted
    // registry metadata object accidentally publishing private fields.
    const out = { server_id: entry.server_id, source_path: entry.source_path, source_name: entry.source_name, format: entry.format, runtime: entry.runtime, registered: true, registered_at: entry.registered_at, updated_at: entry.updated_at };
    for (const key of ['transport', 'enabled', 'configured', 'command_configured', 'endpoint_configured', 'environment_configured', 'authentication_configured', 'endpoint_scope']) if (OWN(entry.metadata, key)) out[key] = entry.metadata[key];
    return out;
  }
  async locked(work) {
    const next = this.queue.catch(() => {}).then(async () => {
      await ensureDir(path.dirname(this.file));
      let lock;
      try { lock = await fs.open(`${this.file}.lock`, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('MCP_REGISTRY_LOCKED', 'MCP registry is locked; do not delete an active lock'); throw error; }
      try { return await work(); }
      finally { await lock.close(); await fs.unlink(`${this.file}.lock`); }
    });
    this.queue = next; return next;
  }
  async register({ server_id, source_path, source_name, runtime, confirm_mutation } = {}) {
    if (confirm_mutation !== true) fail('MCP_CONFIRMATION_REQUIRED', 'confirm_mutation=true is required');
    serverId(server_id); string(source_path, 'source path'); safeKey(source_name);
    const source = this.descriptorFor(source_path, runtime);
    const servers = await this.readSource(source);
    if (!OWN(servers, source_name)) fail('MCP_SERVER_NOT_FOUND', 'Selected server is absent from source');
    const definition = normalize(servers[source_name], source, runtime);
    if (!definition.enabled) fail('MCP_SERVER_DISABLED', 'Selected MCP server is disabled in its source');
    const fingerprint = sha256Text(stableJson(definition));
    return this.locked(async () => {
      const registry = await this.readRegistry();
      const previous = registry.servers.find(entry => entry.server_id === server_id);
      if (previous && previous.source_path === source.path && previous.source_name === source_name && previous.fingerprint === fingerprint) return { ...this.publicEntry(previous), unchanged: true };
      if (!previous && registry.servers.length >= MAX_SERVERS) fail('MCP_CONFIG_INVALID', 'Registry server limit reached');
      const at = nowIso();
      const entry = { server_id, source_path: source.path, source_name, format: source.format, runtime: definition.runtime, fingerprint, metadata: metadata(source, source_name, definition), registered_at: previous?.registered_at || at, updated_at: at };
      registry.servers = [...registry.servers.filter(item => item.server_id !== server_id), entry];
      await atomicWrite(this.file, `${JSON.stringify(registry, null, 2)}\n`);
      return { ...this.publicEntry(entry), unchanged: false };
    });
  }
  async resolve(id) {
    serverId(id);
    const registry = await this.readRegistry();
    const entry = registry.servers.find(item => item.server_id === id);
    if (!entry) fail('MCP_SERVER_UNREGISTERED', 'MCP server is not registered');
    const source = { path: entry.source_path, runtime: entry.runtime, format: entry.format };
    const servers = await this.readSource(source);
    if (!OWN(servers, entry.source_name)) fail('MCP_SOURCE_CHANGED', 'Registered MCP definition is no longer present; register it again explicitly');
    const definition = normalize(servers[entry.source_name], source, entry.runtime);
    if (!definition.enabled) fail('MCP_SERVER_DISABLED', 'Registered MCP server is disabled in its source');
    if (sha256Text(stableJson(definition)) !== entry.fingerprint) fail('MCP_SOURCE_CHANGED', 'Registered MCP definition changed; register it again explicitly');
    return { server_id: id, source_path: entry.source_path, source_name: entry.source_name, fingerprint: entry.fingerprint, definition };
  }
  async unregister({ server_id, confirm_mutation } = {}) {
    if (confirm_mutation !== true) fail('MCP_CONFIRMATION_REQUIRED', 'confirm_mutation=true is required');
    serverId(server_id);
    return this.locked(async () => {
      const registry = await this.readRegistry();
      const remaining = registry.servers.filter(entry => entry.server_id !== server_id);
      if (remaining.length === registry.servers.length) return { server_id, removed: false };
      registry.servers = remaining;
      await atomicWrite(this.file, `${JSON.stringify(registry, null, 2)}\n`);
      return { server_id, removed: true };
    });
  }
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^(MCP_[A-Z_]+|E[A-Z]+)$/.test(error.code) ? error.code : 'MCP_SOURCE_UNAVAILABLE';
}

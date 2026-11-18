import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, pathExists } from './util.mjs';

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultDataRoot() {
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, 'AIHubRemoteAgent');
  return path.join(os.homedir(), '.aihub-remote-agent');
}

export function defaultConfigPath() {
  return process.env.AIHUB_REMOTE_AGENT_CONFIG || path.join(defaultDataRoot(), 'config.json');
}

export function defaultStateDir() {
  return process.env.AIHUB_REMOTE_AGENT_STATE || path.join(defaultDataRoot(), 'state');
}

// Missing flags preserve existing installations whose integration settings
// predate optional integrations. A false flag always wins over retained fields.
export function isWslEnabled(config) {
  const wsl = config?.wsl;
  if (!wsl || wsl.enabled === false) return false;
  return wsl.enabled === true || Boolean(wsl.distro || wsl.user);
}

export function isCodexEnabled(config) {
  const codex = config?.codex;
  if (!codex || codex.enabled === false) return false;
  return codex.enabled === true || Boolean(codex.adapterPath || codex.uiSenderPath);
}

export async function loadConfig() {
  const explicit = defaultConfigPath();
  let source = explicit;
  if (!(await pathExists(source))) {
    if (process.env.AIHUB_REMOTE_AGENT_CONFIG) throw new Error('Configured AIHUB_REMOTE_AGENT_CONFIG does not exist; run npm run configure to create it');
    source = path.join(packageRoot(), 'config', 'default-config.json');
  }
  const parsed = JSON.parse(await fs.readFile(source, 'utf8'));
  const stateDir = parsed.stateDir || defaultStateDir();
  parsed.__source = source;
  parsed.__stateDir = stateDir;
  parsed.__configured = Array.isArray(parsed.allowedRoots) && parsed.allowedRoots.length > 0;
  parsed.auditLog = parsed.auditLog || path.join(stateDir, 'audit.jsonl');
  parsed.receiptFile = parsed.receiptFile || path.join(stateDir, 'codex-receipts.json');
  parsed.processLogDir = parsed.processLogDir || path.join(stateDir, 'processes');
  validateConfig(parsed);
  await ensureDir(stateDir);
  await ensureDir(parsed.processLogDir);
  return parsed;
}

export function validateConfig(config) {
  if (!config.deviceId || typeof config.deviceId !== 'string' || config.deviceId.length > 128) throw new Error('config.deviceId is required and must be at most 128 characters');
  if (!Array.isArray(config.allowedRoots)) throw new Error('config.allowedRoots must be an array');
  for (const root of config.allowedRoots) {
    if (!root || typeof root.path !== 'string' || !(path.isAbsolute(root.path) || path.win32.isAbsolute(root.path)) || root.path.includes('\0')) throw new Error('Each allowed root must have an absolute path');
    const permissions = root.permissions || ['read'];
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some(value => !['read', 'write'].includes(value))) throw new Error('Root permissions must explicitly contain read and/or write');
  }
  for (const name of ['wsl', 'codex']) {
    if (config[name]?.enabled !== undefined && typeof config[name].enabled !== 'boolean') throw new Error(`config.${name}.enabled must be boolean`);
  }
  if (isWslEnabled(config)) {
    if (typeof config.wsl.distro !== 'string' || !config.wsl.distro.trim() || /[\0\r\n]/.test(config.wsl.distro)) throw new Error('Enabled WSL requires an explicit distro');
    if (typeof config.wsl.user !== 'string' || !/^[A-Za-z0-9_-]+$/.test(config.wsl.user)) throw new Error('Enabled WSL requires an explicit user');
  }
  if (isCodexEnabled(config)) {
    if (!isWslEnabled(config)) throw new Error('Codex Connect integration requires configured WSL');
    for (const field of ['adapterPath', 'uiSenderPath']) {
      const value = config.codex[field];
      if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`Enabled Codex requires ${field}`);
      if (config.codex.enabled === true && !value.startsWith('/')) throw new Error('Enabled Codex requires explicit absolute adapterPath and uiSenderPath in WSL');
    }
    for (const field of ['adapterSha256', 'uiSenderSha256']) {
      if ((config.codex.enabled === true || config.codex[field] !== undefined) && !/^[a-fA-F0-9]{64}$/.test(config.codex[field] || '')) throw new Error(`Enabled Codex requires ${field} pinned to the reviewed adapter`);
    }
    if (config.codex.messageDir !== undefined && (typeof config.codex.messageDir !== 'string' || !config.codex.messageDir.startsWith('/'))) throw new Error('Codex messageDir must be an absolute WSL path');
  }
}

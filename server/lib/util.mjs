import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const VERSION = '0.3.1';
export const SERVER_NAME = 'aihub-remote-agent';
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(text, 'utf8'));
}

export async function sha256File(filePath) {
  return sha256Buffer(await fs.readFile(filePath));
}

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function assertString(value, name, { min = 1, max = 200000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new Error(`${name} must be a string with length ${min}..${max}`);
  }
  return value;
}

export function assertInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in range ${min}..${max}`);
  }
  return value;
}

export function assertBoolean(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value;
}

export function limitText(text, maxChars = 20000) {
  if (typeof text !== 'string') text = String(text ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, filePath);
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonOutput(stdout, context = 'command') {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) throw new Error(`${context} returned empty output`);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const preview = trimmed.slice(0, 500).replaceAll('\n', '\\n');
    throw new Error(`${context} returned invalid JSON: ${preview}`);
  }
}

export function redactObject(value, { maxString = 300 } = {}) {
  const secretKey = /(token|secret|password|credential|api[_-]?key|authorization|cookie)/i;
  const walk = (input, key = '') => {
    if (secretKey.test(key)) return '[REDACTED]';
    if (typeof input === 'string') {
      if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(input)) return '[REDACTED_SECRET]';
      return input.length > maxString ? `${input.slice(0, maxString)}…` : input;
    }
    if (Array.isArray(input)) return input.slice(0, 50).map((item) => walk(item));
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).slice(0, 100).map(([k, v]) => [k, walk(v, k)]));
    }
    return input;
  };
  return walk(value);
}

export function isWindowsStylePath(input) {
  return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.includes('\\');
}

export function normalizeCaseForPlatform(input) {
  return process.platform === 'win32' || isWindowsStylePath(input) ? input.toLowerCase() : input;
}

export function relativeInside(child, parent) {
  const mod = isWindowsStylePath(child) || isWindowsStylePath(parent) ? path.win32 : path.posix;
  const rel = mod.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${mod.sep}`) && rel !== '..' && !mod.isAbsolute(rel));
}

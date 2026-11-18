import fs from 'node:fs/promises';
import path from 'node:path';
import { isWindowsStylePath, relativeInside } from './util.mjs';
import { isWslEnabled } from './config.mjs';

function normalizeSlashes(value) {
  return value.replaceAll('/', '\\');
}

export class PathPolicy {
  constructor(config) {
    this.config = config;
    this.distro = config.wsl?.distro || null;
    this.wslEnabled = isWslEnabled(config);
    this.allowedRoots = config.allowedRoots.map((entry) => ({
      ...entry,
      hostPath: this.toHostPath(entry.path),
      permissions: new Set(entry.permissions || ['read']),
    }));
    this.deniedFragments = (config.deniedPathFragments || []).map((s) => s.toLowerCase());
  }

  toHostPath(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a non-empty string');
    const value = input.trim();
    if (process.platform !== 'win32') return path.resolve(value);
    const mnt = value.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    if (mnt) {
      const rest = (mnt[2] || '').replaceAll('/', '\\');
      return `${mnt[1].toUpperCase()}:\\${rest}`;
    }
    if (value.startsWith('/')) {
      if (!this.wslEnabled || !this.distro) throw new Error('WSL_DISABLED: configure WSL before using a Linux path from Windows');
      return `\\\\wsl.localhost\\${this.distro}\\${normalizeSlashes(value.slice(1))}`;
    }
    if (value.startsWith('\\\\wsl$\\')) {
      if (!this.wslEnabled) throw new Error('WSL_DISABLED: WSL path access is disabled');
      return value.replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\');
    }
    if (/^\\\\wsl\.localhost\\/i.test(value) && !this.wslEnabled) throw new Error('WSL_DISABLED: WSL path access is disabled');
    return path.win32.resolve(value);
  }

  async authorize(input, permission = 'read', { targetMayNotExist = false } = {}) {
    const hostPath = this.toHostPath(input);
    const lowered = hostPath.toLowerCase();
    for (const fragment of this.deniedFragments) {
      if (lowered.includes(fragment)) throw new Error(`Access denied by path policy: ${fragment}`);
    }

    const matching = this.allowedRoots.find((root) => {
      const rootNorm = isWindowsStylePath(root.hostPath)
        ? path.win32.resolve(root.hostPath)
        : path.posix.resolve(root.hostPath);
      const childNorm = isWindowsStylePath(hostPath)
        ? path.win32.resolve(hostPath)
        : path.posix.resolve(hostPath);
      return relativeInside(childNorm, rootNorm);
    });
    if (!matching) throw new Error(`Path is outside configured roots: ${input}`);
    if (!matching.permissions.has(permission)) throw new Error(`Permission ${permission} denied for root ${matching.path}`);

    const rootReal = await this.realpathSafe(matching.hostPath, false);
    let targetReal;
    if (targetMayNotExist) {
      const parent = isWindowsStylePath(hostPath) ? path.win32.dirname(hostPath) : path.posix.dirname(hostPath);
      const parentReal = await this.realpathSafe(parent, false);
      const basename = isWindowsStylePath(hostPath) ? path.win32.basename(hostPath) : path.posix.basename(hostPath);
      targetReal = isWindowsStylePath(parentReal) ? path.win32.join(parentReal, basename) : path.posix.join(parentReal, basename);
    } else {
      targetReal = await this.realpathSafe(hostPath, false);
    }
    if (!relativeInside(targetReal, rootReal)) throw new Error('Path escapes configured root through symlink or junction');
    return { requestedPath: input, hostPath, realPath: targetReal, root: matching.path, permission };
  }

  async realpathSafe(input, mayNotExist) {
    try {
      return await fs.realpath(input);
    } catch (error) {
      if (mayNotExist && error?.code === 'ENOENT') return input;
      throw error;
    }
  }
}

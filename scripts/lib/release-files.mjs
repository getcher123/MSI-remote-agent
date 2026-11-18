import fs from 'node:fs/promises';
import path from 'node:path';

// Explicit publication surface: local state is never included by accident.
export const PUBLIC_DIRECTORIES = new Set(['.github', 'assets', 'config', 'docs', 'launcher', 'scripts', 'server', 'skills', 'tests']);
export const PUBLIC_ROOT_FILES = new Set([
  '.editorconfig', '.gitattributes', '.gitignore', 'AGENTS.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'LICENSE', 'README.md', 'ROADMAP.md', 'SECURITY.md',
  'package.json', 'mcp.json', 'plugin.json', 'state.md',
]);

export function forbiddenPublicPath(relative) {
  const parts = relative.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1);
  return parts.some(part => ['.git', 'node_modules', 'state', 'logs', 'coverage', 'dist', 'evidence', 'screenshots', '__pycache__'].includes(part))
    || parts.some(part => part === '.env' || part.startsWith('.env.'))
    || (/(?:^|[._-])(?:credentials|secrets|receipts|local)(?:[._-]|$)/i.test(name) && /\.(?:json|toml|ya?ml|txt)$/.test(name))
    || /\.(?:log|jsonl|sqlite3?|db|pem|key|pfx|p12|zip|tgz|gz|png|jpe?g|webp|mp4)$/i.test(name)
    || /^tunnel-client(?:\.|-)/.test(name)
    || (parts[0] === 'config' && parts.length > 1 && relative !== 'config/default-config.json');
}

export async function collectReleaseFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (directory === root && !PUBLIC_DIRECTORIES.has(entry.name) && !PUBLIC_ROOT_FILES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Release symlink is forbidden: ${relative}`);
      if (forbiddenPublicPath(relative)) throw new Error(`Private or unsupported release path: ${relative}`);
      if (entry.isDirectory()) {
        if (directory === root && !PUBLIC_DIRECTORIES.has(entry.name)) throw new Error(`Expected a file: ${relative}`);
        await visit(full);
      } else if (entry.isFile()) files.push(relative);
      else throw new Error(`Non-regular release file: ${relative}`);
    }
  }
  await visit(root);
  return files.sort();
}

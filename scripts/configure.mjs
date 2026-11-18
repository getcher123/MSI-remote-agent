#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, packageRoot, validateConfig } from '../server/lib/config.mjs';

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function futureRealPath(input) {
  const absolute = path.resolve(input);
  let current = absolute;
  const missing = [];
  while (true) {
    try { return path.join(await fs.realpath(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent;
    }
  }
}

export function parseConfigureArgs(argv) {
  const options = { roots: [], readOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--read-only') options.readOnly = true;
    else if (['--root', '--wsl-distro', '--wsl-user'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`${flag} requires a value`);
      if (flag === '--root') options.roots.push(value);
      else {
        const key = flag === '--wsl-distro' ? 'wslDistro' : 'wslUser';
        if (options[key] !== undefined) throw new Error(`${flag} may be supplied only once`);
        options[key] = value;
      }
    } else throw new Error(`Unknown configure option: ${flag}`);
  }
  if (Boolean(options.wslDistro) !== Boolean(options.wslUser)) throw new Error('--wsl-distro and --wsl-user must be supplied together');
  return options;
}

export async function configure(options, { cwd = process.cwd(), configPath = defaultConfigPath(), repositoryRoot = packageRoot() } = {}) {
  const destination = await futureRealPath(configPath);
  const repository = await fs.realpath(repositoryRoot);
  if (inside(destination, repository)) throw new Error('Private configuration must be outside this repository; use the default user configuration directory');
  let ancestor = path.dirname(destination);
  while (true) {
    try { await fs.lstat(path.join(ancestor, '.git')); throw new Error('Private configuration must not be written inside a Git checkout'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const requestedRoots = options.roots.length ? options.roots : [cwd];
  if (requestedRoots.length > 32) throw new Error('At most 32 explicit roots are supported');
  const roots = [];
  const seen = new Set();
  for (const input of requestedRoots) {
    const resolved = await fs.realpath(path.resolve(cwd, input));
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Each workspace root must be an existing directory');
    if (resolved === path.parse(resolved).root) throw new Error('A filesystem root is too broad; select a project directory');
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ path: resolved, permissions: options.readOnly ? ['read'] : ['read', 'write'] });
  }

  const template = JSON.parse(await fs.readFile(path.join(repository, 'config', 'default-config.json'), 'utf8'));
  const config = {
    ...template,
    deviceId: `local-${os.hostname().replace(/[^A-Za-z0-9_.-]/g, '_')}`.slice(0, 128),
    allowedRoots: roots,
    wsl: options.wslDistro ? { enabled: true, distro: options.wslDistro, user: options.wslUser } : { enabled: false },
    codex: { enabled: false },
  };
  validateConfig(config);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await fs.open(destination, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Configuration already exists; no settings were overwritten. Review the existing private config to make later changes.');
    throw error;
  }
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return { config_path: destination, roots, wsl_enabled: config.wsl.enabled, codex_enabled: false, overwritten: false };
}

async function main() {
  const options = parseConfigureArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run configure -- [--root DIRECTORY ...] [--read-only] [--wsl-distro NAME --wsl-user USER]\nWithout --root, the current directory is selected. Existing directories only.\nConfiguration is created outside Git checkouts and is never overwritten.\nWSL and Codex are disabled by default. WSL flags do not grant additional paths.\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(await configure(options), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

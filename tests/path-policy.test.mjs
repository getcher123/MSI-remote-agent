import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathPolicy } from '../server/lib/path-policy.mjs';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-path-'));
  const allowed = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(allowed, 'ok.txt'), 'ok');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  return { base, allowed, outside };
}

test('authorizes a file inside allowed root', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.base, { recursive: true, force: true }));
  const policy = new PathPolicy({ wsl: { distro: 'Ubuntu-22.04' }, allowedRoots: [{ path: f.allowed, permissions: ['read','write'] }], deniedPathFragments: [] });
  const auth = await policy.authorize(path.join(f.allowed, 'ok.txt'), 'read');
  assert.equal(await fs.readFile(auth.realPath, 'utf8'), 'ok');
});

test('denies outside root and symlink escape', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.base, { recursive: true, force: true }));
  const policy = new PathPolicy({ wsl: { distro: 'Ubuntu-22.04' }, allowedRoots: [{ path: f.allowed, permissions: ['read','write'] }], deniedPathFragments: [] });
  await assert.rejects(() => policy.authorize(path.join(f.outside, 'secret.txt'), 'read'));
  const link = path.join(f.allowed, 'link.txt');
  try { await fs.symlink(path.join(f.outside, 'secret.txt'), link); }
  catch { t.skip('symlink creation unavailable'); return; }
  await assert.rejects(() => policy.authorize(link, 'read'), /escapes/);
});

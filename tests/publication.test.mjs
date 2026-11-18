import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectReleaseFiles } from '../scripts/lib/release-files.mjs';
import { scanText, scanFiles } from '../scripts/lib/privacy.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('release inventory excludes Git metadata and unapproved local state', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.git', 'config'), 'private local metadata');
  await fs.mkdir(path.join(root, 'state'));
  await fs.writeFile(path.join(root, 'state', 'config.json'), '{}');
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'default-config.json'), '{}');
  await fs.writeFile(path.join(root, 'README.md'), 'Public project');
  assert.deepEqual(await collectReleaseFiles(root), ['README.md', 'config/default-config.json']);
  assert.equal((await scanFiles(root, ['state/config.json']))[0].rule, 'private-path');
});

test('release inventory rejects private files inside published directories', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'config.local.json'), '{}');
  await assert.rejects(collectReleaseFiles(root), /Private or unsupported release path: config\/config\.local\.json/);
});

test('privacy findings disclose locations and rules, never matched values', () => {
  const credential = 'gh' + 'p_' + 'A'.repeat(40);
  const text = `first line\n${credential}\n`;
  const findings = scanText('README.md', text);
  assert.deepEqual(findings, [{ path: 'README.md', line: 2, rule: 'github-token' }]);
  assert.ok(!JSON.stringify(findings).includes(credential));
});

test('only explicit synthetic test credentials are exempt', () => {
  const fixtureText = "api_key: 'fixture-not-real-value'";
  assert.equal(scanText('tests/example.test.mjs', fixtureText).length, 0);
  assert.equal(scanText('config/default-config.json', fixtureText).length, 1);
  const credential = 'sk' + '-' + 'B'.repeat(32);
  assert.equal(scanText('tests/example.test.mjs', credential)[0].rule, 'openai-key');
});

test('personal homes are rejected while generated and synthetic paths are allowed', () => {
  const privatePath = '/home/' + 'private-account/project';
  assert.equal(scanText('README.md', privatePath)[0].rule, 'personal-home');
  assert.deepEqual(scanText('tests/example.test.mjs', '/home/testuser/project'), []);
  assert.deepEqual(scanText('server/config.mjs', '/home/${user}/project'), []);
});

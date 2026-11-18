import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { collectReleaseFiles } from './lib/release-files.mjs';
import { scanFiles } from './lib/privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = await collectReleaseFiles(root);
const findings = await scanFiles(root, paths);
if (findings.length) {
  for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
  throw new Error('Privacy check failed; no release manifest was written.');
}
const files = [];
for (const relative of paths) {
  const data = await fs.readFile(path.join(root, relative));
  files.push({ path: relative, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
}
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
// No wall-clock timestamp: identical source produces identical manifest bytes.
const manifest = { schemaVersion: 1, name: pkg.name, version: pkg.version, files };
await fs.writeFile(path.join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Manifest built: ${files.length} public files for ${pkg.version}`);

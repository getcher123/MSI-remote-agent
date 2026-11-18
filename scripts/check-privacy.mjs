import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectReleaseFiles } from './lib/release-files.mjs';
import { scanFiles } from './lib/privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = await collectReleaseFiles(root);
// CI scans every tracked file too, including files outside the release allowlist.
// Do not silently fall back if Git exists but the inventory cannot be read.
if (await fs.stat(path.join(root, '.git')).catch(() => null)) {
  files.push(...execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
}
const findings = await scanFiles(root, files);
for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
if (findings.length) {
  console.error(`Privacy check failed: ${findings.length} finding(s). Values are deliberately omitted.`);
  process.exitCode = 1;
} else console.log(`Privacy check passed: ${new Set(files).size} files. Manual review is still required before publishing.`);

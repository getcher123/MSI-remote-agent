import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles } from './lib/release-files.mjs';
import { buildTools } from '../server/lib/tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = await collectReleaseFiles(root);
const markdown = files.filter(file => file.endsWith('.md'));
const contents = new Map(await Promise.all(markdown.map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')])));
const failures = [];
for (const [file, content] of contents) {
  for (const match of content.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)) {
    const link = match[1].split('#')[0];
    if (!link || /^[a-z][a-z\d+.-]*:/i.test(link)) continue;
    const target = path.resolve(root, path.dirname(file), decodeURIComponent(link));
    if (!target.startsWith(root + path.sep) || !(await fs.stat(target).catch(() => null))) failures.push(`${file}: broken or external local reference ${link}`);
  }
}
const skill = contents.get('skills/remote-machine/SKILL.md') || '';
if (!/^---\r?\nname: remote-machine\r?\ndescription: .+\r?\n---/u.test(skill)) failures.push('Invalid packaged skill frontmatter');
const routeText = [...contents].filter(([file]) => file.startsWith('skills/remote-machine/')).map(([, content]) => content).join('\n');
// Building schemas has no I/O; none of the handlers are invoked here.
const { tools, handlers } = buildTools({ config: {}, pathPolicy: {}, processManager: {}, codexBridge: {}, localMcpBridge: {} });
const names = tools.map(tool => tool.name);
if (new Set(names).size !== names.length || handlers.size !== names.length) failures.push('Duplicate tools or unmatched handlers');
for (const name of names) if (!routeText.includes(`\`${name}\``)) failures.push(`Packaged agent route missing: ${name}`);
if (!contents.has('AGENTS.md') || !contents.has('CONTRIBUTING.md') || !contents.has('ROADMAP.md')) failures.push('Developer entry documents missing');
for (const failure of failures) console.error(failure);
if (failures.length) process.exitCode = 1;
else console.log(`Agent routes passed: ${names.length} tools, packaged skill references and ${markdown.length} Markdown files checked.`);

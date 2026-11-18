import fs from 'node:fs/promises';
import path from 'node:path';
import { forbiddenPublicPath } from './release-files.mjs';

const rules = [
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ['openai-key', /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-connection-id', /\b(?:tunnel_[a-z0-9]{32}|asdk_app_[a-z0-9]{20,}|libfile_[A-Za-z0-9_-]{20,}|file_[a-f0-9]{24,})\b/g],
  ['credential-in-url', /https?:\/\/[^\s\x22\x27`/]+:[^\s\x22\x27`/]+@[^\s\x22\x27`]+/g],
  ['literal-credential', /\b(?:CONTROL_PLANE_API_KEY|api[_-]?key|access[_-]?token|client[_-]?secret|password)\b[\x22\x27]?\s*[:=]\s*[\x22\x27]([^\x22\x27\r\n]+)[\x22\x27]/gi],
  ['personal-home', /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]+Users[\\/]+|\/mnt\/[a-z]\/Users\/)([^\\/\s\x22\x27`]+)/g],
  ['email-address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

function synthetic(relative, rule, match) {
  const value = match[1] ?? match[0];
  if (rule === 'personal-home') return /^(?:testuser|fixtureuser|runner|runneradmin|example|user|public|default)$/i.test(value) || value.startsWith('${');
  if (rule === 'email-address') return /@(?:example\.(?:com|org|net)|[^@]+\.invalid)$/i.test(value);
  if (rule === 'literal-credential' && (value.startsWith('${') || value === '[REDACTED]')) return true;
  // Only explicit synthetic values in test code are exempt, never whole files.
  if (!relative.startsWith('tests/')) return false;
  if (['literal-credential', 'credential-in-url'].includes(rule) && /fixture|synthetic|not-real|private-test/i.test(value)) return true;
  return rule === 'credential-in-url' && /^http:\/\/user:(?:password|private)@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(value);
}

export function scanText(relative, text) {
  const findings = [];
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (synthetic(relative, rule, match)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      if (!findings.some(item => item.rule === rule && item.line === line)) findings.push({ path: relative, line, rule });
    }
  }
  return findings;
}

export async function scanFiles(root, relatives) {
  const findings = [];
  for (const relative of [...new Set(relatives)].sort()) {
    if (forbiddenPublicPath(relative)) {
      findings.push({ path: relative, line: 0, rule: 'private-path' });
      continue;
    }
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe scan path');
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      findings.push({ path: relative, line: 0, rule: 'non-regular-file' });
      continue;
    }
    const data = await fs.readFile(file);
    if (data.includes(0)) findings.push({ path: relative, line: 0, rule: 'unreviewed-binary' });
    else findings.push(...scanText(relative, data.toString('utf8')));
  }
  return findings;
}

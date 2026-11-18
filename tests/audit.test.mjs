import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../server/lib/audit.mjs';
test('audit excludes content, command args, env values, process output and Codex transcript', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-audit-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'audit.jsonl'); const a = new AuditLog({ auditLog: file }); const hidden = 'PRIVATE_TEST_MARKER';
  for (const tool of ['start_process', 'process_output', 'read_file', 'read_multiple_files', 'write_file', 'edit_file', 'process_input', 'codex_read_thread', 'codex_send_message', 'list_process_sessions']) {
    await a.record({ tool, status: 'ok', args: { args: [hidden], env: { CUSTOM: hidden }, content: hidden, replacement: hidden, search: hidden, input: hidden, message: hidden }, result: { text: hidden, stdout: hidden, stderr: hidden, base64: hidden, files: [{ text: hidden }], turns: [{ text: hidden }], sessions: [{ stdout: hidden, args: [hidden] }] } });
  }
  await a.record({ tool: 'read_file', args: {}, status: 'error', error: new Error(hidden) });
  const text = await fs.readFile(file, 'utf8'); assert.doesNotMatch(text, /PRIVATE_TEST_MARKER/); assert.equal(text.trim().split('\n').length, 11);
});

import fs from 'node:fs/promises';
import { ensureDir, nowIso, randomId, redactObject } from './util.mjs';
import path from 'node:path';

// Metadata only. Neither tool output nor visible Codex transcripts belong here.
export class AuditLog {
  constructor(config) { this.file = config.auditLog; }
  async record({ tool, args, status, durationMs, mutation = false, result, error }) {
    await ensureDir(path.dirname(this.file));
    const record = {
      id: randomId('audit'), at: nowIso(), tool, mutation, status, duration_ms: durationMs,
      args: summarizeArgs(tool, args), result: summarizeResult(tool, result),
      error: error ? { name: error.name || 'Error', code: error.code || null } : undefined,
    };
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record.id;
  }
}
function summarizeArgs(tool, args = {}) {
  if (tool.startsWith('local_mcp_')) return pick(args, ['server_id', 'operation_id', 'tool_name', 'source_path', 'source_name', 'runtime', 'force']);
  if (tool === 'codex_send_message') return { thread_id: args.thread_id, cwd: args.cwd, message_length: args.message?.length };
  if (tool === 'start_process') return { runtime: args.runtime, executable: args.executable, cwd: args.cwd, arg_count: args.args?.length || 0, intent: args.intent };
  if (tool === 'write_file') return { path: args.path, content_length: args.content?.length, encoding: args.encoding };
  if (tool === 'edit_file') return { path: args.path, replacement_length: args.replacement?.length, replace_all: args.replace_all };
  if (tool === 'process_input') return { session_id: args.session_id, input_length: args.input?.length };
  return pick(args, ['path', 'paths', 'source', 'destination', 'session_id', 'thread_id', 'receipt_id', 'limit', 'max_chars', 'start_line', 'max_lines', 'stdout_offset', 'stderr_offset', 'force', 'wait_ms']);
}
function summarizeResult(tool, result) {
  if (!result) return result;
  if (tool.startsWith('local_mcp_')) return pick(result, ['server_id', 'operation_id', 'tool_name', 'state', 'retry_safe', 'dispatched', 'deduplicated', 'disconnected', 'registered', 'removed']);
  if (tool === 'codex_read_thread') return { thread_id: result.thread_id, cwd: result.cwd, runtime_status: result.runtime_status, loaded_turn_count: result.loaded_turn_count };
  if (tool === 'codex_discover') return { source: result.source, partial: result.partial, thread_count: result.threads?.length || 0 };
  if (tool === 'list_process_sessions') return { sessions: result.sessions?.map((s) => ({ session_id: s.session_id, status: s.status })) };
  if (tool === 'start_process' || tool === 'process_output') return { session_id: result.session_id, status: result.status, exit_code: result.exit_code, stdout_total_chars: result.stdout_total_chars, stderr_total_chars: result.stderr_total_chars };
  if (tool === 'read_file') return { path: result.path, size: result.size, sha256: result.sha256, truncated: result.truncated };
  if (tool === 'read_multiple_files') return { files: result.files?.map((f) => ({ path: f.path, sha256: f.sha256, truncated: f.truncated, failed: Boolean(f.error) })) };
  return pick(result, ['path', 'source', 'destination', 'size', 'bytes', 'sha256', 'created', 'replacements', 'previous_sha256', 'moved', 'written_chars', 'session_id', 'status', 'termination_confirmed', 'exit_confirmed', 'receipt_id', 'phase', 'thread_id', 'message_sha256', 'observed_turn_id', 'observed_message_id', 'retry_safe']);
}

function pick(input, keys) { return redactObject(Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]))); }

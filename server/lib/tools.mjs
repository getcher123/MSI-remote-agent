import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, limitText, nowIso, pathExists, sha256Buffer, sha256File, sha256Text, VERSION } from './util.mjs';
import { registerLocalMcpTools } from './local-mcp-tools.mjs';
import { isWslEnabled, isCodexEnabled } from './config.mjs';

const str = (description, extras = {}) => ({ type: 'string', description, ...extras });
const int = (description, extras = {}) => ({ type: 'integer', description, ...extras });
const bool = (description, extras = {}) => ({ type: 'boolean', description, ...extras });

export function buildTools({ config, pathPolicy, processManager, codexBridge, localMcpBridge }) {
  const handlers = new Map();
  const tools = [];

  const register = (name, description, inputSchema, handler, { mutation = false } = {}) => {
    tools.push({ name, description, inputSchema, annotations: { readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: !mutation, openWorldHint: true } });
    handlers.set(name, { handler, mutation });
  };

  register('device_status', 'Проверяет локальный AIHub Remote Agent, Windows/WSL и Codex Connect без изменений.', {
    type: 'object', additionalProperties: false, properties: {},
  }, async () => {
    const codexScripts = await codexBridge.verifyScripts().catch((error) => ({ error: String(error) }));
    const doctor = await codexBridge.doctor().catch((error) => ({ error: String(error) }));
    return {
      agent: { name: 'AIHub Remote Agent', version: VERSION, device_id: config.deviceId, release_manifest_sha256: await sha256File(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'release-manifest.json')).catch(() => null) },
      host: { platform: process.platform, arch: process.arch, hostname: os.hostname(), node: process.version },
      setup_required: config.allowedRoots.length === 0,
      integrations: { wsl_enabled: isWslEnabled(config), codex_enabled: isCodexEnabled(config) },
      wsl: isWslEnabled(config) ? config.wsl : { enabled: false, status: 'disabled' },
      config_source: config.__source,
      allowed_roots: config.allowedRoots.map(({ path, permissions }) => ({ path, permissions })),
      codex_scripts: codexScripts,
      codex_doctor: doctor,
      at: nowIso(),
    };
  });

  register('list_directory', 'Показывает один каталог внутри разрешённых корней, без рекурсивного обхода.', {
    type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: str('Windows, UNC или WSL-путь.'),
      include_hidden: bool('Показывать скрытые элементы.', { default: false }),
      limit: int('Максимум элементов.', { minimum: 1, maximum: 2000, default: 500 }),
    },
  }, async ({ path: input, include_hidden = false, limit = 500 }) => {
    const auth = await pathPolicy.authorize(input, 'read');
    const entries = await fs.readdir(auth.realPath, { withFileTypes: true });
    const selected = entries
      .filter((entry) => include_hidden || !entry.name.startsWith('.'))
      .slice(0, limit);
    const items = [];
    for (const entry of selected) {
      const full = path.join(auth.realPath, entry.name);
      let stat = null;
      try { stat = await fs.lstat(full); } catch {}
      items.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        size: stat?.size ?? null,
        modified_at: stat?.mtime?.toISOString?.() ?? null,
      });
    }
    return { path: input, real_path: auth.realPath, count: items.length, truncated: entries.length > selected.length, items };
  });

  register('file_info', 'Возвращает размер, даты, тип и SHA-256 разрешённого файла.', {
    type: 'object', additionalProperties: false, required: ['path'], properties: { path: str('Путь к файлу.') },
  }, async ({ path: input }) => {
    const auth = await pathPolicy.authorize(input, 'read');
    const stat = await fs.lstat(auth.realPath);
    return {
      path: input,
      real_path: auth.realPath,
      type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
      size: stat.size,
      created_at: stat.birthtime.toISOString(),
      modified_at: stat.mtime.toISOString(),
      sha256: stat.isFile() ? await sha256File(auth.realPath) : null,
    };
  });

  register('read_file', 'Читает текстовый диапазон или ограниченный бинарный диапазон из разрешённого файла.', {
    type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: str('Путь к файлу.'),
      mode: { type: 'string', enum: ['text', 'base64'], default: 'text' },
      start_line: int('Первая строка, 1-based.', { minimum: 1, default: 1 }),
      max_lines: int('Максимум строк.', { minimum: 1, maximum: 10000, default: 500 }),
      offset_bytes: int('Смещение для base64.', { minimum: 0, default: 0 }),
      max_bytes: int('Максимум байтов.', { minimum: 1, maximum: 1048576, default: 262144 }),
    },
  }, async ({ path: input, mode = 'text', start_line = 1, max_lines = 500, offset_bytes = 0, max_bytes = 262144 }) => {
    const auth = await pathPolicy.authorize(input, 'read');
    const data = await fs.readFile(auth.realPath);
    const sha256 = sha256Buffer(data);
    if (mode === 'base64') {
      const chunk = data.subarray(offset_bytes, offset_bytes + max_bytes);
      return { path: input, sha256, size: data.length, offset_bytes, returned_bytes: chunk.length, truncated: offset_bytes + chunk.length < data.length, base64: chunk.toString('base64') };
    }
    const text = data.toString('utf8');
    const lines = text.split(/\r?\n/);
    const start = start_line - 1;
    const selected = lines.slice(start, start + max_lines);
    return {
      path: input,
      sha256,
      size: data.length,
      start_line,
      end_line: start + selected.length,
      total_lines: lines.length,
      truncated: start + selected.length < lines.length,
      text: selected.map((line, index) => `${start_line + index}: ${line}`).join('\n'),
    };
  });

  register('read_multiple_files', 'Читает небольшие диапазоны нескольких разрешённых текстовых файлов.', {
    type: 'object', additionalProperties: false, required: ['paths'], properties: {
      paths: { type: 'array', minItems: 1, maxItems: 30, items: str('Путь к файлу.') },
      start_line: int('Первая строка каждого файла.', { minimum: 1, default: 1 }),
      max_lines: int('Строк на файл.', { minimum: 1, maximum: 2000, default: 200 }),
    },
  }, async ({ paths, start_line = 1, max_lines = 200 }) => {
    const files = [];
    for (const input of paths) {
      try {
        const auth = await pathPolicy.authorize(input, 'read');
        const data = await fs.readFile(auth.realPath);
        const lines = data.toString('utf8').split(/\r?\n/);
        const start = start_line - 1;
        const selected = lines.slice(start, start + max_lines);
        files.push({ path: input, sha256: sha256Buffer(data), total_lines: lines.length, start_line, end_line: start + selected.length, truncated: start + selected.length < lines.length, text: selected.join('\n') });
      } catch (error) {
        files.push({ path: input, error: String(error) });
      }
    }
    return { files };
  });

  register('write_file', 'Атомарно создаёт или заменяет файл внутри write-разрешённого корня. Требует явного подтверждения mutation.', {
    type: 'object', additionalProperties: false, required: ['path', 'content', 'confirm_mutation'], properties: {
      path: str('Целевой путь.'),
      content: str('UTF-8 текст или base64.', { maxLength: 5_000_000 }),
      encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
      expected_sha256: str('Ожидаемый SHA текущего файла; пусто только для нового файла.', { minLength: 64, maxLength: 64 }),
      create_only: bool('Ошибка, если файл уже существует.', { default: false }),
      confirm_mutation: { const: true, description: 'Должно быть true.' },
    },
  }, async ({ path: input, content, encoding = 'utf8', expected_sha256, create_only = false, confirm_mutation }) => {
    if (confirm_mutation !== true) throw new Error('confirm_mutation=true is required');
    const auth = await pathPolicy.authorize(input, 'write', { targetMayNotExist: true });
    const exists = await pathExists(auth.hostPath);
    if (create_only && exists) throw new Error('Target already exists');
    if (exists) {
      await pathPolicy.authorize(input, 'write');
      if (!expected_sha256) throw new Error('expected_sha256 is required when replacing an existing file');
    }
    if (expected_sha256) {
      if (!exists) throw new Error('Target does not exist for expected_sha256 check');
      const actual = await sha256File(auth.hostPath);
      if (actual.toLowerCase() !== expected_sha256.toLowerCase()) throw new Error(`SHA mismatch: ${actual}`);
    }
    const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    await atomicWrite(auth.hostPath, buffer);
    return { path: input, bytes: buffer.length, sha256: sha256Buffer(buffer), created: !exists };
  }, { mutation: true });

  register('edit_file', 'Выполняет точную замену текста после проверки SHA. Не применяет патчи к неожиданной версии файла.', {
    type: 'object', additionalProperties: false, required: ['path', 'expected_sha256', 'search', 'replacement', 'confirm_mutation'], properties: {
      path: str('Путь к UTF-8 файлу.'),
      expected_sha256: str('Текущий SHA-256.', { minLength: 64, maxLength: 64 }),
      search: str('Точный искомый текст.', { maxLength: 1_000_000 }),
      replacement: str('Текст замены.', { minLength: 0, maxLength: 1_000_000 }),
      replace_all: bool('Заменить все совпадения; иначе требуется ровно одно.', { default: false }),
      confirm_mutation: { const: true },
    },
  }, async ({ path: input, expected_sha256, search, replacement, replace_all = false, confirm_mutation }) => {
    if (confirm_mutation !== true) throw new Error('confirm_mutation=true is required');
    const auth = await pathPolicy.authorize(input, 'write');
    const data = await fs.readFile(auth.realPath);
    const actual = sha256Buffer(data);
    if (actual.toLowerCase() !== expected_sha256.toLowerCase()) throw new Error(`SHA mismatch: ${actual}`);
    const text = data.toString('utf8');
    const count = search ? text.split(search).length - 1 : 0;
    if (count === 0) throw new Error('Search text not found');
    if (!replace_all && count !== 1) throw new Error(`Expected exactly one match, found ${count}`);
    const next = replace_all ? text.split(search).join(replacement) : text.replace(search, replacement);
    await atomicWrite(auth.realPath, Buffer.from(next, 'utf8'));
    return { path: input, replacements: replace_all ? count : 1, previous_sha256: actual, sha256: sha256Text(next) };
  }, { mutation: true });

  register('move_file', 'Перемещает или переименовывает файл между разрешёнными write-корнями без перезаписи.', {
    type: 'object', additionalProperties: false, required: ['source', 'destination', 'confirm_mutation'], properties: {
      source: str('Исходный путь.'), destination: str('Новый путь.'), confirm_mutation: { const: true },
    },
  }, async ({ source, destination, confirm_mutation }) => {
    if (confirm_mutation !== true) throw new Error('confirm_mutation=true is required');
    const src = await pathPolicy.authorize(source, 'write');
    const dst = await pathPolicy.authorize(destination, 'write', { targetMayNotExist: true });
    if (await pathExists(dst.hostPath)) throw new Error('Destination already exists');
    await fs.rename(src.realPath, dst.hostPath);
    return { source, destination, moved: true };
  }, { mutation: true });

  register('start_process', 'Запускает allowlisted Windows или WSL-процесс. Для mutating intent требуется confirm_mutation=true.', {
    type: 'object', additionalProperties: false, required: ['runtime', 'executable'], properties: {
      runtime: { type: 'string', enum: ['native', 'windows', 'wsl'] },
      executable: str('Исполняемый файл без shell-конкатенации.'),
      args: { type: 'array', maxItems: 100, items: str('Отдельный аргумент.', { maxLength: 20000 }), default: [] },
      cwd: str('Рабочий каталог.'),
      env: { type: 'object', additionalProperties: { type: 'string', maxLength: 10000 }, default: {} },
      timeout_ms: int('0 означает без автоматического timeout.', { minimum: 0, maximum: 86_400_000, default: 0 }),
      intent: { type: 'string', enum: ['read', 'write'], default: 'read' },
      confirm_mutation: bool('Обязательно true для intent=write.', { default: false }),
      label: str('Короткая метка процесса.', { minLength: 0, maxLength: 120 }),
    },
  }, async (args) => {
    if ((args.intent || 'read') === 'write' && args.confirm_mutation !== true) throw new Error('confirm_mutation=true is required for write intent');
    return processManager.start(args);
  }, { mutation: true });

  register('process_output', 'Читает новые stdout/stderr и статус ранее запущенного процесса.', {
    type: 'object', additionalProperties: false, required: ['session_id'], properties: {
      session_id: str('ID процесса.'), stdout_offset: int('Смещение stdout.', { minimum: 0, default: 0 }), stderr_offset: int('Смещение stderr.', { minimum: 0, default: 0 }), max_chars: int('Максимум символов каждого потока.', { minimum: 1, maximum: 200000, default: 20000 }),
    },
  }, async ({ session_id, stdout_offset = 0, stderr_offset = 0, max_chars = 20000 }) => processManager.output(session_id, { stdout_offset, stderr_offset, max_chars }));

  register('process_input', 'Пишет в stdin активного процесса. Требует явного подтверждения.', {
    type: 'object', additionalProperties: false, required: ['session_id', 'input', 'confirm_mutation'], properties: {
      session_id: str('ID процесса.'), input: str('Ввод.', { minLength: 0, maxLength: 200000 }), append_newline: bool('Добавить перевод строки.', { default: false }), confirm_mutation: { const: true },
    },
  }, async ({ session_id, input, append_newline = false, confirm_mutation }) => {
    if (confirm_mutation !== true) throw new Error('confirm_mutation=true is required');
    return processManager.input(session_id, input, append_newline);
  }, { mutation: true });

  register('list_process_sessions', 'Показывает процессы, запущенные текущим экземпляром агента.', {
    type: 'object', additionalProperties: false, properties: {},
  }, async () => ({ sessions: processManager.list() }));

  register('terminate_process', 'Запрашивает остановку собственного процесса и проверяет выход. Не повышает soft-stop до force автоматически. Проверяйте termination_confirmed.', {
    type: 'object', additionalProperties: false, required: ['session_id', 'confirm_mutation'], properties: {
      session_id: str('ID процесса.'), force: bool('Запрос принудительной остановки; выход проверяется отдельно.', { default: false }), wait_ms: int('Ожидание подтверждения выхода после запроса остановки.', { minimum: 0, maximum: 10000, default: 2000 }), confirm_mutation: { const: true },
    },
  }, async ({ session_id, force = false, wait_ms = 2000, confirm_mutation }) => {
    if (confirm_mutation !== true) throw new Error('confirm_mutation=true is required');
    return processManager.terminate(session_id, force, 'requested', wait_ms);
  }, { mutation: true });

  register('codex_doctor', 'Проверяет установленный Codex Connect, socket/backend/version и SHA адаптера.', {
    type: 'object', additionalProperties: false, properties: {},
  }, async () => codexBridge.doctor());

  register('codex_discover', 'Находит существующие Codex-сессии; точный title является фильтром, а не разрешением выбрать по имени.', {
    type: 'object', additionalProperties: false, properties: {
      title: str('Опциональный точный title.'), thread_ids: { type: 'array', maxItems: 20, uniqueItems: true, items: str('Известный точный UUID; проверить только его, без широкого поиска.') }, limit: int('Максимум результатов.', { minimum: 1, maximum: 200, default: 50 }),
    },
  }, async ({ title, limit = 50, thread_ids = [] }) => codexBridge.discover({ title, limit, thread_ids }));

  register('codex_read_thread', 'Читает только видимые user/assistant сообщения точной Codex-сессии и её live status/pending.', {
    type: 'object', additionalProperties: false, properties: {
      thread_id: str('Предпочтительный UUID сессии.'), title: str('Точный title, если UUID неизвестен.'), limit: int('Число последних turns.', { minimum: 1, maximum: 20, default: 2 }), max_chars: int('Лимит текста.', { minimum: 1000, maximum: 200000, default: 16000 }), timeout_seconds: int('Timeout IPC read.', { minimum: 1, maximum: 60, default: 20 }),
    }, anyOf: [{ required: ['thread_id'] }, { required: ['title'] }],
  }, async (args) => codexBridge.readThread(args));

  register('codex_send_message', 'Отправляет UTF-8 сообщение в точный idle Codex thread. Передайте стабильный operation_id до первой попытки: статус доступен по нему после timeout, повтор ID не отправляет заново. queued не считается доставкой.', {
    type: 'object', additionalProperties: false, required: ['thread_id', 'title', 'cwd', 'message', 'confirm_mutation'], properties: {
      operation_id: str('Стабильный ID попытки, сохранённый клиентом до вызова; существующий ID не переисполняется.', { pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$', minLength: 8, maxLength: 128 }), thread_id: str('Точный thread UUID.'), title: str('Точный отображаемый title.'), cwd: str('Ожидаемый cwd.'), message: str('Полный текст, не более 32768 байтов UTF-8.', { maxLength: 32768 }), wait_seconds: int('Ожидание наблюдения UI.', { minimum: 1, maximum: 60, default: 15 }), confirm_mutation: { const: true },
    },
  }, async ({ confirm_mutation, ...args }) => {
    if (confirm_mutation !== true) throw new Error('confirm_mutation=true is required');
    return codexBridge.sendMessage(args);
  }, { mutation: true });

  register('codex_delivery_status', 'Читает квитанцию по receipt_id или исходному operation_id, без отправки. При занятом lock сразу возвращает сохранённый этап; refresh=true сверяет неизвестную доставку через IPC.', {
    type: 'object', additionalProperties: false, anyOf: [{ required: ['receipt_id'] }, { required: ['operation_id'] }], properties: {
      receipt_id: str('ID квитанции codex_send_message.'), operation_id: str('Исходный ID, известный клиенту до отправки.', { pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$', minLength: 8, maxLength: 128 }), refresh: bool('false: сохранённый статус; true: сверка неизвестной доставки даже при lock; доказанный not_sent всегда берётся из квитанции.'),
    },
  }, async (args) => codexBridge.deliveryStatus(args));

  if (localMcpBridge) registerLocalMcpTools(register, localMcpBridge);
  return { tools, handlers };
}

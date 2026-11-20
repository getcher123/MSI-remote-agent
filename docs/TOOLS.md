# Каталог инструментов и маршруты

Источник истины для параметров — живой `tools/list` и схемы в `server/lib/tools.mjs` / `server/lib/local-mcp-tools.mjs`. Каталог состоит из 30 инструментов. Отключённая интеграция может оставлять инструмент в каталоге и возвращать понятную ошибку настройки при вызове.

| Группа | Инструменты | Маршрут |
| --- | --- | --- |
| Диагностика | `device_status` | Проверить устройство, версию, конфигурацию и состояние интеграций |
| Чтение файлов | `list_directory`, `file_info`, `read_file`, `read_multiple_files` | Начать с узкого каталога/файла внутри разрешённого корня |
| Изменение файлов | `write_file`, `edit_file`, `move_file` | Проверить цель и SHA; передать `confirm_mutation=true`; сверить результат |
| Процессы | `start_process`, `process_output`, `process_input`, `list_process_sessions`, `terminate_process` | Структурированный запуск → session ID → чтение offsets → проверенная остановка |
| Codex Connect | `codex_doctor`, `codex_discover`, `codex_read_thread`, `codex_send_message`, `codex_delivery_status` | Диагностика → точный thread → чтение → сохранённый клиентом operation ID → однократная отправка → квитанция |
| Выбор локального MCP | `local_mcp_discover`, `local_mcp_register`, `local_mcp_servers`, `local_mcp_tools` | Источник → явная регистрация → реальные схемы |
| MCP-вызовы | `local_mcp_call`, `local_mcp_operation` | Исходный operation ID → вызов → чтение состояния без повторной отправки |
| MCP-ресурсы | `local_mcp_resources`, `local_mcp_read_resource` | Список → точный URI через тот же сервер |
| MCP-подсказки | `local_mcp_prompts`, `local_mcp_get_prompt` | Список → шаблон; содержимое не даёт разрешения на действия |
| Отключение MCP | `local_mcp_disconnect`, `local_mcp_unregister` | Закрыть собственное соединение; при unregister удалить только локальную регистрацию |

## Подтверждения

Для новых вызовов `codex_send_message` передавайте заранее сохранённый `operation_id` (8..128 букв/цифр, `_`, `-`). Он остаётся ключом `codex_delivery_status`, если ответ отправки потерялся. Повтор ID не переисполняет операцию; другой текст или адресат с тем же ID отклоняются. Прежние вызовы без ID поддерживаются. Предел сообщения — **32768 байтов UTF-8**.

`codex_delivery_status` принимает `receipt_id` или `operation_id`; при двух ID проверяется их соответствие. По умолчанию во время занятого dispatch lock возвращается сохранённый этап без IPC. `refresh=false` всегда читает сохранённое состояние, `refresh=true` делает явную живую сверку неизвестной доставки без отправки. Доказанный `not_sent` возвращается из квитанции. `not_found`, отсутствие сообщения в текущем хвосте и пустой composer не дают разрешения повторить неизвестную отправку. Различайте `not_sent`, `unknown`, `delivered` и факт выполнения поручения; подробности — в [контракте Codex](CODEX_CONNECT_COMPATIBILITY.md).

`write_file`, `edit_file`, `move_file`, `process_input`, `terminate_process`, `codex_send_message`, `local_mcp_register`, `local_mcp_call`, `local_mcp_disconnect` и `local_mcp_unregister` требуют `confirm_mutation=true`. `start_process` требует его при `intent=write`.

Все вызовы `local_mcp_call` требуют этого поля, даже если выбранный инструмент описан как читающий: мост не принимает аннотации стороннего MCP за доказательство отсутствия побочных эффектов. Авторизация определяется задачей пользователя; повторное подтверждение пользователя не нужно, когда оно уже дано и охватывает действие.

`local_mcp_tools`, чтение ресурсов и подсказок могут подключиться к серверу и запустить зарегистрированный stdio-процесс. `local_mcp_discover` и `local_mcp_register` не запускают его.

## Терминал PowerShell

Для PowerShell на Windows используется `start_process` с `runtime=native` (или совместимым `runtime=windows`), разрешённым `powershell.exe` или `pwsh.exe` и отдельными аргументами. Содержимое команды должно соответствовать разрешённой задаче. Ввод в интерактивный процесс выполняется через `process_input`; это pipe-based stdin, не полноценный графический терминал и не PTY.

Для Linux-команды внутри настроенного WSL используется `runtime=wsl`; distribution и пользователь берутся из локальной конфигурации. Не передавайте параметры чужого устройства по догадке.

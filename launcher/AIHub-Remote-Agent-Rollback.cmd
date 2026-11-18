@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Rollback.ps1"
exit /b %ERRORLEVEL%

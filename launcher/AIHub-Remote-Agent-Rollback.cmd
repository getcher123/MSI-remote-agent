@echo off
setlocal
rem Prevent inherited PowerShell 7 module paths from breaking Windows PowerShell.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Rollback.ps1"
exit /b %ERRORLEVEL%

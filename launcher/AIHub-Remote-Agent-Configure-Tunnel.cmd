@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Configure-Tunnel.ps1"
exit /b %ERRORLEVEL%

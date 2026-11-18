@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -SourceRoot "%~dp0.."
exit /b %ERRORLEVEL%

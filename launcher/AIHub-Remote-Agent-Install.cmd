@echo off
setlocal
rem Prevent inherited PowerShell 7 module paths from breaking Windows PowerShell.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -SourceRoot "%~dp0.."
exit /b %ERRORLEVEL%

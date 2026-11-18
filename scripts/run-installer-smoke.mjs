import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The installer smoke test requires Windows.');
// A PowerShell 7 -> npm/cmd -> powershell.exe chain otherwise passes PS7 module
// paths to Windows PowerShell 5.1. Let the child construct its own defaults.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
const result = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', fileURLToPath(new URL('./smoke-install.ps1', import.meta.url)),
], { env, stdio: 'inherit', timeout: 60000 });
if (result.error) {
  console.error(`Installer smoke could not complete: ${result.error.code || result.error.name}`);
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;

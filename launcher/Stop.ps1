. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-AIHubRoot
$pidFile = Join-Path $root 'tunnel-client.pid'
$identityFile = Join-Path $root 'tunnel-client-process.json'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No recorded tunnel process. Nothing was stopped.'
    return
}
$pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($pidValue -notmatch '^\d+$') { throw 'Invalid PID file.' }
$proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
if ($proc) {
    if ($proc.ProcessName -ne 'tunnel-client') { throw 'PID now belongs to another process; nothing stopped.' }
    if (-not (Test-Path -LiteralPath $identityFile)) {
        throw 'Legacy PID has no start-time identity. Close the original Start window manually, verify it stopped, then retry. No process was killed.'
    }
    $identity = Get-Content -LiteralPath $identityFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$identity.pid -ne $proc.Id -or $identity.started_utc -ne $proc.StartTime.ToUniversalTime().ToString('o') -or $identity.path -ne $proc.Path) {
        throw 'Tunnel PID/start-time/path mismatch. Nothing stopped.'
    }
    & taskkill.exe /PID $pidValue /T /F | Out-Null
    $result = $LASTEXITCODE
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do { Start-Sleep -Milliseconds 100; $proc.Refresh() } while (-not $proc.HasExited -and [DateTime]::UtcNow -lt $deadline)
    if (-not $proc.HasExited) { throw "Stop was requested but exit is not confirmed (taskkill=$result). PID metadata preserved." }
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $identityFile -Force -ErrorAction SilentlyContinue
Write-Host 'Recorded tunnel process is confirmed absent/exited. WSL detached workloads, if any, require separate checking.'

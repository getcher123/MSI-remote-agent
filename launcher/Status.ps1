. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-AIHubRoot
$currentVersion = Join-Path $root 'current-version.txt'
Write-Host "Root: $root"
if (Test-Path -LiteralPath $currentVersion) { Write-Host "Installed version: $((Get-Content -LiteralPath $currentVersion -Raw).Trim())" } else { Write-Host 'Installed version: not installed' }
try {
    $node = Assert-Node
    Write-Host "Node: $(& $node --version)"
    $current = Get-CurrentRoot
    $env:AIHUB_REMOTE_AGENT_CONFIG = Join-Path $root 'config.json'
    & $node (Join-Path $current 'server\index.mjs') --self-test
}
catch {
    Write-Host "Self-test: FAILED — $($_.Exception.Message)"
}
$client = Get-TunnelClient
if ($client) { Write-Host "tunnel-client: $($client.Source)" } else { Write-Host "tunnel-client: not installed" }
$pidFile = Join-Path $root 'tunnel-client.pid'
if (Test-Path -LiteralPath $pidFile) {
    $pidValue = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $proc = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($proc) { Write-Host "Tunnel: RUNNING PID $pidValue" } else { Write-Host 'Tunnel: stale PID file' }
}
else { Write-Host 'Tunnel: STOPPED' }

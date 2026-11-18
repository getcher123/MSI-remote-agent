. (Join-Path $PSScriptRoot 'Common.ps1')
$node = Assert-Node
$current = Get-CurrentRoot
$null = Assert-Release $current
$server = Join-Path $current 'server\index.mjs'
$config = Join-Path (Get-AIHubRoot) 'config.json'
$env:AIHUB_REMOTE_AGENT_CONFIG = $config

Write-Host 'Running local self-test...'
& $node $server --self-test
if ($LASTEXITCODE -ne 0) { throw 'Local agent self-test failed.' }

$client = Get-TunnelClient
if (-not $client) {
    Write-Host
    Write-Host 'Local MCP agent is healthy, but tunnel-client is not installed.'
    Write-Host 'Install it from OpenAI Platform → Tunnels, configure the tunnel, then run Start again.'
    exit 20
}

$profile = 'aihub-remote-agent'
$key = $env:CONTROL_PLANE_API_KEY
if (-not $key) { $key = Read-PlainSecret 'Restricted OpenAI tunnel runtime API key' }
if (-not $key) { throw 'A runtime API key is required.' }
$env:CONTROL_PLANE_API_KEY = $key
$key = $null

try {
    Write-Host 'Checking Secure MCP Tunnel profile...'
    & $client.Source doctor --profile $profile --explain
    if ($LASTEXITCODE -ne 0) { throw 'tunnel-client doctor failed. Run Configure-Tunnel first.' }

    $root = Get-AIHubRoot
    $pidFile = Join-Path $root 'tunnel-client.pid'
    Write-Host 'Starting AIHub Remote Agent. Close this window or run Stop to disconnect.'
    $process = Start-Process -FilePath $client.Source -ArgumentList @('run','--profile',$profile) -PassThru -NoNewWindow
    Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
    $identityFile = Join-Path $root 'tunnel-client-process.json'
    @{ pid = $process.Id; started_utc = $process.StartTime.ToUniversalTime().ToString('o'); path = $client.Source } | ConvertTo-Json | Set-Content -LiteralPath $identityFile -Encoding UTF8
    try { Wait-Process -Id $process.Id }
    finally { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $identityFile -Force -ErrorAction SilentlyContinue }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw "tunnel-client exited with code $($process.ExitCode)." }
}
finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
}

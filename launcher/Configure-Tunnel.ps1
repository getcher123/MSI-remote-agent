. (Join-Path $PSScriptRoot 'Common.ps1')
$node = Assert-Node
$client = Get-TunnelClient
if (-not $client) {
    throw 'tunnel-client is not installed. Download the supported binary from Platform → Tunnels, then place tunnel-client.exe on PATH.'
}
$current = Get-CurrentRoot
$server = Join-Path $current 'server\index.mjs'
$tunnelId = (Read-Host 'OpenAI tunnel_id').Trim()
if ($tunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') { throw 'Invalid tunnel_id format.' }
$profile = 'aihub-remote-agent'
$mcpCommand = "`"$node`" `"$server`" --stdio"
Write-Host 'Creating/updating local tunnel profile...'
& $client.Source init --sample sample_mcp_stdio_local --profile $profile --tunnel-id $tunnelId --mcp-command $mcpCommand
if ($LASTEXITCODE -ne 0) { throw 'tunnel-client init failed.' }
Write-Host 'Profile configured. Run AIHub-Remote-Agent-Start.cmd.'

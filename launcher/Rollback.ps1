. (Join-Path $PSScriptRoot 'Common.ps1')
$root = Get-AIHubRoot
$currentVersionFile = Join-Path $root 'current-version.txt'
$previousVersionFile = Join-Path $root 'previous-version.txt'
if (-not (Test-Path -LiteralPath $previousVersionFile)) { throw 'No previous version is recorded.' }
$current = (Get-Content -LiteralPath $currentVersionFile -Raw).Trim()
$previous = (Get-Content -LiteralPath $previousVersionFile -Raw).Trim()
$target = Join-Path (Join-Path $root 'releases') $previous
if (-not (Test-Path -LiteralPath $target)) { throw "Previous release is missing: $target" }
$null = Assert-Release $target
& (Join-Path $PSScriptRoot 'Stop.ps1')
Set-CurrentJunction $target
Set-Content -LiteralPath $currentVersionFile -Value $previous -Encoding ASCII
Set-Content -LiteralPath $previousVersionFile -Value $current -Encoding ASCII
Write-Host "Rolled back to $previous. Start the agent and verify Status."

. (Join-Path $PSScriptRoot 'Common.ps1')
$answer = Read-Host 'Remove AIHub Remote Agent, local config, state and release files? Type REMOVE'
if ($answer -ne 'REMOVE') { Write-Host 'Cancelled.'; exit 0 }
# Preserve the installation if ownership or process exit cannot be verified.
& (Join-Path $PSScriptRoot 'Stop.ps1')
$root = Get-AIHubRoot
$link = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AIHub Remote Agent.lnk'
if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
$current = Join-Path $root 'current'
if (Test-Path -LiteralPath $current) {
    $item = Get-Item -LiteralPath $current -Force
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'current is not a junction; installation preserved.' }
    $item.Delete()
}
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
if (Test-Path -LiteralPath $root) { throw 'Removal was not completed.' }
Write-Host 'AIHub Remote Agent removed.'

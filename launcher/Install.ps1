param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [switch]$NoShortcut
)
. (Join-Path $PSScriptRoot 'Common.ps1')

$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$manifest = Assert-Release $SourceRoot
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
Write-Host "Verified AIHub Remote Agent $version"

$root = Get-AIHubRoot
$pidFile = Join-Path $root 'tunnel-client.pid'
if (Test-Path -LiteralPath $pidFile) {
    $oldPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($oldPid -notmatch '^\d+$') { throw 'Invalid tunnel PID metadata. Stop the original launcher before updating.' }
    if (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue) { throw 'A recorded process is still running. Stop the original launcher before updating; no files were switched.' }
}
$releases = Join-Path $root 'releases'
$target = Join-Path $releases $version
New-Item -ItemType Directory -Path $releases -Force | Out-Null
if (Test-Path -LiteralPath $target) {
    $existingManifest = Join-Path $target 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $existingManifest)) { throw "Existing release directory is incomplete: $target" }
    if ((Get-FileHash -LiteralPath $existingManifest -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $SourceRoot 'release-manifest.json') -Algorithm SHA256).Hash) { throw 'A different build with the same version already exists. Use a new version.' }
    $null = Assert-Release $target
    Write-Host 'Existing immutable release reverified.'
}
else {
    $staging = Join-Path $releases ('.install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
        foreach ($entry in $manifest.files) {
            $destination = Join-Path $staging ([string]$entry.path)
            New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $SourceRoot ([string]$entry.path)) -Destination $destination
        }
        Copy-Item -LiteralPath (Join-Path $SourceRoot 'release-manifest.json') -Destination $staging
        $null = Assert-Release $staging
        Move-Item -LiteralPath $staging -Destination $target
    }
    finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force } }
}

$currentVersionFile = Join-Path $root 'current-version.txt'
$previousVersionFile = Join-Path $root 'previous-version.txt'
if (Test-Path -LiteralPath $currentVersionFile) {
    $old = (Get-Content -LiteralPath $currentVersionFile -Raw).Trim()
    if ($old -and $old -ne $version) { Set-Content -LiteralPath $previousVersionFile -Value $old -Encoding ASCII }
}
Set-CurrentJunction $target
Set-Content -LiteralPath $currentVersionFile -Value $version -Encoding ASCII

$configTarget = Join-Path $root 'config.json'
if (-not (Test-Path -LiteralPath $configTarget)) {
    Write-Host 'No private config yet. Run node scripts/configure.mjs --root . from the source checkout, or use the installed configure script with an explicitly chosen project directory.'
    Write-Host 'Until configured, the bundled template grants no filesystem roots and leaves WSL/Codex disabled.'
}

if (-not $NoShortcut) {
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$link = Join-Path $desktop 'AIHub Remote Agent.lnk'
$start = Join-Path (Join-Path $root 'current') 'launcher\AIHub-Remote-Agent-Start.cmd'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $start
$shortcut.WorkingDirectory = (Split-Path $start)
$shortcut.Description = 'Start AIHub Remote Agent Secure MCP Tunnel'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,18"
$shortcut.Save()

}

Write-Host
Write-Host "Installed AIHub Remote Agent $version"
Write-Host "Root: $root"
Write-Host 'Config, tunnel profile and state were preserved. Existing connection: restart Start. New installation: Configure-Tunnel, then Start.'

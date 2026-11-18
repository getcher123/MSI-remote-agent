param([string]$LauncherRoot = (Join-Path $PSScriptRoot '..\launcher'))
$ErrorActionPreference = 'Stop'
$LauncherRoot = (Resolve-Path -LiteralPath $LauncherRoot).Path
$testedVersion = (Get-Content -LiteralPath (Join-Path (Split-Path $LauncherRoot) 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$originalLocalAppData = $env:LOCALAPPDATA
$work = Join-Path ([IO.Path]::GetTempPath()) ('aihub-installer-test-' + [Guid]::NewGuid().ToString('N'))
$checks = @()
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function New-Fixture([string]$Version) {
    $source = Join-Path $work ('source-' + $Version)
    New-Item -ItemType Directory -Path (Join-Path $source 'config') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $source 'launcher') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $source 'config\default-config.json'), '{"fixture":true}')
    [IO.File]::WriteAllText((Join-Path $source 'launcher\AIHub-Remote-Agent-Start.cmd'), '@echo NO_EXECUTION_FIXTURE')
    $files = @('config/default-config.json','launcher/AIHub-Remote-Agent-Start.cmd') | ForEach-Object {
        $file = Get-Item -LiteralPath (Join-Path $source $_)
        @{path=$_;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    @{name='aihub-remote-agent';version=$Version;files=@($files)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $source 'release-manifest.json') -Encoding UTF8
    return $source
}
try {
    New-Item -ItemType Directory -Path $work | Out-Null
    $env:LOCALAPPDATA = Join-Path $work 'isolated-local-app-data'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
    foreach ($script in Get-ChildItem -LiteralPath $LauncherRoot -Filter '*.ps1') {
        $tokens=$null; $errors=$null
        $null = [Management.Automation.Language.Parser]::ParseFile($script.FullName,[ref]$tokens,[ref]$errors)
        Assert-True ($errors.Count -eq 0) ('Parser error in ' + $script.Name)
    }
    $checks += @{name='powershell_parser_all_launchers';pass=$true}
    $one = New-Fixture '0.1.0'; $two = New-Fixture '0.1.1'
    & (Join-Path $LauncherRoot 'Install.ps1') -SourceRoot $one -NoShortcut
    $root = Join-Path $env:LOCALAPPDATA 'AIHubRemoteAgent'
    [IO.File]::WriteAllText((Join-Path $root 'config.json'), '{"custom_setting":"preserve"}')
    New-Item -ItemType Directory -Path (Join-Path $root 'state') | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'state\receipts.json'), '{"preserve":true}')
    & (Join-Path $LauncherRoot 'Install.ps1') -SourceRoot $two -NoShortcut
    Assert-True ((Get-Content (Join-Path $root 'current-version.txt') -Raw).Trim() -eq '0.1.1') 'New version not current'
    Assert-True ((Get-Content (Join-Path $root 'previous-version.txt') -Raw).Trim() -eq '0.1.0') 'Previous version not recorded'
    Assert-True ((Get-Content (Join-Path $root 'config.json') -Raw) -eq '{"custom_setting":"preserve"}') 'Config was overwritten'
    Assert-True ((Get-Content (Join-Path $root 'state\receipts.json') -Raw) -eq '{"preserve":true}') 'State was overwritten'
    $checks += @{name='isolated_install_upgrade_preserves_config_state';pass=$true}
    . (Join-Path $LauncherRoot 'Common.ps1')
    $null = Assert-Release (Join-Path $root 'current')
    $checks += @{name='verify_current_junction';pass=$true}
    & (Join-Path $LauncherRoot 'Rollback.ps1')
    Assert-True ((Get-Content (Join-Path $root 'current-version.txt') -Raw).Trim() -eq '0.1.0') 'Rollback failed'
    $checks += @{name='isolated_rollback';pass=$true}
    & (Join-Path $LauncherRoot 'Install.ps1') -SourceRoot $two -NoShortcut
    $checks += @{name='reapply_same_verified_release';pass=$true}
    [IO.File]::AppendAllText((Join-Path $two 'config\default-config.json'), 'TAMPERED')
    $rejected=$false
    try { & (Join-Path $LauncherRoot 'Install.ps1') -SourceRoot $two -NoShortcut } catch { $rejected=$true }
    Assert-True $rejected 'Tampered source was accepted'
    Assert-True ((Get-Content (Join-Path $root 'current-version.txt') -Raw).Trim() -eq '0.1.1') 'Tampering changed installed release'
    $checks += @{name='tamper_denied_before_switch';pass=$true}
    # Stop must not terminate this test's own PowerShell PID disguised as tunnel metadata.
    Set-Content -LiteralPath (Join-Path $root 'tunnel-client.pid') -Value $PID -Encoding ASCII
    $rejected=$false
    try { & (Join-Path $LauncherRoot 'Stop.ps1') } catch { $rejected=$true }
    Assert-True $rejected 'Wrong process identity accepted'
    # Exercise uninstall's refusal without prompting or touching the real install.
    function Read-Host { param([string]$Prompt) return 'REMOVE' }
    $rejected=$false
    try { & (Join-Path $LauncherRoot 'Uninstall.ps1') } catch { $rejected=$true }
    finally { Remove-Item Function:\Read-Host -ErrorAction SilentlyContinue }
    Assert-True $rejected 'Uninstall continued after an ownership failure'
    Assert-True (Test-Path -LiteralPath (Join-Path $root 'config.json')) 'Uninstall removed configuration despite ownership failure'
    Assert-True (Test-Path -LiteralPath (Join-Path $root 'state\receipts.json')) 'Uninstall removed receipts despite ownership failure'
    $checks += @{name='uninstall_preserves_data_on_stop_failure';pass=$true}
    Remove-Item -LiteralPath (Join-Path $root 'tunnel-client.pid')
    $checks += @{name='stop_wrong_identity_denied';pass=$true}
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    # Remove junction before recursively removing this unique fixture directory.
    $junction=Join-Path $work 'isolated-local-app-data\AIHubRemoteAgent\current'
    if (Test-Path -LiteralPath $junction) { (Get-Item -LiteralPath $junction -Force).Delete() }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
@{version=$testedVersion;at=[DateTime]::UtcNow.ToString('o');checks=$checks;pass=$true;real_install_untouched=$true;no_tunnel_started=$true;no_shortcut_created=$true} | ConvertTo-Json -Depth 6

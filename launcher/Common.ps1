Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AIHubRoot {
    return (Join-Path $env:LOCALAPPDATA 'AIHubRemoteAgent')
}

function Get-CurrentRoot {
    $root = Get-AIHubRoot
    $current = Join-Path $root 'current'
    if (-not (Test-Path -LiteralPath $current)) {
        throw "AIHub Remote Agent is not installed. Run AIHub-Remote-Agent-Install.cmd first."
    }
    return $current
}

function Assert-Node {
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'Node.js 22.12+ is required. Install it from https://nodejs.org/ and open a new terminal.'
    }
    & $node.Source -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
    if ($LASTEXITCODE -ne 0) {
        throw 'Node.js 22.12+ is required.'
    }
    return $node.Source
}

function Get-TunnelClient {
    $cmd = Get-Command tunnel-client.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command tunnel-client -CommandType Application -ErrorAction SilentlyContinue }
    return $cmd
}

function Read-PlainSecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Set-CurrentJunction([string]$Target) {
    $root = Get-AIHubRoot
    $current = Join-Path $root 'current'
    if (Test-Path -LiteralPath $current) {
        $item = Get-Item -LiteralPath $current -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'current is not a junction; refusing to remove it.' }
        $item.Delete()
    }
    New-Item -ItemType Junction -Path $current -Target $Target | Out-Null
}


function Assert-Release([string]$ReleaseRoot) {
    $manifestPath = Join-Path $ReleaseRoot 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'release-manifest.json is missing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $resolved = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\') + '\'
    $seen = @{}
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\/])\.\.([\/]|$)' -or $relative.Contains(':')) { throw 'Unsafe release path.' }
        if ($seen.ContainsKey($relative.ToLowerInvariant())) { throw 'Duplicate release path.' }
        $seen[$relative.ToLowerInvariant()] = $true
        $candidate = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot $relative))
        if (-not $candidate.StartsWith($resolved, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escapes root.' }
        $info = Get-Item -LiteralPath $candidate -Force
        if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release file is not a regular file.' }
        $parent = $info.Directory
        while ($parent -and ($parent.FullName.TrimEnd('\') + '\') -ne $resolved) {
            if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release directory reparse point is forbidden.' }
            $parent = $parent.Parent
        }
        $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne ([string]$entry.sha256).ToLowerInvariant() -or $info.Length -ne [long]$entry.bytes) { throw "Release integrity failure: $relative" }
    }
    return $manifest
}

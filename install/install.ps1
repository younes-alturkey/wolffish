#Requires -Version 5.1
<#
.SYNOPSIS
    Wolffish installer for Windows.
.DESCRIPTION
    Downloads and installs the latest version of Wolffish from releases.wolffi.sh.
.PARAMETER Help
    Show help message.
.PARAMETER Version
    Print the latest available version and exit.
#>
param(
    [switch]$Help,
    [switch]$Version
)

$ErrorActionPreference = "Stop"
$ReleasesBase = "https://releases.wolffi.sh"

# Force TLS 1.2+ for every web call. Older Windows/.NET defaults to TLS 1.0,
# which Cloudflare/R2 reject — and this must run BEFORE the first request
# (the manifest fetch), or the install dies before it starts.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

function Write-Banner {
    Write-Host ""
    Write-Host '  #   # ##### #     ##### ##### ##### ##### #   #' -ForegroundColor Cyan
    Write-Host '  #   # #   # #     #     #       #   #     #   #' -ForegroundColor Cyan
    Write-Host '  # # # #   # #     ####  ####    #   ##### #####' -ForegroundColor Cyan
    Write-Host '  ## ## #   # #     #     #       #       # #   #' -ForegroundColor Cyan
    Write-Host '  #   # ##### ##### #     #     ##### ##### #   #' -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Wolffish Installer" -ForegroundColor White
    Write-Host ""
}

function Write-Info { param([string]$Msg) Write-Host "[i] $Msg" -ForegroundColor Blue }
function Write-Ok { param([string]$Msg) Write-Host "[+] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[!] $Msg" -ForegroundColor Yellow }
function Write-Err { param([string]$Msg) Write-Host "[x] $Msg" -ForegroundColor Red }

function Show-Usage {
    Write-Banner
    Write-Host "Usage: install.ps1 [OPTIONS]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Help       Show this help message"
    Write-Host "  -Version    Print the latest available version and exit"
    Write-Host ""
    Write-Host "Downloads and installs the latest Wolffish for Windows."
}

function Get-Manifest {
    param([string]$Url)
    try {
        $response = Invoke-RestMethod -Uri $Url -UseBasicParsing
        return $response
    } catch {
        throw "Failed to download manifest from ${Url}: $($_.Exception.Message)"
    }
}

function Get-ManifestVersion {
    param([string]$Manifest)
    $match = [regex]::Match($Manifest, '(?m)^version:\s*(.+)$')
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return $null
}

function Get-ManifestUrl {
    param([string]$Manifest, [string]$Extension)
    $match = [regex]::Match($Manifest, "url:\s*(.+\.$Extension)")
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return $null
}

function Get-ManifestSha512 {
    param([string]$Manifest, [string]$Filename)
    $lines = $Manifest -split "`n"
    $inEntry = $false
    foreach ($line in $lines) {
        if ($line -match "url:.*$([regex]::Escape($Filename))") {
            $inEntry = $true
        } elseif ($inEntry -and $line -match "sha512:\s*(.+)") {
            return $Matches[1].Trim()
        } elseif ($inEntry -and $line -match "^\s*-\s") {
            break
        }
    }
    return $null
}

function Test-Checksum {
    param([string]$FilePath, [string]$ExpectedBase64)

    Write-Info "Verifying checksum..."

    $hashObj = Get-FileHash -Path $FilePath -Algorithm SHA512
    $actualHex = $hashObj.Hash.ToLower()

    $expectedBytes = [Convert]::FromBase64String($ExpectedBase64)
    $expectedHex = -join ($expectedBytes | ForEach-Object { $_.ToString("x2") })

    if ($actualHex -ne $expectedHex) {
        throw "Checksum mismatch!`n  Expected: $expectedHex`n  Got:      $actualHex`nThe downloaded file may be corrupted."
    }

    Write-Ok "Checksum verified"
}

function Save-RemoteFile {
    param([string]$Url, [string]$Dest)
    $maxRetries = 5
    for ($i = 1; $i -le $maxRetries; $i++) {
        try {
            $req = [System.Net.HttpWebRequest]([System.Net.WebRequest]::Create($Url))
            $req.UserAgent = "Wolffish-Installer"
            $req.Timeout = 30000
            $req.ReadWriteTimeout = 30000

            # Resume from partial file if a previous attempt was interrupted
            $downloaded = 0L
            if (Test-Path $Dest) {
                $downloaded = (Get-Item $Dest).Length
                if ($downloaded -gt 0) { $req.AddRange($downloaded) }
            }

            $resp = $req.GetResponse()

            # Server ignored Range (200 instead of 206) — start over
            if ($downloaded -gt 0 -and ([System.Net.HttpWebResponse]$resp).StatusCode -ne [System.Net.HttpStatusCode]::PartialContent) {
                $downloaded = 0
            }

            $total = $resp.ContentLength + $downloaded
            $mode = if ($downloaded -gt 0) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
            $stream = $resp.GetResponseStream()
            $file = [System.IO.FileStream]::new($Dest, $mode)
            $buffer = New-Object byte[] 81920
            $lastPct = -1
            try {
                while (($n = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $file.Write($buffer, 0, $n)
                    $downloaded += $n
                    if ($total -gt 0) {
                        $pct = [int](($downloaded * 100) / $total)
                        if ($pct -ne $lastPct) {
                            $lastPct = $pct
                            $doneMB = "{0:N1}" -f ($downloaded / 1MB)
                            $totalMB = "{0:N1}" -f ($total / 1MB)
                            try { Write-Host ("`r    {0}% - {1}/{2} MB   " -f $pct, $doneMB, $totalMB) -NoNewline -ForegroundColor Cyan } catch {}
                        }
                    }
                }
                try { Write-Host "" } catch {}
            } finally {
                $file.Close()
                $stream.Close()
                $resp.Close()
            }
            return
        } catch {
            if ($i -eq $maxRetries) { throw }
            Write-Warn "Download interrupted, retrying ($i/$maxRetries)..."
            Start-Sleep -Seconds (3 * $i)
        }
    }
}

function Install-Wolffish {
    if ($Help) { Show-Usage; return }

    $manifest = Get-Manifest "$ReleasesBase/latest.yml"

    $latestVersion = Get-ManifestVersion $manifest
    if (-not $latestVersion) {
        throw "Could not determine latest version from manifest"
    }

    if ($Version) {
        Write-Host $latestVersion
        return
    }

    Write-Banner
    Write-Ok "Latest version: $latestVersion"

    $relUrl = Get-ManifestUrl $manifest "exe"
    if (-not $relUrl) {
        throw "Could not find .exe download URL in manifest"
    }

    $filename = [System.IO.Path]::GetFileName($relUrl)
    $sha512Base64 = Get-ManifestSha512 $manifest $filename

    $downloadUrl = "$ReleasesBase/$relUrl"
    $tempDir = Join-Path $env:TEMP "wolffish-install"
    $destPath = Join-Path $tempDir $filename

    try {
        if (-not (Test-Path $tempDir)) {
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
        }

        Write-Info "Downloading $downloadUrl ..."
        Save-RemoteFile $downloadUrl $destPath
        Write-Ok "Download complete"

        if ($sha512Base64) {
            Test-Checksum $destPath $sha512Base64
        } else {
            Write-Warn "No checksum found in manifest - skipping verification"
        }

        Write-Info "Running installer..."
        $process = Start-Process -FilePath $destPath -ArgumentList "/S" -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "Installer exited with code $($process.ExitCode)"
        }

        Write-Ok "Wolffish v$latestVersion installed successfully!"
        Write-Host ""
        Add-WolffishCliPath
    } finally {
        if (Test-Path $tempDir) {
            Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
        }
    }
}

# The `wolffish.cmd` shim is written by the app on first launch (idempotent,
# and it must be re-pointed after each update, so the app owns it). All this
# does is make sure its folder is on the user's PATH — a per-user setx, so no
# elevation and no effect on other accounts.
function Add-WolffishCliPath {
    $binDir = Join-Path $env:USERPROFILE ".wolffish\bin"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -and ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
        Write-Info "The 'wolffish' command will be available after the first launch."
        return
    }
    try {
        $updated = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
        [Environment]::SetEnvironmentVariable("Path", $updated, "User")
        Write-Ok "Added $binDir to your PATH."
        Write-Info "Open a new terminal, then run: wolffish status"
    } catch {
        Write-Err "Could not update PATH automatically. Add this folder yourself: $binDir"
    }
}

try {
    Install-Wolffish
} catch {
    Write-Err $_.Exception.Message
}

Write-Host ""
Read-Host "Press Enter to exit"

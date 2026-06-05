# Build the Windows installer and publish it to GitHub Releases.
# Run this ON WINDOWS (PowerShell):   powershell -ExecutionPolicy Bypass -File scripts\release-win.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# get a GitHub token
function Get-GhToken {
  $candidates = @("gh", "C:\Program Files\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\gh.exe")
  foreach ($c in $candidates) {
    try { $t = (& $c auth token 2>$null).Trim(); if ($t) { return $t } } catch {}
  }
  return $env:GH_TOKEN
}
$env:GH_TOKEN = Get-GhToken
if (-not $env:GH_TOKEN) {
  Write-Host "محتاج GH_TOKEN. اعمل: gh auth login   (أو) `$env:GH_TOKEN='ghp_xxx'"
  exit 1
}

$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
Write-Host "==> npm install"
npm install
Write-Host "==> building + publishing Windows"
npx electron-builder --win --publish always
Write-Host "✅ تم بناء ورفع نسخة ويندوز على GitHub Releases. كل المستخدمين هيتحدّثوا تلقائياً."

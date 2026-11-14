[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$CodexPath,
  [string]$CodexHome = $env:CODEX_HOME,
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'TabFlowNativeHost')
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$bridgePath = (Resolve-Path (Join-Path $PSScriptRoot 'native-bridge.mjs')).Path
if (!$NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
if (!$CodexPath) {
  $npmRoot = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex'
  $archName = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $triple = if ($archName -eq 'arm64') { 'aarch64' } else { 'x86_64' }
  $native = Join-Path $npmRoot "node_modules\@openai\codex-win32-$archName\vendor\$triple-pc-windows-msvc\bin\codex.exe"
  if (Test-Path -LiteralPath $native) { $CodexPath = $native }
  else { $CodexPath = Join-Path $npmRoot 'bin\codex.js' }
}
$CodexPath = (Resolve-Path -LiteralPath $CodexPath).Path
if ([IO.Path]::GetExtension($CodexPath) -notin @('.exe', '.js', '.mjs')) { throw 'CodexPath must identify the official native executable or Node CLI entry, not a shell wrapper.' }
if (!$CodexHome) { $CodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'User') }
if ($CodexHome) { $CodexHome = (Resolve-Path -LiteralPath $CodexHome).Path }
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$publicManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'public\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$publicManifest.key) { throw 'public manifest.key is required to derive a stable Chrome extension ID.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash([Convert]::FromBase64String($publicManifest.key)) } finally { $sha.Dispose() }
$hex = -join ($hash[0..15] | ForEach-Object { $_.ToString('x2') })
$extensionId = -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_, 16)) })
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$launcher = Join-Path $InstallDirectory 'tabflow-codex-bridge.cmd'
$manifestPath = Join-Path $InstallDirectory 'com.tabflow.codex_bridge.json'
function CmdValue([string]$value) {
  if ($value -match '[\r\n"]') { throw 'Launcher paths cannot contain quotes or line breaks.' }
  return $value.Replace('%', '%%')
}
$codexVariable = if ([IO.Path]::GetExtension($CodexPath) -eq '.exe') { 'TABFLOW_CODEX_EXECUTABLE' } else { 'TABFLOW_CODEX_CLI' }
$lines = @('@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion', 'set "TABFLOW_CODEX_EXECUTABLE="', 'set "TABFLOW_CODEX_CLI="', "set `"$codexVariable=$(CmdValue $CodexPath)`"")
if ($CodexHome) { $lines += "set `"CODEX_HOME=$(CmdValue $CodexHome)`"" }
$lines += "`"$(CmdValue $NodePath)`" `"$(CmdValue $bridgePath)`""
$lines += 'exit /b %errorlevel%'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", $utf8)
$nativeManifest = [ordered]@{
  name = 'com.tabflow.codex_bridge'
  description = 'TabFlow official Codex app-server stdio bridge'
  path = $launcher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
[IO.File]::WriteAllText($manifestPath, ($nativeManifest | ConvertTo-Json -Depth 4), $utf8)
# Both registry views support 32-bit and 64-bit Chrome, without elevation.
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
  try {
    $key = $base.CreateSubKey('Software\Google\Chrome\NativeMessagingHosts\com.tabflow.codex_bridge')
    try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
[pscustomobject]@{ installed = $true; hostName = 'com.tabflow.codex_bridge'; extensionId = $extensionId; manifest = $manifestPath; launcher = $launcher; node = $NodePath; codex = $CodexPath; customCodexHome = [bool]$CodexHome } | ConvertTo-Json

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$NodePath,
  [string]$CodexPath,
  [string]$CodexHome = $env:CODEX_HOME,
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'TabFlowNativeHost'),
  [ValidateNotNullOrEmpty()]
  [ValidateScript({ if ($_ -cmatch '\A[a-p]{32}\z') { $true } else { throw 'ExtensionId must be exactly 32 lowercase letters a-p.' } })]
  [string]$ExtensionId
)
$ErrorActionPreference = 'Stop'

# Pure helper: usable without resolving executables or installing the native host.
function Get-TabFlowExtensionId {
  param([string]$PublicKey, [string]$ExtensionId)
  if ($PSBoundParameters.ContainsKey('ExtensionId')) {
    if ($ExtensionId -cnotmatch '\A[a-p]{32}\z') { throw 'ExtensionId must be exactly 32 lowercase letters a-p.' }
    return $ExtensionId
  }
  if (!$PublicKey) { throw 'public manifest.key is required to derive a stable Chrome extension ID.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash([Convert]::FromBase64String($PublicKey)) } finally { $sha.Dispose() }
  $hex = -join ($hash[0..15] | ForEach-Object { $_.ToString('x2') })
  return -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32([string]$_, 16)) })
}

function CmdValue([string]$value) {
  if ($value -match '[\r\n"]') { throw 'Launcher paths cannot contain quotes or line breaks.' }
  return $value.Replace('%', '%%')
}

function Install-TabFlowBridge {
  param([string]$SourceDirectory, [string]$InstallDirectory)
  $files = @('native-bridge.mjs', 'codex-app-server.mjs')
  $downloadDirectory = $null
  try {
    $hasLocalBridge = $SourceDirectory -and (@($files | Where-Object { !(Test-Path -LiteralPath (Join-Path $SourceDirectory $_) -PathType Leaf) }).Count -eq 0)
    if (!$hasLocalBridge) {
      $downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('tabflow-native-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $ref = if ($env:TABFLOW_REF) { $env:TABFLOW_REF } else { 'main' }
      foreach ($file in $files) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/deskid/tabflow/$ref/scripts/$file" -OutFile (Join-Path $downloadDirectory $file)
      }
      $SourceDirectory = $downloadDirectory
    }
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    foreach ($file in $files) {
      $source = [IO.Path]::GetFullPath((Join-Path $SourceDirectory $file))
      $destination = [IO.Path]::GetFullPath((Join-Path $InstallDirectory $file))
      if ($source -ine $destination) { Copy-Item -LiteralPath $source -Destination $destination -Force }
    }
  } finally {
    if ($downloadDirectory) { Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

$repoRoot = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { $null }
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
$bridgePath = Join-Path $InstallDirectory 'native-bridge.mjs'
if ($PSBoundParameters.ContainsKey('ExtensionId')) {
  $resolvedExtensionId = Get-TabFlowExtensionId -ExtensionId $ExtensionId
} else {
  $publicManifestPath = if ($repoRoot) { Join-Path $repoRoot 'public\manifest.json' } else { $null }
  if ($publicManifestPath -and (Test-Path -LiteralPath $publicManifestPath -PathType Leaf)) {
    $publicManifest = Get-Content -LiteralPath $publicManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $resolvedExtensionId = Get-TabFlowExtensionId -PublicKey $publicManifest.key
  } else {
    $resolvedExtensionId = Get-TabFlowExtensionId -ExtensionId 'pnjgkehmcfheoecnhenfeidkpkdjifkm'
  }
}
$launcher = Join-Path $InstallDirectory 'tabflow-codex-bridge.cmd'
$manifestPath = Join-Path $InstallDirectory 'com.tabflow.codex_bridge.json'
$codexVariable = if ([IO.Path]::GetExtension($CodexPath) -eq '.exe') { 'TABFLOW_CODEX_EXECUTABLE' } else { 'TABFLOW_CODEX_CLI' }
$lines = @('@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion', 'set "TABFLOW_CODEX_EXECUTABLE="', 'set "TABFLOW_CODEX_CLI="', "set `"$codexVariable=$(CmdValue $CodexPath)`"")
if ($CodexHome) { $lines += "set `"CODEX_HOME=$(CmdValue $CodexHome)`"" }
$lines += "`"$(CmdValue $NodePath)`" `"$(CmdValue $bridgePath)`""
$lines += 'exit /b %errorlevel%'
$launcherContent = ($lines -join "`r`n") + "`r`n"
$nativeManifest = [ordered]@{
  name = 'com.tabflow.codex_bridge'
  description = 'TabFlow official Codex app-server stdio bridge'
  path = $launcher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$resolvedExtensionId/")
}
$installed = $false
if ($PSCmdlet.ShouldProcess($InstallDirectory, 'Copy or download bridge scripts, write native host launcher and manifest, and register Chrome native messaging host in both HKCU registry views')) {
  Install-TabFlowBridge -SourceDirectory $PSScriptRoot -InstallDirectory $InstallDirectory
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($launcher, $launcherContent, $utf8)
  [IO.File]::WriteAllText($manifestPath, ($nativeManifest | ConvertTo-Json -Depth 4), $utf8)
  # Both registry views support 32-bit and 64-bit Chrome, without elevation.
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
      $key = $base.CreateSubKey('Software\Google\Chrome\NativeMessagingHosts\com.tabflow.codex_bridge')
      try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
    } finally { $base.Dispose() }
  }
  $installed = $true
}
[pscustomobject]@{
  installed = $installed
  hostName = 'com.tabflow.codex_bridge'
  extensionId = $resolvedExtensionId
  manifest = $manifestPath
  launcher = $launcher
  bridge = $bridgePath
  node = $NodePath
  codex = $CodexPath
  customCodexHome = [bool]$CodexHome
  manifestContent = $nativeManifest
  launcherContent = $launcherContent
} | ConvertTo-Json -Depth 5

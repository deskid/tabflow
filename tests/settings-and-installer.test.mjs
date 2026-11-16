import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { getNativeInstallCommand } from '../src/services/nativeCodexSetup.ts';

const sourceURL = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const providerURL = sourceURL(await readFile(new URL('../src/services/providerSettings.ts', import.meta.url), 'utf8'));
const store = await import(sourceURL((await readFile(new URL('../src/services/settingsStore.ts', import.meta.url), 'utf8'))
  .replace("'./providerSettings'", JSON.stringify(providerURL))));
const builtinURL = sourceURL(`
export function classifyWithBuiltinModel() { throw new Error('Built-in model must not run'); }
export function getBuiltinModelState() { throw new Error('Built-in model must not run'); }
`);
const grouper = await import(sourceURL((await readFile(new URL('../src/services/aiGrouper.ts', import.meta.url), 'utf8'))
  .replace("'./builtinModel'", JSON.stringify(builtinURL))));

test('fresh and partial settings select local heuristic without altering general preferences', () => {
  assert.equal(store.DEFAULT_SETTINGS.aiSettings.provider, 'heuristic');
  assert.equal(store.normalizeSettings().aiSettings.provider, 'heuristic');
  const saved = { theme: 'dark', density: 'compact', autoGroupNewTabs: false, showFavicon: false, showDuplicateCount: false };
  const original = structuredClone(saved);
  const normalized = store.normalizeSettings(saved);
  for (const [key, value] of Object.entries(saved)) assert.equal(normalized[key], value);
  assert.equal(normalized.aiSettings.provider, 'heuristic');
  assert.deepEqual(saved, original);
});

test('saved provider, model and independent profiles survive defaults and provider switching', () => {
  for (const provider of ['codex_native', 'heuristic', 'chrome_builtin', 'openai', 'deepseek', 'custom']) {
    const active = { provider, model: `saved-${provider}`, apiKey: 'synthetic-active', apiEndpoint: 'https://example.invalid/v1', customPrompt: 'saved prompt' };
    const other = provider === 'custom' ? 'openai' : 'custom';
    const saved = { theme: 'light', aiSettings: active, aiProfiles: {
      [provider]: { model: 'stale snapshot', apiKey: '', apiEndpoint: '' },
      [other]: { model: 'independent model', apiKey: 'synthetic-other', apiEndpoint: 'https://other.invalid/v1' },
    } };
    const original = structuredClone(saved);
    const normalized = store.normalizeSettings(saved);
    assert.deepEqual(normalized.aiSettings, active);
    assert.deepEqual(normalized.aiProfiles[other], saved.aiProfiles[other]);
    assert.equal(normalized.aiProfiles[provider].model, active.model);
    const switched = store.applySettingsPatch(normalized, { action: 'UPDATE_AI_SETTINGS', patch: { provider: other } });
    assert.equal(switched.aiSettings.model, 'independent model');
    const restored = store.applySettingsPatch(switched, { action: 'UPDATE_AI_SETTINGS', patch: { provider } });
    assert.deepEqual(restored.aiSettings, active);
    assert.deepEqual(saved, original);
  }
});

test('default grouping produces local groups without native host, model or API access', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.chrome = new Proxy({}, { get() { assert.fail('Local grouping must not call Chrome/native APIs'); } });
  globalThis.fetch = () => assert.fail('Local grouping must not access network APIs');
  try {
    const plan = await grouper.planGroupingWithFallback([
      { id: 1, title: 'TypeScript code', url: 'https://github.com/example/project', groupId: -1 },
      { id: 2, title: 'Python documentation', url: 'https://developer.mozilla.org/docs', groupId: -1 },
    ], store.normalizeSettings().aiSettings);
    assert.equal(plan.provider, 'heuristic');
    assert.equal(plan.method, 'local-rules');
    assert.equal(plan.fallbackReason, undefined);
    assert.equal(plan.groups.length, 1);
    assert.deepEqual(plan.groups[0].tabIds, [1, 2]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

const installer = fileURLToPath(new URL('../scripts/install-native-host.ps1', import.meta.url));
const powershellExecutable = process.env.TABFLOW_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : undefined);
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
function powershell(source) {
  const result = spawnSync(powershellExecutable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // Windows PowerShell 5.1 writes ShouldProcess WhatIf messages to stdout.
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
const deriveId = (key) => [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const explicitId = 'abcdefghijklmnopabcdefghijklmnop';

test('Windows setup downloads its installer and binds the current extension without a repository', () => {
  for (const id of [explicitId, undefined, '']) {
    const command = getNativeInstallCommand('Windows NT 10.0; Win64; x64', id);
    assert.ok(command.includes('https://raw.githubusercontent.com/deskid/tabflow/main/scripts/install-native-host.ps1'));
    assert.ok(command.includes(`-ExtensionId ${id || 'pnjgkehmcfheoecnhenfeidkpkdjifkm'}`));
    assert.ok(!command.includes('.\\scripts\\'));
  }
  assert.equal(getNativeInstallCommand('Macintosh; Intel Mac OS X'), 'curl -fsSL https://raw.githubusercontent.com/deskid/tabflow/main/scripts/install-native-host.sh | bash');
  assert.ok(getNativeInstallCommand('Macintosh; Intel Mac OS X', explicitId).endsWith(`bash -s -- ${explicitId}`));
});

test('PowerShell AST helper validates IDs strictly and derives ID from actual public key', { skip: !powershellExecutable }, () => {
  const invalid = ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'q'.repeat(32), `${'a'.repeat(32)}\n`, ` ${'a'.repeat(32)}`];
  const result = powershell(`
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psQuote(installer)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer syntax errors' }
$helper = $ast.Find({ param($entry) $entry -is [Management.Automation.Language.FunctionDefinitionAst] -and $entry.Name -eq 'Get-TabFlowExtensionId' }, $true)
if (!$helper) { throw 'Missing pure helper' }
. ([scriptblock]::Create($helper.Extent.Text))
$invalidIds = ConvertFrom-Json ${psQuote(JSON.stringify(invalid))}
$rejected = @($invalidIds | ForEach-Object {
  try { $null = Get-TabFlowExtensionId -ExtensionId $_; $false } catch { $true }
})
$missingKeyRejected = $false
try { $null = Get-TabFlowExtensionId } catch { $missingKeyRejected = $true }
[pscustomobject]@{
  explicit = Get-TabFlowExtensionId -ExtensionId ${psQuote(explicitId)} -PublicKey 'not base64'
  derived = Get-TabFlowExtensionId -PublicKey ${psQuote(manifest.key)}
  rejected = $rejected
  missingKeyRejected = $missingKeyRejected
} | ConvertTo-Json -Compress
`);
  assert.equal(result.explicit, explicitId);
  assert.equal(result.derived, deriveId(manifest.key));
  assert.deepEqual(result.rejected, invalid.map(() => true));
  assert.equal(result.missingKeyRejected, true);
});

test('PowerShell WhatIf plans source and standalone installs without downloads, writes or CLI execution', { skip: !powershellExecutable }, async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'tabflow-settings-installer-')));
  const dummyCLI = path.join(temporary, 'harmless.js');
  const marker = path.join(temporary, 'cli-executed');
  const standaloneInstaller = path.join(temporary, 'install-native-host.ps1');
  await writeFile(dummyCLI, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution');\n`);
  await writeFile(standaloneInstaller, await readFile(installer));
  try {
    const result = powershell(`
$ErrorActionPreference = 'Stop'
if (!$env:LOCALAPPDATA) { $env:LOCALAPPDATA = ${psQuote(temporary)} }
function Invoke-WebRequest { throw 'WhatIf must not download bridge files' }
function Read-HostRegistry {
  if ($env:OS -ne 'Windows_NT') { return $null }
  $snapshot = @()
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
      $key = $base.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts\\com.tabflow.codex_bridge', $false)
      try {
        $values = @()
        if ($key) { $values = @($key.GetValueNames() | Sort-Object | ForEach-Object { [pscustomobject]@{ name = $_; kind = [string]$key.GetValueKind($_); value = $key.GetValue($_) } }) }
        $snapshot += [pscustomobject]@{ view = [string]$view; exists = [bool]$key; values = $values }
      } finally { if ($key) { $key.Dispose() } }
    } finally { $base.Dispose() }
  }
  return ConvertTo-Json -InputObject $snapshot -Depth 6 -Compress
}
$before = Read-HostRegistry
$plans = @()
foreach ($mode in @('explicit', 'derived', 'standalone', 'streamed', 'standalone-default', 'streamed-default')) {
  $target = Join-Path ${psQuote(temporary)} $mode
  $arguments = @{ NodePath = ${psQuote(process.execPath)}; CodexPath = ${psQuote(dummyCLI)}; CodexHome = ${psQuote(temporary)}; InstallDirectory = $target; WhatIf = $true }
  if ($mode -notin @('derived', 'standalone-default', 'streamed-default')) { $arguments.ExtensionId = ${psQuote(explicitId)} }
  $scriptPath = if ($mode -like 'streamed*') { [scriptblock]::Create([IO.File]::ReadAllText(${psQuote(installer)})) }
    elseif ($mode -like 'standalone*') { ${psQuote(standaloneInstaller)} } else { ${psQuote(installer)} }
  $plan = (& $scriptPath @arguments 6>$null) | ConvertFrom-Json
  $plans += [pscustomobject]@{ mode = $mode; directoryExists = Test-Path -LiteralPath $target; plan = $plan }
}
$bindingRejected = @()
foreach ($invalid in @('', ('A' * 32), ('q' * 32), ('a' * 31), (('a' * 32) + [char]10))) {
  try { $null = & ${psQuote(installer)} -ExtensionId $invalid -WhatIf 6>$null; $bindingRejected += $false } catch { $bindingRejected += $true }
}
[pscustomobject]@{ plans = $plans; registryUnchanged = ($before -ceq (Read-HostRegistry)); bindingRejected = $bindingRejected } | ConvertTo-Json -Depth 10 -Compress
`);
    assert.equal(result.registryUnchanged, true);
    assert.deepEqual(result.bindingRejected, [true, true, true, true, true]);
    for (const { mode, directoryExists, plan } of result.plans) {
      const id = mode === 'derived' ? deriveId(manifest.key) : mode.endsWith('-default') ? 'pnjgkehmcfheoecnhenfeidkpkdjifkm' : explicitId;
      assert.equal(directoryExists, false);
      assert.equal(plan.installed, false);
      assert.equal(plan.extensionId, id);
      assert.deepEqual(plan.manifestContent.allowed_origins, [`chrome-extension://${id}/`]);
      assert.equal(plan.manifestContent.path, plan.launcher);
      assert.equal(plan.node, process.execPath);
      assert.equal(plan.codex, dummyCLI);
      assert.equal(path.dirname(plan.manifest), path.join(temporary, mode));
      assert.equal(path.dirname(plan.launcher), path.join(temporary, mode));
      assert.equal(plan.bridge, path.join(temporary, mode, 'native-bridge.mjs'));
      assert.ok(plan.launcherContent.includes(plan.bridge));
      assert.ok(plan.launcherContent.includes(dummyCLI));
      assert.ok(plan.launcherContent.includes(process.execPath));
    }
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    // This is the unique temporary directory created by this test.
    await rm(temporary, { recursive: true, force: true });
  }
});

function loadInstallerFunction(name) {
  return `
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psQuote(installer)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer syntax errors' }
$helper = $ast.Find({ param($entry) $entry -is [Management.Automation.Language.FunctionDefinitionAst] -and $entry.Name -eq ${psQuote(name)} }, $true)
if (!$helper) { throw 'Missing installer function' }
. ([scriptblock]::Create($helper.Extent.Text))
`;
}

test('installed bridge runs after the source directory is deleted and can be installed in place', { skip: !powershellExecutable }, async () => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'tabflow native copy ')));
  const sourceDirectory = path.join(temporary, 'source files');
  const installDirectory = path.join(temporary, 'installed files');
  try {
    await mkdir(sourceDirectory);
    for (const file of ['native-bridge.mjs', 'codex-app-server.mjs']) {
      await writeFile(path.join(sourceDirectory, file), await readFile(new URL(`../scripts/${file}`, import.meta.url)));
    }
    powershell(`
$ErrorActionPreference = 'Stop'
${loadInstallerFunction('Install-TabFlowBridge')}
function Invoke-WebRequest { throw 'Local installation must not access the network' }
Install-TabFlowBridge -SourceDirectory ${psQuote(sourceDirectory)} -InstallDirectory ${psQuote(installDirectory)}
Install-TabFlowBridge -SourceDirectory ${psQuote(installDirectory)} -InstallDirectory ${psQuote(installDirectory)}
@{ copied = $true } | ConvertTo-Json -Compress
`);
    await rm(sourceDirectory, { recursive: true });
    const body = Buffer.from(JSON.stringify({ action: 'PING' }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    const result = spawnSync(process.execPath, [path.join(installDirectory, 'native-bridge.mjs')], {
      cwd: temporary, input: Buffer.concat([header, body]), timeout: 10000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.ok(result.stdout.length >= 4, 'Installed bridge must reply to PING');
    assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
    const response = JSON.parse(result.stdout.subarray(4));
    assert.equal(response.success, true);
    assert.equal(response.type, 'PONG');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('standalone bridge download keeps an existing installation when a dependency fails', { skip: !powershellExecutable }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tabflow native download '));
  const installDirectory = path.join(temporary, 'installed');
  try {
    await mkdir(installDirectory);
    for (const file of ['native-bridge.mjs', 'codex-app-server.mjs']) await writeFile(path.join(installDirectory, file), 'previous version');
    const result = powershell(`
$ErrorActionPreference = 'Stop'
${loadInstallerFunction('Install-TabFlowBridge')}
$script:failDownload = $true
$script:downloads = @()
$env:TABFLOW_REF = 'test-fixture'
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  $script:downloads += [pscustomobject]@{ uri = $Uri; path = $OutFile }
  if ($script:failDownload -and $Uri.EndsWith('/codex-app-server.mjs')) { throw 'Simulated download failure' }
  [IO.File]::WriteAllText($OutFile, 'downloaded ' + ($Uri.Split('/')[-1]))
}
$failed = $false
try { Install-TabFlowBridge -SourceDirectory '' -InstallDirectory ${psQuote(installDirectory)} } catch { $failed = $true }
$previousPreserved = @('native-bridge.mjs', 'codex-app-server.mjs' | ForEach-Object {
  [IO.File]::ReadAllText((Join-Path ${psQuote(installDirectory)} $_)) -eq 'previous version'
})
$script:failDownload = $false
Install-TabFlowBridge -SourceDirectory ${psQuote(temporary)} -InstallDirectory ${psQuote(installDirectory)}
@{ failed = $failed; previousPreserved = $previousPreserved; downloads = $script:downloads;
  stagingRemoved = @($script:downloads | ForEach-Object { !(Test-Path -LiteralPath (Split-Path $_.path -Parent)) }) } | ConvertTo-Json -Depth 4 -Compress
`);
    assert.equal(result.failed, true);
    assert.deepEqual(result.previousPreserved, [true, true]);
    assert.deepEqual(result.stagingRemoved, [true, true, true, true]);
    assert.deepEqual(result.downloads.map(({ uri }) => uri), [0, 1, 0, 1].map((index) => `https://raw.githubusercontent.com/deskid/tabflow/test-fixture/scripts/${index ? 'codex-app-server.mjs' : 'native-bridge.mjs'}`));
    for (const file of ['native-bridge.mjs', 'codex-app-server.mjs']) assert.equal(await readFile(path.join(installDirectory, file), 'utf8'), `downloaded ${file}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('copied Windows command runs the downloaded installer without a local script and surfaces failures', { skip: !powershellExecutable }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tabflow bootstrap '));
  const marker = path.join(temporary, 'installed-id');
  try {
    const result = powershell(`
$ErrorActionPreference = 'Stop'
$script:downloads = 0
$script:failDownload = $false
$script:installerContent = ${psQuote(`param([string]$ExtensionId)\n[IO.File]::WriteAllText(${psQuote(marker)}, $ExtensionId)`)}
function Invoke-WebRequest {
  [CmdletBinding()]
  param([switch]$UseBasicParsing, [string]$Uri)
  if ($Uri -ne 'https://raw.githubusercontent.com/deskid/tabflow/main/scripts/install-native-host.ps1') { throw 'Wrong installer URL' }
  $script:downloads++
  if ($script:failDownload) { throw 'Simulated download failure' }
  [pscustomobject]@{ Content = $script:installerContent }
}
Push-Location ${psQuote(temporary)}
try {
  ${getNativeInstallCommand('Windows NT 10.0', explicitId)}
  $script:installerContent = "throw 'Simulated installer failure'"
  $failed = $false
  try { ${getNativeInstallCommand('Windows NT 10.0', explicitId)} } catch { $failed = $true }
  $script:failDownload = $true
  $downloadFailed = $false
  try { ${getNativeInstallCommand('Windows NT 10.0', explicitId)} } catch { $downloadFailed = $true }
} finally { Pop-Location }
@{ failed = $failed; downloadFailed = $downloadFailed; downloads = $script:downloads;
  installedId = [IO.File]::ReadAllText(${psQuote(marker)});
  files = @(Get-ChildItem -LiteralPath ${psQuote(temporary)} | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress
`);
    assert.equal(result.installedId, explicitId);
    assert.equal(result.failed, true);
    assert.equal(result.downloadFailed, true);
    assert.equal(result.downloads, 3);
    assert.deepEqual(result.files, ['installed-id']);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

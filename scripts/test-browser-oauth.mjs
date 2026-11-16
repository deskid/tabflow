import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const root = process.cwd();
const runDirectory = path.join(root, 'artifacts', `browser-smoke-${Date.now()}`);
const RULE_ID = 987654321;
const AUTH_URL = 'https://auth.openai.com/tabflow-browser-test';
const MOCK_CODE = 'TEST_ONLY_CODE';
const MOCK_STATE = 'TEST_ONLY_STATE';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function chromeCommandHint() {
  return process.platform === 'win32'
    ? '$env:TABFLOW_CHROME_BIN = "C:\\path\\to\\chrome.exe"; pnpm test:browser'
    : 'TABFLOW_CHROME_BIN="/path/to/google-chrome" pnpm test:browser';
}

async function findChrome() {
  const candidates = [];
  if (process.env.TABFLOW_CHROME_BIN) {
    candidates.push(process.env.TABFLOW_CHROME_BIN);
  } else if (process.platform === 'win32') {
    for (const directory of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (directory) candidates.push(path.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
    }
    candidates.push('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(directory, 'google-chrome'), path.join(directory, 'chromium'));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Try the next executable location; never inspect an existing profile. */ }
  }
  throw new Error(`Chrome executable unavailable. Set its absolute path and retry:\n${chromeCommandHint()}`);
}

async function prepareFixture() {
  const extensionDirectory = path.join(runDirectory, 'extension');
  await mkdir(runDirectory, { recursive: true });
  try {
    await cp(path.join(root, 'dist'), extensionDirectory, { recursive: true });
  } catch (cause) {
    throw new Error('Cannot copy the built extension. Run "pnpm build" before "pnpm test:browser".', { cause });
  }
  const manifestPath = path.join(extensionDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Only this isolated fixture pre-grants optional origins. Production asks on sign-in.
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []),
    'http://127.0.0.1/*', 'https://auth.openai.com/*', 'https://api.openai.com/*'])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return extensionDirectory;
}

async function reserveDebugPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function connectToChrome(port, getLaunchError) {
  const version = await waitFor(async () => {
    if (getLaunchError()) throw getLaunchError();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok ? await response.json() : undefined;
    } catch { return undefined; }
  }, 'Chrome debugging endpoint (use a recent Chrome supporting Extensions.loadUnpacked)');
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Chrome debugging WebSocket connection timed out.'));
    }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Chrome debugging WebSocket connection failed.'));
    }, { once: true });
  });
  return { socket, version };
}

function createCDP(socket) {
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  let eventError;

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  socket.addEventListener('close', () => rejectPending(new Error('Chrome debugging WebSocket closed.')));
  socket.addEventListener('error', () => rejectPending(new Error('Chrome debugging WebSocket failed.')));
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`));
        else request.resolve(message.result);
      } else {
        for (const listener of listeners.get(message.method) ?? []) {
          Promise.resolve().then(() => listener(message.params, message.sessionId))
            .catch((error) => { eventError = error; });
        }
      }
    } catch (error) { eventError = error; }
  });

  return {
    async send(method, params = {}, sessionId, timeout = 10_000) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error(`Cannot send ${method}: Chrome connection closed.`);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeout} ms.`));
        }, timeout);
        pending.set(id, { method, timer, resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    checkEvents() { if (eventError) throw eventError; },
    dispose() {
      rejectPending(new Error('Chrome debugging client disposed.'));
      socket.close();
    },
  };
}

function evaluator(cdp, sessionId) {
  return async (expression) => {
    cdp.checkEvents();
    const result = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    }
    return result.result.value;
  };
}

async function capture(cdp, sessionId, filename) {
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
  }, sessionId);
  await writeFile(path.join(runDirectory, filename), Buffer.from(screenshot.data, 'base64'));
}

async function renderSubscriptionUI(cdp, extensionId) {
  const target = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const evaluate = evaluator(cdp, sessionId);
  await waitFor(() => evaluate('Boolean(document.querySelector("select"))'), 'extension settings UI');
  const options = await evaluate(`Array.from(document.querySelectorAll('select option'))
    .map(option => ({ value: option.value, text: option.textContent }))`);
  assert(options.some((option) => option.value === 'chatgpt_plan'), 'Subscription provider missing from UI.');
  await evaluate(`(() => {
    const select = Array.from(document.querySelectorAll('select'))
      .find(element => Array.from(element.options).some(option => option.value === 'chatgpt_plan'));
    select.value = 'chatgpt_plan';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate('document.body.innerText.includes("Continue with ChatGPT")'), 'ChatGPT sign-in button');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 1000, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await capture(cdp, sessionId, 'subscription-ui.png');
  console.log('Subscription provider and Continue with ChatGPT button rendered.');
  return { evaluate, options };
}

async function testPackagedCourier(cdp, evaluate) {
  // Install a synthetic rule, not a real OAuth attempt. Never navigate another tab
  // to the loopback URL: an unrelated local CLI listener may already own that port.
  const fixture = await evaluate(`(async () => {
    globalThis.__courier = [];
    chrome.runtime.onConnect.addListener(port => {
      if (port.name !== 'tabflow-chatgpt-plan-oauth-v1') return;
      port.onMessage.addListener(message => {
        globalThis.__courier.push({ message, sender: port.sender });
        port.postMessage({ ok: true });
      });
    });
    const tab = await chrome.tabs.create({ url: 'about:blank#tabflow-oauth-smoke' });
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
      id: ${RULE_ID}, priority: 1,
      action: { type: 'redirect', redirect: {
        regexSubstitution: chrome.runtime.getURL('oauth-callback.html') + '\\\\1'
      } },
      condition: {
        regexFilter: '^http://127[.]0[.]0[.]1:1455/auth/callback([?].*)?$',
        tabIds: [tab.id], resourceTypes: ['main_frame']
      }
    }] });
    return { tabId: tab.id, rules: await chrome.declarativeNetRequest.getSessionRules() };
  })()`);
  const rule = fixture.rules.find((item) => item.id === RULE_ID);
  assert(rule, 'Test redirect rule was not installed.');
  assert.deepEqual(rule.condition.tabIds, [fixture.tabId], 'Redirect must be restricted to the isolated OAuth tab.');
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);

  try {
    const targets = await cdp.send('Target.getTargets');
    const target = targets.targetInfos.find((item) => item.type === 'page' && item.url === 'about:blank#tabflow-oauth-smoke');
    assert(target, 'Isolated OAuth tab missing.');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    // Intercept every external request in this tab. No request reaches OpenAI.
    await cdp.send('Fetch.enable', { patterns: [
      { urlPattern: 'https://*', requestStage: 'Request' },
      { urlPattern: 'http://*', requestStage: 'Request' },
    ] }, sessionId);
    let mockResponses = 0;
    cdp.on('Fetch.requestPaused', async (request, eventSession) => {
      if (eventSession !== sessionId) return;
      if (request.request.url !== AUTH_URL) {
        await cdp.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }, sessionId);
        throw new Error(`Unexpected external request blocked: ${new URL(request.request.url).origin}`);
      }
      mockResponses++;
      const html = `<script>location.href='http://127.0.0.1:1455/auth/callback?code=${MOCK_CODE}&state=${MOCK_STATE}&client_id=test-only-issued-client'</script>`;
      await cdp.send('Fetch.fulfillRequest', {
        requestId: request.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from(html).toString('base64'),
      }, sessionId);
    });
    await cdp.send('Page.navigate', { url: AUTH_URL }, sessionId);
    const courier = await waitFor(async () => {
      const messages = await evaluate('globalThis.__courier');
      return messages.length ? messages : undefined;
    }, 'mock auth-origin callback to reach packaged courier');
    assert.equal(mockResponses, 1);
    assert.equal(courier.length, 1, 'Callback must be delivered exactly once.');
    assert.equal(courier[0].message.state, MOCK_STATE);
    assert.equal(courier[0].message.code, MOCK_CODE);
    assert.equal(courier[0].sender.tab.id, fixture.tabId);
    const callbackPage = await evaluator(cdp, sessionId)(`({
      title: document.title, body: document.body?.innerText, url: location.href
    })`);
    const currentTargets = await cdp.send('Target.getTargets');
    await capture(cdp, sessionId, 'callback-ui.png');
    console.log('Mock auth-origin callback reached the production packaged extension courier.');
    return { courier, callbackPage, installedRule: rule, mockResponses,
      targets: currentTargets.targetInfos.map(({ type, url }) => ({ type, url })) };
  } finally {
    await evaluate(`chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [${RULE_ID}] })`);
    const remaining = await evaluate('chrome.declarativeNetRequest.getSessionRules()');
    assert(!remaining.some((item) => item.id === RULE_ID), 'Test session rule was not removed.');
    console.log('Verified OAuth tab restriction and session rule cleanup.');
  }
}

async function stopChrome(cdp, chrome, exited) {
  if (cdp) {
    // Browser.close can close the socket before replying; both paths are bounded.
    try { await cdp.send('Browser.close', {}, undefined, 2_000); } catch { /* Expected on socket shutdown. */ }
    cdp.dispose();
  }
  if (!await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) {
    chrome.kill();
    await Promise.race([exited, delay(2_000)]);
  }
}

async function main() {
  let chrome;
  let cdp;
  let exited;
  let evidence = { realAuthorization: false, usesExistingProfile: false };
  await mkdir(runDirectory, { recursive: true });
  try {
    const executable = await findChrome();
    const extensionDirectory = await prepareFixture();
    const port = await reserveDebugPort();
    chrome = spawn(executable, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-sync', '--disable-background-networking', '--enable-unsafe-extension-debugging',
      `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(runDirectory, 'profile')}`, 'about:blank',
    ], { stdio: 'ignore' });
    let launchError;
    chrome.once('error', (error) => { launchError = new Error(`Chrome launch failed: ${error.message}\n${chromeCommandHint()}`); });
    exited = new Promise((resolve) => {
      chrome.once('exit', (code, signal) => {
        launchError ??= new Error(`Isolated Chrome exited (code ${code}, signal ${signal}).`);
        resolve();
      });
      chrome.once('error', resolve);
    });
    const connection = await connectToChrome(port, () => launchError);
    cdp = createCDP(connection.socket);
    console.log(`Chrome ${connection.version.Browser}`);
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionDirectory });
    assert(loaded.id, 'Chrome did not return an unpacked extension ID.');
    console.log(`Loaded isolated extension ${loaded.id}`);
    const { evaluate, options } = await renderSubscriptionUI(cdp, loaded.id);
    const result = await testPackagedCourier(cdp, evaluate);
    cdp.checkEvents();
    evidence = { ...evidence, passed: true, browser: connection.version.Browser,
      extensionId: loaded.id, options, ...result, sessionRuleRemoved: true };
  } catch (error) {
    evidence = { ...evidence, passed: false, error: error.message };
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (chrome) await stopChrome(cdp, chrome, exited);
    await writeFile(path.join(runDirectory, 'callback-result.json'), JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${runDirectory}`);
  }
}

await main();

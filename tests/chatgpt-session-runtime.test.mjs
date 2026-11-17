import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';

const paths = {
  protocol: '../src/services/chatgptSessionProtocol.ts', client: '../src/services/chatgptPlanClient.ts',
  background: '../src/background/chatgptSessionBackground.ts', host: '../src/session/index.ts', worker: '../src/session/chatgpt-session.worker.ts',
  auth: '../src/services/chatgptPlanAuth.ts', model: '../src/services/chatgptPlan.ts',
};
const sources = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'))])));
let sequence = 0;
const dataURL = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const protocolURL = dataURL(sources.protocol);
const protocol = await import(protocolURL);
function events() {
  const listeners = new Set();
  return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, emit(...args) { return [...listeners].map(fn => fn(...args)); }, get size() { return listeners.size; } };
}
function source(name) {
  return sources[name].replace(/(['"])(?:\.\.\/services\/|\.\/)?chatgptSessionProtocol\1/g, JSON.stringify(protocolURL));
}
async function load(name, environment) {
  const key = `__chatgptSessionTest${sequence++}`;
  globalThis[key] = environment;
  const prefix = `const { chrome, Worker } = globalThis[${JSON.stringify(key)}];\n`;
  const code = source(name).replace("new URL('./chatgpt-session.worker.ts', import.meta.url)", "'session-worker.js'")
    .replace("import('../services/builtinModel')", `Promise.resolve(globalThis[${JSON.stringify(key)}].builtin)`);
  return import(dataURL(prefix + code + `\n// ${key}`));
}
function chromeBase() {
  return { runtime: { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, onMessage: events(), onConnect: events() }, tabs: { onRemoved: events() } };
}
const uiSender = { id: 'fixture', url: 'chrome-extension://fixture/options.html' };
const hostSender = { id: 'fixture', url: 'chrome-extension://fixture/chatgpt-session.html' };
const bgSender = { id: 'fixture', url: 'chrome-extension://fixture/background.js' };
const request = (command, args = []) => ({ channel: protocol.SESSION_CHANNEL, target: 'background', command, args });
async function dispatch(chrome, message, sender) {
  return new Promise(resolve => { chrome.runtime.onMessage.emit(message, sender, resolve); });
}

test('sender allowlist rejects callback, foreign IDs, lookalike origins and UI pathname prefixes', () => {
  assert.equal(protocol.trustedSender(uiSender, 'fixture', protocol.UI_PATHS), true);
  assert.equal(protocol.trustedSender({ ...uiSender, url: `${uiSender.url}?pane=ai` }, 'fixture', protocol.UI_PATHS), true);
  for (const sender of [
    { id: 'other', url: uiSender.url }, { id: 'fixture', url: 'https://fixture/options.html' },
    { id: 'fixture', url: 'chrome-extension://fixture/oauth-callback.html' },
    { id: 'fixture', url: 'chrome-extension://fixture/options.html/evil' }, {},
  ]) assert.equal(protocol.trustedSender(sender, 'fixture', protocol.UI_PATHS), false);
});

test('RPC error DTO preserves control-flow names and safe fields, excluding stack/body/custom credential fields', () => {
  for (const name of ['BootstrapRequiredError', 'AbortError', 'ChatGPTPlanAPIError', 'TimeoutError']) {
    const error = Object.assign(new Error('safe diagnostic'), { name, status: 401, code: 'invalid_token', requestId: 'req_123', body: 'secret', accessToken: 'secret' });
    const dto = protocol.safeError(error);
    assert.deepEqual(Object.keys(dto).sort(), ['code', 'message', 'name', 'requestId', 'status']);
    const restored = protocol.restoreError(dto);
    assert.equal(restored.name, name); assert.equal(restored.status, 401);
    assert.equal(restored.code, 'invalid_token'); assert.equal(restored.requestId, 'req_123');
    assert.equal(JSON.stringify(dto).includes('secret'), false);
  }
});

test('client hydrates one shared status mirror, accepts only host broadcasts and excludes extra status properties', async () => {
  const chrome = chromeBase(); let sends = 0; let complete;
  chrome.runtime.sendMessage = () => { sends++; return new Promise(resolve => { complete = resolve; }); };
  const client = await load('client', { chrome });
  let notifications = 0; const unsubscribe = client.subscribeChatGPTPlanSession(() => { notifications++; });
  const first = client.initializeChatGPTPlanSession(), second = client.initializeChatGPTPlanSession();
  assert.equal(first, second); assert.equal(sends, 1);
  complete({ ok: true, value: { loggedIn: true, planAuthorized: true, account: { id: 'a', label: 'A', clientId: 'c', subject: 's', accessToken: 'must-not-copy' }, accessToken: 'must-not-copy' } });
  await first;
  assert.equal(client.getChatGPTPlanStatus().account.id, 'a');
  assert.equal(JSON.stringify(client.getChatGPTPlanStatus()).includes('must-not-copy'), false);
  const broadcast = { channel: protocol.SESSION_CHANNEL, event: 'status', status: { loggedIn: false, planAuthorized: false } };
  chrome.runtime.onMessage.emit(broadcast, uiSender);
  assert.equal(client.getChatGPTPlanStatus().loggedIn, true);
  chrome.runtime.onMessage.emit(broadcast, { ...hostSender, id: 'attacker' });
  assert.equal(client.getChatGPTPlanStatus().loggedIn, true);
  chrome.runtime.onMessage.emit(broadcast, hostSender);
  assert.equal(client.getChatGPTPlanStatus().loggedIn, false); assert.equal(notifications, 2);
  unsubscribe(); chrome.runtime.onMessage.emit(broadcast, hostSender); assert.equal(notifications, 2);
});

test('a newer host broadcast cannot be overwritten by a stale hydration reply', async () => {
  const chrome = chromeBase(); let complete;
  chrome.runtime.sendMessage = () => new Promise(resolve => { complete = resolve; });
  const client = await load('client', { chrome }); const hydration = client.initializeChatGPTPlanSession();
  chrome.runtime.onMessage.emit({ channel: protocol.SESSION_CHANNEL, event: 'status', status: { loggedIn: false, planAuthorized: false } }, hostSender);
  complete({ ok: true, value: { loggedIn: true, planAuthorized: true } });
  assert.equal((await hydration).loggedIn, false);
});

test('client requests optional permissions synchronously before background OAuth and preserves error names', async () => {
  const chrome = chromeBase(); const order = []; let grant;
  chrome.permissions = { request: () => { order.push('permissions'); return new Promise(resolve => { grant = resolve; }); } };
  chrome.runtime.sendMessage = async message => { order.push(message.command); return { ok: false, error: { name: 'BootstrapRequiredError', message: 'login required' } }; };
  const client = await load('client', { chrome });
  const login = client.signInChatGPTPlan(); assert.deepEqual(order, ['permissions']); grant(true);
  await assert.rejects(login, { name: 'BootstrapRequiredError' }); assert.deepEqual(order, ['permissions', 'signIn']);
  await assert.rejects(client.getChatGPTPlanModels(), { name: 'BootstrapRequiredError' });
  assert.equal('getChatGPTPlanAccessToken' in client, false);
});

for (const [scenario, newerStatus] of [
  ['logout', { loggedIn: false, planAuthorized: false }],
  ['account switch', { loggedIn: true, planAuthorized: true, account: { id: 'new-account', label: 'New', clientId: 'new-client', subject: 'new-subject' } }],
]) test(`a newer trusted ${scenario} broadcast cannot be overwritten by a delayed sign-in reply`, async () => {
  const chrome = chromeBase(); let complete; let started;
  const commandStarted = new Promise(resolve => { started = resolve; });
  chrome.permissions = { request: () => Promise.resolve(true) };
  chrome.runtime.sendMessage = message => {
    assert.equal(message.command, 'signIn'); started();
    return new Promise(resolve => { complete = resolve; });
  };
  const client = await load('client', { chrome }); let notifications = 0;
  client.subscribeChatGPTPlanSession(() => { notifications++; });
  const login = client.signInChatGPTPlan('old-account'); await commandStarted;
  chrome.runtime.onMessage.emit({ channel: protocol.SESSION_CHANNEL, event: 'status', status: newerStatus }, hostSender);
  complete({ ok: true, value: { loggedIn: true, planAuthorized: true, account: { id: 'old-account', label: 'Old', clientId: 'old-client', subject: 'old-subject' } } });
  const result = await login;
  assert.deepEqual(result, newerStatus);
  assert.equal(result, client.getChatGPTPlanStatus());
  assert.equal(notifications, 1, 'stale reply must not publish a second state transition');
});

test('client group transport omits absent customPrompt and preserves explicit strings across Chrome JSON serialization', async () => {
  const chrome = chromeBase(); const sent = []; const groups = [{ name: '组', color: 'blue', tabIds: [1] }];
  chrome.runtime.sendMessage = async message => { sent.push(JSON.parse(JSON.stringify(message))); return { ok: true, value: groups }; };
  const client = await load('client', { chrome }); const tabs = [{ id: 1, title: 'Title', url: 'https://example.test', groupId: -1 }];
  for (const settings of [{ model: 'fixture-model' }, { model: 'fixture-model', customPrompt: undefined }]) {
    assert.deepEqual(await client.planGroupByChatGPTPlan(tabs, settings), groups);
    assert.deepEqual(sent.at(-1).args, [tabs, 'fixture-model']);
  }
  for (const customPrompt of ['', '请按主题分类']) {
    assert.deepEqual(await client.planGroupByChatGPTPlan(tabs, { model: 'fixture-model', customPrompt }), groups);
    assert.deepEqual(sent.at(-1).args, [tabs, 'fixture-model', customPrompt]);
  }
});

function backgroundChrome(existing = false) {
  const chrome = chromeBase(); const calls = { creates: 0, storage: [], forwarded: [] }; let present = existing;
  chrome.runtime.ContextType = { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
  chrome.runtime.getContexts = async filter => { assert.deepEqual(filter.documentUrls, [hostSender.url]); return present ? [{}] : []; };
  chrome.offscreen = { Reason: { WORKERS: 'WORKERS' }, createDocument: async info => { calls.creates++; assert.deepEqual(info.reasons, ['WORKERS']); present = true; } };
  chrome.runtime.sendMessage = async message => { calls.forwarded.push(message); return { ok: true, value: message.event === 'ready' ? true : { loggedIn: true, planAuthorized: true } }; };
  chrome.storage = { local: { get: async key => { calls.storage.push(['get', key]); return {}; }, set: async value => { calls.storage.push(['set', value]); } } };
  return { chrome, calls };
}

test('background is lazy, creates a single offscreen document under concurrent UI hydration and discovers it after SW restart', async () => {
  const first = backgroundChrome(); const module = await load('background', first);
  module.registerChatGPTSessionBackground(); module.registerChatGPTSessionBackground();
  assert.equal(first.calls.creates, 0); assert.equal(first.chrome.runtime.onMessage.size, 1);
  await Promise.all(Array.from({ length: 8 }, () => dispatch(first.chrome, request('initialize'), uiSender)));
  assert.equal(first.calls.creates, 1);
  const restarted = backgroundChrome(true); const fresh = await load('background', restarted); fresh.registerChatGPTSessionBackground();
  assert.equal((await dispatch(restarted.chrome, request('initialize'), uiSender)).ok, true);
  assert.equal(restarted.calls.creates, 0);
  assert.equal('closeDocument' in restarted.chrome.offscreen, false);
});

test('background refuses untrusted commands and metadata proxy calls before touching APIs', async () => {
  const f = backgroundChrome(); const bg = await load('background', f); bg.registerChatGPTSessionBackground();
  for (const sender of [{ id: 'fixture', url: 'chrome-extension://fixture/oauth-callback.html' }, { ...uiSender, id: 'evil' }, {}]) {
    assert.equal((await dispatch(f.chrome, request('models'), sender)).error.name, 'SecurityError');
  }
  const bridge = { channel: protocol.SESSION_CHANNEL, target: 'background', event: 'bridge', method: 'storage.get', args: ['tabflow.chatgptPlan.host.v1'] };
  assert.equal((await dispatch(f.chrome, bridge, uiSender)).error.name, 'SecurityError');
  assert.equal((await dispatch(f.chrome, { ...bridge, args: ['access_token'] }, hostSender)).error.name, 'SecurityError');
  assert.equal((await dispatch(f.chrome, { ...bridge, method: 'storage.set', args: [{ 'tabflow.chatgptPlan.host.v1': 'urn:uuid:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', refresh_token: 'secret' }] }, hostSender)).error.name, 'SecurityError');
  assert.equal((await dispatch(f.chrome, { ...bridge, method: 'permissions.request', args: [{}] }, hostSender)).error.name, 'SecurityError');
  assert.equal(f.calls.creates, 0); assert.deepEqual(f.calls.storage, []);
  assert.equal((await dispatch(f.chrome, bridge, hostSender)).ok, true); assert.equal(f.calls.storage.length, 1);
});

test('bridge limits metadata shapes, navigation URLs and DNR redirect to exact callback rules', async () => {
  const bg = await load('background', backgroundChrome()); const valid = (method, args) => bg.validateBridgeCall(method, args, 'fixture');
  assert.equal(valid('storage.set', [{ 'tabflow.chatgptPlan.registrations.v1': [{ id: 'a', label: 'A', clientId: 'c', subject: 's' }] }]), true);
  assert.equal(valid('storage.set', [{ 'tabflow.chatgptPlan.registrations.v1': [{ id: 'a', label: 'A', clientId: 'c', subject: 's', accessToken: 'secret' }] }]), false);
  for (const url of ['https://evil.test/', 'https://auth.openai.com/api/accounts/authorize?access_token=secret', 'javascript:alert(1)']) assert.equal(valid('tabs.update', [1, { url }]), false);
  assert.equal(valid('tabs.update', [1, { url: 'https://auth.openai.com/api/accounts/authorize?state=s&nonce=n' }]), true);
  const rule = { id: 1, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: 'chrome-extension://fixture/oauth-callback.html\\1' } }, condition: { regexFilter: '^http://127[.]0[.]0[.]1:1455/auth/callback([?].*)?$', isUrlFilterCaseSensitive: true, tabIds: [41], resourceTypes: ['main_frame'] } };
  assert.equal(valid('dnr.updateSessionRules', [{ addRules: [rule] }]), true);
  rule.action.redirect.regexSubstitution = 'https://evil.test/\\1'; assert.equal(valid('dnr.updateSessionRules', [{ addRules: [rule] }]), false);
});

test('offscreen keeps dedicated worker alive when UI closes, rejects UI host commands and preserves real callback sender', async () => {
  const chrome = chromeBase(); let worker;
  class FakeWorker {
    constructor() { worker = this; this.messages = []; this.events = events(); this.terminated = false; }
    addEventListener(type, callback) { if (type === 'message') this.events.addListener(callback); }
    postMessage(message) { this.messages.push(message); if (message.type === 'boot') queueMicrotask(() => this.events.emit({ data: { type: 'ready' } })); }
    terminate() { this.terminated = true; }
  }
  chrome.runtime.sendMessage = async () => ({ ok: true, value: undefined });
  await load('host', { chrome, Worker: FakeWorker });
  assert.equal(worker.messages[0].type, 'boot');
  assert.equal((await dispatch(chrome, { ...request('models'), target: 'host' }, uiSender)).error.name, 'SecurityError');
  assert.equal((await dispatch(chrome, { channel: protocol.SESSION_CHANNEL, target: 'host', event: 'ready' }, bgSender)).ok, true);
  const callback = { name: protocol.OAUTH_CHANNEL, sender: { id: 'fixture', url: 'chrome-extension://fixture/oauth-callback.html?code=c', tab: { id: 41 }, frameId: 0, documentId: 'real-document' }, onMessage: events(), onDisconnect: events(), disconnect() {} };
  chrome.runtime.onConnect.emit(callback);
  const connected = worker.messages.find(message => message.type === 'portConnect');
  assert.deepEqual(connected.sender, callback.sender);
  callback.onDisconnect.emit();
  assert.equal(worker.terminated, false);
  assert.equal(worker.messages.some(message => message.type === 'pagehide' || message.command === 'signOut'), false);
  const forged = { ...callback, sender: uiSender, disconnect() { this.rejected = true; } }; chrome.runtime.onConnect.emit(forged); assert.equal(forged.rejected, true);
});

test('offscreen automatic builtin grouping rejects UI senders and never downloads an unavailable model', async () => {
  const chrome = chromeBase();
  let status = 'downloaded';
  const calls = [];
  const tabs = [{ id: 1, title: 'Title', url: 'https://example.test', groupId: -1 }];
  const groups = [{ name: 'Topic', color: 'blue', tabIds: [1] }];
  class FakeWorker { addEventListener() {} postMessage() {} }
  const builtin = {
    async checkBuiltinModel() { calls.push('check'); return { status }; },
    async classifyWithBuiltinModel(...args) { calls.push(args); return groups; },
  };
  await load('host', { chrome, Worker: FakeWorker, builtin });
  const message = { channel: protocol.SESSION_CHANNEL, target: 'host', event: 'groupBuiltin', tabs, customPrompt: 'Preference' };
  assert.equal((await dispatch(chrome, message, uiSender)).error.name, 'SecurityError');
  assert.deepEqual(calls, []);
  assert.deepEqual((await dispatch(chrome, message, bgSender)).value, groups);
  assert.deepEqual(calls, ['check', [tabs, 'Preference']]);
  for (status of ['downloadable', 'unsupported', 'unavailable']) {
    calls.length = 0;
    assert.equal((await dispatch(chrome, message, bgSender)).ok, false);
    assert.deepEqual(calls, ['check'], 'Unavailable models must not enter create/download/classification');
  }
});

test('offscreen reports worker bootstrap failure and protocol requests have a bounded timeout', async () => {
  const chrome = chromeBase();
  class FailingWorker {
    constructor() { this.events = events(); }
    addEventListener(type, listener) { if (type === 'message') this.events.addListener(listener); }
    postMessage(message) { if (message.type === 'boot') queueMicrotask(() => this.events.emit({ data: { type: 'bootError' } })); }
  }
  chrome.runtime.sendMessage = async () => ({ ok: true, value: undefined });
  await load('host', { chrome, Worker: FailingWorker });
  const response = await dispatch(chrome, { channel: protocol.SESSION_CHANNEL, target: 'host', event: 'ready' }, bgSender);
  assert.equal(response.ok, false); assert.match(response.error.message, /初始化失败/);
  await assert.rejects(protocol.withTimeout(new Promise(() => {}), 5), { name: 'TimeoutError' });
});

const signingKeys = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await webcrypto.subtle.exportKey('jwk', signingKeys.publicKey), kid: 'session-fixture', alg: 'RS256', use: 'sig' };
async function signedID(nonce) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'); const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'RS256', kid: 'session-fixture' })}.${encode({ iss: 'https://auth.openai.com', aud: 'client-fixture', sub: 'subject-fixture', nonce, iat: now - 1, exp: now + 3600 })}`;
  return `${body}.${Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKeys.privateKey, Buffer.from(body))).toString('base64url')}`;
}
async function workerFixture(options = {}) {
  const key = `__sessionWorkerFixture${sequence++}`; const posts = [], storage = {}, outboundHTTP = []; let receive; let navigation;
  const pending = new Map(); let rpcId = 1000;
  const scope = { addEventListener(type, listener) { assert.equal(type, 'message'); receive = listener; }, postMessage(message) {
    posts.push(structuredClone(message));
    if (message.type === 'bridge') {
      let value;
      if (message.method === 'permissions.contains') value = true;
      else if (message.method === 'storage.get') value = { [message.args[0]]: storage[message.args[0]] };
      else if (message.method === 'storage.set') Object.assign(storage, structuredClone(message.args[0]));
      else if (message.method === 'tabs.create') value = { id: 41 };
      else if (message.method === 'tabs.update') { navigation = message.args[1].url; }
      queueMicrotask(() => receive({ data: { type: 'bridgeReply', id: message.id, reply: { ok: true, value } } }));
    }
    if (message.type === 'reply') { pending.get(message.id)?.(message.reply); pending.delete(message.id); }
  } };
  const fetch = async (url, init = {}) => {
    outboundHTTP.push({ url, auth: new Headers(init.headers).get('Authorization') });
    if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      const refreshing = new URLSearchParams(init.body).get('grant_type') === 'refresh_token';
      return Response.json({ access_token: 'access-secret-session', refresh_token: refreshing ? 'refresh-secret-session-rotated' : 'refresh-secret-session', id_token: await signedID(new URL(navigation).searchParams.get('nonce')), token_type: 'Bearer', expires_in: options.expireSoon && !refreshing ? 30 : 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
    if (url.endsWith('/v1/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
    if (url.endsWith('/v1/responses')) {
      const body = JSON.parse(init.body);
      let result = { groups: [{ name: '组', color: 'blue', tabIds: [1] }] };
      if (body.text.format.name === 'tabflow_cleanup') {
        const ids = ['103', '110', '117', '124', '131', '138', '145', '152'];
        assert.deepEqual(body.text.format.schema.properties.decisions.required, ids);
        assert.deepEqual(Object.keys(body.text.format.schema.properties.decisions.properties), ids);
        result = { decisions: Object.fromEntries(ids.map(id => [id, { action: 'keep', kind: 'other', task: '资料', reason: '仍可能需要' }])) };
      }
      return Response.json({ object: 'response', status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
    }
    throw new Error('unexpected fixture URL');
  };
  globalThis[key] = { scope, fetch };
  const environment = `const {scope: workerScope, fetch} = globalThis[${JSON.stringify(key)}]; const chrome=workerScope.chrome;\n`;
  const authURL = dataURL(environment + sources.auth + `\n// ${key}`);
  const modelURL = dataURL(environment + sources.model.replace("'./chatgptPlanAuth'", JSON.stringify(authURL)));
  let workerSource = source('worker').replace('const scope = globalThis', `const scope = globalThis[${JSON.stringify(key)}].scope`)
    .replace("'../services/cleanup'", JSON.stringify(dataURL(stripTypeScriptTypes(await readFile(new URL('../src/services/cleanup.ts', import.meta.url), 'utf8')))))
    .replace("import('../services/chatgptPlanAuth')", `import(${JSON.stringify(authURL)})`).replace("import('../services/chatgptPlan')", `import(${JSON.stringify(modelURL)})`);
  await import(dataURL(workerSource + `\n// ${key}`));
  const send = message => receive({ data: message });
  const command = (command, args = []) => { const id = ++rpcId; const promise = new Promise(resolve => pending.set(id, resolve)); send({ type: 'command', id, command, args }); return promise; };
  send({ type: 'boot', extensionId: 'fixture', baseURL: 'chrome-extension://fixture/' });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => { if (posts.some(post => post.type === 'ready')) resolve(); else if (Date.now() > deadline) reject(new Error('worker fixture boot timeout')); else setImmediate(check); }; check();
  });
  return { posts, storage, outboundHTTP, scope, send, command, navigation: () => navigation };
}

test('worker runs unchanged auth/model cores: signed OAuth, token-only HTTP, metadata-only storage, shared session, signout', async () => {
  const f = await workerFixture();
  const before = await f.command('models'); assert.equal(before.ok, false); assert.equal(before.error.name, 'BootstrapRequiredError');
  const login = f.command('signIn');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => { if (f.navigation()) resolve(); else if (Date.now() > deadline) reject(new Error('fixture OAuth timeout')); else setImmediate(check); }; check();
  });
  const state = new URL(f.navigation()).searchParams.get('state');
  f.send({ type: 'portConnect', id: 11, name: protocol.OAUTH_CHANNEL, sender: { id: 'fixture', url: 'chrome-extension://fixture/oauth-callback.html?code=fixture-code', tab: { id: 41 } } });
  f.send({ type: 'portMessage', id: 11, message: { state, code: 'fixture-code', client_id: 'client-fixture' } });
  const status = await login; assert.equal(status.ok, true); assert.equal(status.value.loggedIn, true);
  const reopened = await f.command('initialize'); assert.equal(reopened.value.account.clientId, 'client-fixture');
  const models = await f.command('models'); assert.deepEqual(models.value, [{ id: 'fixture-model', name: 'Fixture' }]);
  const clientChrome = chromeBase();
  clientChrome.runtime.sendMessage = message => { const transported = JSON.parse(JSON.stringify(message)); return f.command(transported.command, transported.args); };
  const client = await load('client', { chrome: clientChrome });
  const groups = await client.planGroupByChatGPTPlan([{ id: 1, title: 'Title', url: 'https://example.test', groupId: -1 }], { model: 'fixture-model' });
  assert.deepEqual(groups, [{ name: '组', color: 'blue', tabIds: [1] }]);
  const cleanup = await f.command('cleanup', [JSON.stringify({ candidates: [103, 110, 117, 124, 131, 138, 145, 152].map(id => ({ id })), context: [{ id: 2000 }] }), '逐页判断', 'fixture-model']);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(Object.keys(cleanup.value.decisions), ['103', '110', '117', '124', '131', '138', '145', '152']);
  assert.equal(f.outboundHTTP.filter(item => item.url.includes('/v1/')).every(item => item.auth === 'Bearer access-secret-session'), true);
  const transcript = JSON.stringify(f.posts); assert.equal(transcript.includes('access-secret-session'), false); assert.equal(transcript.includes('refresh-secret-session'), false);
  assert.equal(transcript.includes('eyJhbGci'), false, 'signed ID token stays inside core worker memory');
  assert.deepEqual(Object.keys(f.storage).sort(), ['tabflow.chatgptPlan.host.v1', 'tabflow.chatgptPlan.registrations.v1']);
  assert.equal(JSON.stringify(f.storage).includes('secret-session'), false);
  assert.equal('request' in f.scope.chrome.permissions, true);
  assert.equal(f.posts.some(post => post.method === 'permissions.request'), false, 'worker request shim only calls contains');
  const logout = await f.command('signOut'); assert.equal(logout.value.revocationConfirmed, true);
  assert.equal((await f.command('initialize')).value.loggedIn, false);
  assert.equal((await f.command('models')).error.name, 'BootstrapRequiredError');
  assert.equal(Object.keys(f.storage).length, 2, 'logout preserves registration metadata');
});

test('concurrent windows share the worker account and one serialized refresh flight', async () => {
  const f = await workerFixture({ expireSoon: true }); const login = f.command('signIn');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => { if (f.navigation()) resolve(); else if (Date.now() > deadline) reject(new Error('fixture OAuth timeout')); else setImmediate(check); }; check();
  });
  const state = new URL(f.navigation()).searchParams.get('state');
  f.send({ type: 'portConnect', id: 21, name: protocol.OAUTH_CHANNEL, sender: { id: 'fixture', url: 'chrome-extension://fixture/oauth-callback.html', tab: { id: 41 } } });
  f.send({ type: 'portMessage', id: 21, message: { state, code: 'fixture-code', client_id: 'client-fixture' } });
  assert.equal((await login).value.loggedIn, true);
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.command('models')));
  assert.equal(replies.every(reply => reply.ok && reply.value[0].id === 'fixture-model'), true);
  assert.equal(f.outboundHTTP.filter(item => item.url.endsWith('/oauth/token')).length, 2, 'one exchange plus one refresh, despite eight callers');
  assert.equal((await f.command('initialize')).value.account.clientId, 'client-fixture');
  assert.equal(JSON.stringify(f.posts).includes('secret-session'), false);
  await f.command('signOut');
});

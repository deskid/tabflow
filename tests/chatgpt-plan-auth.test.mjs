import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
const source = stripTypeScriptTypes(await readFile(new URL('../src/services/chatgptPlanAuth.ts', import.meta.url), 'utf8'));
const callbackSource = stripTypeScriptTypes(await readFile(new URL('../src/oauth/index.ts', import.meta.url), 'utf8'));
const keys = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await webcrypto.subtle.exportKey('jwk', keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
let sequence = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const handlers = new Set();
  return { addListener(fn) { handlers.add(fn); }, removeListener(fn) { handlers.delete(fn); }, emit(...args) { for (const fn of [...handlers]) fn(...args); }, get size() { return handlers.size; } };
}
async function jwt(claims, corrupt = false) {
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode(claims)}`;
  const signature = new Uint8Array(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Buffer.from(data)));
  if (corrupt) signature[0] ^= 1;
  return `${data}.${Buffer.from(signature).toString('base64url')}`;
}
function fixture(options = {}) {
  const calls = { writes: [], fetch: [], rules: [], removed: [], navigation: [], permissions: [], posts: [], order: [] };
  const storage = options.sharedStorage ?? structuredClone(options.storage ?? {});
  const onConnect = event(), onRemoved = event();
  const chrome = {
    runtime: { id: 'extension-fixture', onConnect, getURL: path => `chrome-extension://extension-fixture/${path}` },
    permissions: { request: async spec => { calls.permissions.push(spec); return options.permission !== false; } },
    storage: { local: {
      get: async key => { const snapshot = structuredClone(storage[key]); if (options.storageDelay) await tick(); return { [key]: snapshot }; },
      set: async data => { if (options.storageDelay) await tick(); calls.writes.push(structuredClone(data)); Object.assign(storage, structuredClone(data)); },
    } },
    tabs: { onRemoved, create: async info => { calls.order.push('tab'); assert.equal(info.url, 'about:blank'); return { id: 41 }; },
      update: async (id, info) => { calls.order.push('navigate'); assert.equal(id, 41); calls.navigation.push(info.url); },
      remove: async id => { calls.removed.push(id); } },
    declarativeNetRequest: { RuleActionType: { REDIRECT: 'redirect' }, ResourceType: { MAIN_FRAME: 'main_frame' },
      updateSessionRules: async rules => { calls.order.push(rules.addRules ? 'rule' : 'cleanup'); calls.rules.push(rules); } },
  };
  const fetch = async (url, init = {}) => {
    calls.fetch.push({ url, init });
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/revoke')) {
      if (options.revokeFails) throw new Error('offline');
      return new Response(null, { status: 200 });
    }
    if (url.endsWith('/oauth/token')) {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'refresh_token') {
        if (options.refreshGate) await options.refreshGate;
        if (options.refreshNetworkFails) throw new Error('secret raw network detail');
        if (options.refreshError) return Response.json({ error: options.refreshError.code, error_description: 'access-secret refresh-secret raw-body' },
          { status: options.refreshError.status, headers: { 'x-request-id': options.refreshError.requestId ?? 'req_fixture' } });
        if (options.refreshFails) return Response.json({ error: 'invalid_grant' }, { status: 400, headers: { 'x-request-id': 'req_fixture' } });
        let idToken;
        if (options.refreshClaims) {
          const now = Math.floor(Date.now() / 1000);
          const auth = new URL(calls.navigation.at(-1)).searchParams;
          const nonce = options.refreshNonce === 'original' ? { nonce: auth.get('nonce') } : {};
          idToken = await jwt({ iss: 'https://auth.openai.com', aud: body.get('client_id'), sub: 'subject-fixture',
            iat: now - 1, exp: now + 3600, ...nonce, ...options.refreshClaims }, options.refreshCorrupt);
        }
        return Response.json({ access_token: 'access-refreshed', refresh_token: 'refresh-rotated', token_type: 'Bearer', expires_in: 3600,
          ...(idToken === undefined ? {} : { id_token: idToken }),
          ...(options.refreshScope === undefined ? {} : { scope: options.refreshScope }) });
      }
      if (options.authError) return Response.json({ error: options.authError.code, error_description: 'access-secret refresh-secret raw-body' },
        { status: options.authError.status, headers: { 'x-request-id': options.authError.requestId ?? 'req_auth_fixture' } });
      const auth = new URL(calls.navigation.at(-1)).searchParams;
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://auth.openai.com', aud: body.get('client_id'), sub: 'subject-fixture', email: 'same@example.test',
        nonce: auth.get('nonce'), iat: now - 1, exp: now + 3600, ...options.claims };
      return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: await jwt(claims, options.corrupt),
        token_type: 'Bearer', expires_in: options.expires ?? 3600, scope: options.scope ?? SCOPE });
    }
    throw new Error(`Unexpected test URL ${url}`);
  };
  function port(tab = 41, senderId = chrome.runtime.id, senderUrl = chrome.runtime.getURL('oauth-callback.html')) {
    const p = { name: 'tabflow-chatgpt-plan-oauth-v1', sender: { id: senderId, tab: { id: tab }, url: senderUrl },
      onMessage: event(), disconnected: false, postMessage(message) { calls.posts.push(message); }, disconnect() { p.disconnected = true; } };
    onConnect.emit(p); return p;
  }
  return { chrome, fetch, calls, storage, port };
}
async function load(options) {
  const f = fixture(options);
  globalThis.chrome = f.chrome; globalThis.fetch = f.fetch;
  // Capture each page's APIs lexically so concurrent module instances model
  // separate extension pages while sharing only explicitly supplied metadata APIs.
  globalThis.__authTestEnvironment = { chrome: f.chrome, fetch: f.fetch, navigator: { locks: options?.locks } };
  const environment = 'const { chrome, fetch, navigator } = globalThis.__authTestEnvironment;\n';
  const s = await import(`data:text/javascript;base64,${Buffer.from(environment + source + `\n// fixture ${sequence++}`).toString('base64')}`);
  delete globalThis.__authTestEnvironment;
  return { ...f, s };
}
async function started(f, accountId) {
  const result = f.s.signInChatGPTPlan(accountId);
  for (let n = 0; n < 100 && !f.calls.navigation.length; n++) await tick();
  assert.ok(f.calls.navigation.length, 'authorization tab navigated');
  return { result, query: new URL(f.calls.navigation.at(-1)).searchParams };
}
async function login(f, data = {}, accountId) {
  const { result, query } = await started(f, accountId);
  f.port().onMessage.emit({ code: 'code-secret', state: query.get('state'), client_id: 'oaiapp_fixture', ...data });
  return result;
}
function clean(f) {
  assert.equal(f.chrome.runtime.onConnect.size, 0);
  assert.equal(f.chrome.tabs.onRemoved.size, 0);
  assert.deepEqual(f.calls.removed, [41]);
  assert.deepEqual(f.calls.rules.at(-1).removeRuleIds, [f.calls.rules[0].addRules[0].id]);
}

test('dynamic registration uses exact official parameters, PKCE and tab/path scoped DNR; tokens never enter storage', async () => {
  const f = await load(); let notifications = 0;
  const unsubscribe = f.s.subscribeChatGPTPlanSession(() => notifications++);
  assert.equal(f.calls.permissions.length, 0);
  const { result, query } = await started(f);
  assert.deepEqual(f.calls.order.slice(0, 3), ['tab', 'rule', 'navigate']);
  assert.equal(query.get('client_id'), 'dynamic_agent_client');
  assert.equal(query.get('agent_name_hint'), 'TabFlow');
  assert.match(query.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(query.get('scope'), SCOPE); assert.equal(query.get('resource'), 'https://api.openai.com/v1');
  assert.equal(query.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.ok(query.get('state').length >= 43); assert.notEqual(query.get('state'), query.get('nonce'));
  const rule = f.calls.rules[0].addRules[0];
  assert.deepEqual(rule.condition.tabIds, [41]); assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
  const regex = new RegExp(rule.condition.regexFilter);
  assert.ok(regex.test('http://127.0.0.1:1455/auth/callback?code=x'));
  for (const url of ['http://127.0.0.1:1455/auth/callback/other', 'http://127.0.0.1:1456/auth/callback', 'http://127.0.0.1:1455/other']) assert.equal(regex.test(url), false);
  assert.equal(rule.action.redirect.regexSubstitution, 'chrome-extension://extension-fixture/oauth-callback.html\\1');
  const p = f.port(); p.onMessage.emit({ state: query.get('state'), code: 'code-secret', client_id: 'oaiapp_fixture' });
  const status = await result;
  assert.equal(status.loggedIn, true); assert.equal(status.planAuthorized, true);
  assert.equal(await f.s.getChatGPTPlanAccessToken(), 'access-secret');
  assert.equal(notifications, 1); unsubscribe();
  const exchange = f.calls.fetch.find(call => call.url.endsWith('/oauth/token'));
  const body = new URLSearchParams(exchange.init.body);
  assert.equal(body.get('client_id'), 'oaiapp_fixture');
  assert.equal(body.get('redirect_uri'), query.get('redirect_uri')); assert.equal(body.get('resource'), query.get('resource'));
  const challenge = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(body.get('code_verifier')))).toString('base64url');
  assert.equal(query.get('code_challenge'), challenge);
  assert.equal(body.has('client_secret'), false);
  const saved = JSON.stringify(f.calls.writes);
  for (const secret of ['access-secret', 'refresh-secret', 'code-secret', 'id_token', 'access_token', 'refresh_token']) assert.equal(saved.includes(secret), false);
  assert.equal((await f.s.getChatGPTPlanAccounts())[0].subject, 'subject-fixture');
  clean(f);
});

test('a closed courier cannot turn an already verified session into an authorization failure', async () => {
  const f = await load();
  const { result, query } = await started(f);
  const p = f.port();
  p.postMessage = () => { throw new Error('Port disconnected'); };
  p.onMessage.emit({ code: 'code-secret', state: query.get('state'), client_id: 'oaiapp_fixture' });
  const status = await result;
  assert.equal(status.loggedIn, true);
  assert.equal(status.planAuthorized, true);
  assert.equal(status.error, undefined);
  clean(f);
});

test('state, missing issued ID, dynamic issued ID and access_denied are terminal and exchange no code', async () => {
  for (const callback of [{ state: 'wrong' }, { client_id: undefined }, { client_id: 'dynamic_agent_client' }, { error: 'access_denied' }]) {
    const f = await load(); const status = await login(f, callback);
    assert.equal(status.loggedIn, false); assert.ok(status.error);
    assert.equal(f.calls.fetch.length, 0); clean(f);
  }
});

test('RS256 signature, issuer, audience, nonce, exp, iat, sub and azp are verified before saving a registration', async () => {
  for (const options of [{ corrupt: true }, { claims: { iss: 'https://evil.example' } }, { claims: { aud: 'other-client' } },
    { claims: { nonce: 'wrong' } }, { claims: { exp: 1 } }, { claims: { iat: 9999999999 } }, { claims: { sub: '' } },
    { claims: { aud: ['oaiapp_fixture', 'other'], azp: 'other' } }]) {
    const f = await load(options); const status = await login(f);
    assert.equal(status.loggedIn, false); assert.equal((await f.s.getChatGPTPlanAccounts()).length, 0);
    assert.equal(JSON.stringify(status).includes('code-secret'), false); clean(f);
  }
});

test('ID token alone and missing either plan scope cannot authorize inference', async () => {
  for (const scope of ['openid profile email', 'openid chatgpt.tokens.use.direct', 'openid resource.invoke']) {
    const f = await load({ scope }); const status = await login(f);
    assert.equal(status.loggedIn, true); assert.equal(status.planAuthorized, false);
    await assert.rejects(f.s.getChatGPTPlanAccessToken(), /计划推理权限/); clean(f);
  }
});

test('wrong sender tab, extension ID and URL cannot submit callbacks; callback state is single use', async () => {
  const f = await load(); const { result, query } = await started(f);
  const wrongTab = f.port(99); assert.equal(wrongTab.disconnected, true);
  wrongTab.onMessage.emit({ state: query.get('state'), code: 'wrong' });
  assert.equal(f.calls.fetch.length, 0);
  const wrongExtension = f.port(41, 'another-extension'); assert.equal(wrongExtension.disconnected, true);
  const wrongUrl = f.port(41, f.chrome.runtime.id, f.chrome.runtime.getURL('other.html')); assert.equal(wrongUrl.disconnected, true);
  const p = f.port(); const payload = { state: query.get('state'), code: 'code-secret', client_id: 'oaiapp_fixture' };
  p.onMessage.emit(payload); p.onMessage.emit(payload);
  assert.equal((await result).loggedIn, true);
  assert.equal(f.calls.fetch.filter(c => c.url.endsWith('/oauth/token')).length, 1); clean(f);
});

test('tab/window close, explicit cancel, timeout, permission denial and setup exception clean up', async () => {
  for (const mode of ['tab-close', 'sign-out', 'timeout']) {
    const f = await load();
    const original = globalThis.setTimeout; let expire;
    if (mode === 'timeout') globalThis.setTimeout = (fn, ms, ...rest) => ms === 180000 ? (expire = fn, original(() => {}, 1)) : original(fn, ms, ...rest);
    const { result } = await started(f);
    globalThis.setTimeout = original;
    if (mode === 'tab-close') f.chrome.tabs.onRemoved.emit(41, { isWindowClosing: true });
    if (mode === 'sign-out') await f.s.signOutChatGPTPlan();
    if (mode === 'timeout') expire();
    assert.equal((await result).loggedIn, false); clean(f);
  }
  const denied = await load({ permission: false });
  assert.equal((await denied.s.signInChatGPTPlan()).loggedIn, false); assert.equal(denied.calls.rules.length, 0);
  const failing = await load(); failing.chrome.tabs.update = async () => { throw new Error('browser error'); };
  const pending = failing.s.signInChatGPTPlan();
  assert.equal((await pending).loggedIn, false); clean(failing);
});

test('returning sign-in reuses issued registration and stable host, validates selected sub and callback client ID', async () => {
  const f = await load(); await login(f);
  const account = (await f.s.getChatGPTPlanAccounts())[0];
  const host = new URL(f.calls.navigation[0]).searchParams.get('ext_agent_host_id');
  f.calls.navigation.length = 0;
  const { result, query } = await started(f, account.id);
  assert.equal(query.get('client_id'), account.clientId); assert.equal(query.has('agent_name_hint'), false);
  assert.equal(query.get('ext_agent_host_id'), host); assert.equal(query.get('login_hint'), account.email);
  assert.equal(query.has('id_token_hint'), false, 'optional token hint must not put an ID token in browser history');
  f.port().onMessage.emit({ state: query.get('state'), code: 'new-code' });
  assert.equal((await result).loggedIn, true);
  const g = await load({ storage: f.storage, claims: { sub: 'different-account' } });
  assert.equal((await login(g, {}, account.id)).loggedIn, false);
  const h = await load({ storage: f.storage });
  assert.equal((await login(h, { client_id: 'different-client' }, account.id)).loggedIn, false);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal((await h.s.getChatGPTPlanAccounts()).length, 1);
});

test('same email with distinct issued clients stays separate; closing page loses session but keeps registrations', async () => {
  const f = await load(); await login(f);
  f.calls.navigation.length = 0;
  await login(f, { client_id: 'oaiapp_second' });
  const accounts = await f.s.getChatGPTPlanAccounts();
  assert.equal(accounts.length, 2); assert.notEqual(accounts[0].id, accounts[1].id);
  const reopened = await load({ storage: f.storage });
  assert.equal(reopened.s.getChatGPTPlanStatus().loggedIn, false);
  assert.equal((await reopened.s.getChatGPTPlanAccounts()).length, 2);
});

test('two extension pages share stable host and merge separate registrations under same-origin metadata locks', async () => {
  const queues = new Map(); const lockCalls = [];
  const locks = { request(name, callback) {
    lockCalls.push(name);
    const previous = queues.get(name) ?? Promise.resolve();
    const result = previous.then(() => callback({ name, mode: 'exclusive' }));
    queues.set(name, result.then(() => {}, () => {}));
    return result;
  } };
  const sharedStorage = {};
  const a = await load({ sharedStorage, locks, storageDelay: true });
  const b = await load({ sharedStorage, locks, storageDelay: true });
  const [first, second] = await Promise.all([started(a), started(b)]);
  assert.equal(first.query.get('ext_agent_host_id'), second.query.get('ext_agent_host_id'));
  assert.equal([...a.calls.writes, ...b.calls.writes].filter(write => 'tabflow.chatgptPlan.host.v1' in write).length, 1);
  a.port().onMessage.emit({ state: first.query.get('state'), code: 'code-a', client_id: 'oaiapp_page_a' });
  b.port().onMessage.emit({ state: second.query.get('state'), code: 'code-b', client_id: 'oaiapp_page_b' });
  const statuses = await Promise.all([first.result, second.result]);
  assert.ok(statuses.every(status => status.loggedIn && status.planAuthorized));
  const accountsA = await a.s.getChatGPTPlanAccounts(); const accountsB = await b.s.getChatGPTPlanAccounts();
  assert.equal(accountsA.length, 2); assert.deepEqual(accountsA, accountsB);
  assert.deepEqual(new Set(accountsA.map(account => account.clientId)), new Set(['oaiapp_page_a', 'oaiapp_page_b']));
  assert.notEqual(accountsA[0].label, accountsA[1].label);
  assert.equal(a.s.getChatGPTPlanStatus().account.clientId, 'oaiapp_page_a');
  assert.equal(b.s.getChatGPTPlanStatus().account.clientId, 'oaiapp_page_b');
  for (const key of ['tabflow.chatgptPlan.host.v1', 'tabflow.chatgptPlan.registrations.v1']) {
    assert.equal(lockCalls.filter(name => name === key).length, 2);
  }
  const saved = JSON.stringify(sharedStorage);
  for (const secret of ['access-secret', 'refresh-secret', 'id_token', 'code-a', 'code-b']) assert.equal(saved.includes(secret), false);
  clean(a); clean(b);
});

test('refresh ID token may omit nonce or repeat original nonce while initial authorization always requires it', async () => {
  for (const refreshNonce of [undefined, 'original']) {
    const f = await load({ expires: 30, refreshClaims: {}, refreshNonce }); await login(f);
    assert.equal(await f.s.getChatGPTPlanAccessToken(), 'access-refreshed');
    assert.equal(f.s.getChatGPTPlanStatus().loggedIn, true);
    assert.equal(f.s.getChatGPTPlanStatus().planAuthorized, true);
  }
  const initialMissingNonce = await load({ claims: { nonce: undefined } });
  assert.equal((await login(initialMissingNonce)).loggedIn, false);
});

test('refresh ID token still rejects wrong nonce, signature, issuer, audience, subject and expiration', async () => {
  for (const options of [{ refreshClaims: { nonce: 'wrong-nonce' } }, { refreshClaims: {}, refreshCorrupt: true },
    { refreshClaims: { iss: 'https://wrong.example' } }, { refreshClaims: { aud: 'wrong-client' } },
    { refreshClaims: { sub: 'another-subject' } }, { refreshClaims: { exp: 1 } }]) {
    const f = await load({ expires: 30, ...options }); await login(f);
    await assert.rejects(f.s.getChatGPTPlanAccessToken(), /刷新失败/);
    assert.equal(f.s.getChatGPTPlanStatus().loggedIn, true, 'a rejected replacement must not overwrite validated identity');
    assert.equal(f.s.getChatGPTPlanStatus().account.subject, 'subject-fixture');
    await assert.rejects(f.s.getChatGPTPlanAccessToken(), /稍后重试/);
  }
});

test('refresh serializes rotating token, omits scope and uses issued client with resource', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await load({ expires: 30, refreshGate: gate }); await login(f);
  const requests = Array.from({ length: 8 }, () => f.s.getChatGPTPlanAccessToken());
  await tick(); release();
  assert.deepEqual(await Promise.all(requests), Array(8).fill('access-refreshed'));
  const refresh = f.calls.fetch.filter(c => new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token');
  assert.equal(refresh.length, 1);
  const body = new URLSearchParams(refresh[0].init.body);
  assert.equal(body.get('client_id'), 'oaiapp_fixture'); assert.equal(body.get('refresh_token'), 'refresh-secret');
  assert.equal(body.get('resource'), 'https://api.openai.com/v1'); assert.equal(body.has('scope'), false);
  assert.equal(JSON.stringify(f.calls.writes).includes('access-refreshed'), false);
  assert.equal((await f.s.signOutChatGPTPlan()).revocationConfirmed, true);
  const revoke = f.calls.fetch.find(c => c.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'refresh-rotated');
  assert.equal(f.s.getChatGPTPlanStatus().loggedIn, false);
});

test('sign-out during refresh immediately stops access and revokes the newest rotating token', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await load({ expires: 30, refreshGate: gate }); await login(f);
  const refreshing = f.s.getChatGPTPlanAccessToken();
  const rejected = assert.rejects(refreshing, /刷新失败/);
  const signingOut = f.s.signOutChatGPTPlan();
  assert.equal(f.s.getChatGPTPlanStatus().loggedIn, false);
  await assert.rejects(f.s.getChatGPTPlanAccessToken(), /计划推理权限/);
  release(); await rejected;
  assert.deepEqual(await signingOut, { revocationConfirmed: true });
  const revoke = f.calls.fetch.find(c => c.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'refresh-rotated');
});

test('confirmed invalid_grant ends session and never retries indefinitely', async () => {
  const f = await load({ expires: 30, refreshFails: true }); await login(f);
  await assert.rejects(f.s.getChatGPTPlanAccessToken(), error => {
    assert.equal(error.status, 400); assert.equal(error.code, 'invalid_grant'); assert.equal(error.requestId, 'req_fixture'); return true;
  });
  await assert.rejects(f.s.getChatGPTPlanAccessToken());
  assert.equal(f.s.getChatGPTPlanStatus().loggedIn, false);
  assert.equal(f.calls.fetch.filter(c => new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token').length, 1);
});

test('refreshed grant without plan scope preserves logged-in identity and denies inference', async () => {
  const f = await load({ expires: 30, refreshScope: 'openid email' }); await login(f);
  const account = f.s.getChatGPTPlanStatus().account;
  await assert.rejects(f.s.getChatGPTPlanAccessToken(), /计划推理权限已被撤销/);
  assert.equal(f.s.getChatGPTPlanStatus().loggedIn, true);
  assert.equal(f.s.getChatGPTPlanStatus().planAuthorized, false);
  assert.deepEqual(f.s.getChatGPTPlanStatus().account, account);
  await assert.rejects(f.s.getChatGPTPlanAccessToken(), /计划推理权限/);
  assert.equal((await f.s.signOutChatGPTPlan()).revocationConfirmed, true);
  const revoke = f.calls.fetch.find(c => c.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), 'refresh-rotated');
});

test('network and HTTP 503 preserve credentials, enforce bounded retry delay, and never return expired access tokens', async () => {
  for (const failure of [{ refreshNetworkFails: true }, { refreshError: { status: 503, code: 'temporarily_unavailable' } },
    { refreshError: { status: 503, code: 'invalid_grant' } }]) {
    const options = { expires: 1, ...failure };
    const f = await load(options); await login(f);
    const originalNow = Date.now; let now = originalNow() + 2000;
    Date.now = () => now;
    try {
      await assert.rejects(f.s.getChatGPTPlanAccessToken(), error => {
        assert.equal(error.code, failure.refreshNetworkFails ? 'network_error' : failure.refreshError.code);
        assert.equal(error.message.includes('access-secret'), false); return true;
      });
      assert.equal(f.s.getChatGPTPlanStatus().loggedIn, true);
      await assert.rejects(f.s.getChatGPTPlanAccessToken(), /稍后重试/);
      assert.equal(f.calls.fetch.filter(c => new URLSearchParams(c.init.body).get('grant_type') === 'refresh_token').length, 1);
      now += 1001; options.refreshNetworkFails = false; options.refreshError = undefined;
      assert.equal(await f.s.getChatGPTPlanAccessToken(), 'access-refreshed');
      assert.equal(f.s.getChatGPTPlanStatus().loggedIn, true);
    } finally { Date.now = originalNow; }
  }
});

test('same-account re-login survives success or failure of a previous session refresh', async () => {
  for (const refreshFails of [false, true]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const options = { expires: 30, refreshGate: gate, refreshFails };
    const f = await load(options); await login(f);
    const account = (await f.s.getChatGPTPlanAccounts())[0];
    const oldRefresh = f.s.getChatGPTPlanAccessToken();
    const rejected = assert.rejects(oldRefresh);
    options.expires = 3600; f.calls.navigation.length = 0;
    assert.equal((await login(f, {}, account.id)).loggedIn, true);
    release(); await rejected;
    assert.equal(f.s.getChatGPTPlanStatus().loggedIn, true);
    assert.equal(f.s.getChatGPTPlanStatus().error, undefined);
    assert.equal(await f.s.getChatGPTPlanAccessToken(), 'access-secret');
  }
});

test('authorization HTTP diagnostics expose only safe status, OAuth code and request ID', async () => {
  for (const code of ['invalid_grant', 'access-secret']) {
    const f = await load({ authError: { status: 400, code } });
    const status = await login(f);
    assert.equal(status.loggedIn, false);
    assert.match(status.error, /HTTP 400/);
    assert.match(status.error, /req_auth_fixture/);
    assert.match(status.error, new RegExp(code === 'invalid_grant' ? code : 'oauth_error'));
    for (const secret of ['access-secret', 'refresh-secret', 'raw-body', 'code-secret']) assert.equal(status.error.includes(secret), false);
  }
});

test('sign-out confirms remote revoke or reports bounded failed revocation, retaining only registration metadata', async () => {
  for (const revokeFails of [false, true]) {
    const f = await load({ revokeFails }); await login(f);
    assert.deepEqual(await f.s.signOutChatGPTPlan(), { revocationConfirmed: !revokeFails });
    assert.equal(f.s.getChatGPTPlanStatus().loggedIn, false);
    assert.equal(f.calls.fetch.filter(c => c.url.endsWith('/oauth/revoke')).length, revokeFails ? 2 : 1);
    assert.equal((await f.s.getChatGPTPlanAccounts()).length, 1);
    await assert.rejects(f.s.getChatGPTPlanAccessToken());
    if (revokeFails) assert.match(f.s.getChatGPTPlanStatus().error, /远程撤销未确认/);
  }
});

test('callback courier clears URL before messaging, displays no code, and sends no tokens', async () => {
  const order = []; const onMessage = event(); const onDisconnect = event();
  const output = { textContent: '' }; let sent;
  globalThis.document = { getElementById: () => output };
  globalThis.location = { search: '?code=callback-secret&state=s&client_id=c', pathname: '/oauth-callback.html' };
  globalThis.history = { replaceState: (...args) => { order.push('clear'); assert.equal(args[2], '/oauth-callback.html'); } };
  globalThis.chrome = { runtime: { connect: ({ name }) => {
    order.push('connect'); assert.equal(name, 'tabflow-chatgpt-plan-oauth-v1');
    return { onMessage, onDisconnect, disconnect() {}, postMessage(payload) { sent = structuredClone(payload); } };
  } } };
  await import(`data:text/javascript;base64,${Buffer.from(callbackSource).toString('base64')}`);
  assert.deepEqual(order, ['clear', 'connect']);
  assert.deepEqual(sent, { state: 's', code: 'callback-secret', client_id: 'c', error: undefined });
  onMessage.emit({ ok: true });
  assert.equal(output.textContent.includes('callback-secret'), false);
  assert.match(output.textContent, /授权验证完成/);
  delete globalThis.document; delete globalThis.location; delete globalThis.history;
});

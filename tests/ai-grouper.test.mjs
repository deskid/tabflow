import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/services/aiGrouper.ts', import.meta.url), 'utf8');
const builtinSource = await readFile(new URL('../src/services/builtinModel.ts', import.meta.url), 'utf8');
const builtinURL = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(builtinSource)).toString('base64')}`;
const builtinService = await import(builtinURL);
const outputText = stripTypeScriptTypes(source).replace("'./builtinModel'", JSON.stringify(builtinURL));
const api = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function mockNative(response, error) {
  globalThis.chrome = {
    runtime: {
      sendNativeMessage(host, request, callback) {
        assert.equal(host, 'com.tabflow.codex_bridge');
        this.lastError = error ? { message: error } : undefined;
        callback(response);
        this.lastError = undefined;
      },
    },
  };
}

test('successful transport preserves a logged-out account', async () => {
  mockNative({ success: true, account: { loggedIn: false, requiresOpenaiAuth: true } });
  assert.equal((await api.getLocalCodexAccount()).loggedIn, false);
});

test('missing native host is a visible connection error', async () => {
  mockNative(undefined, 'Specified native messaging host not found.');
  const account = await api.getLocalCodexAccount();
  assert.equal(account.loggedIn, false);
  assert.match(account.error, /host not found/);
});

test('failed model discovery returns an empty list and the actual error', async () => {
  mockNative({ success: false, error: 'Codex unavailable' });
  assert.deepEqual(await api.getLocalCodexModels(), { models: [], error: 'Codex unavailable' });
});

test('model discovery preserves dynamic ids and source', async () => {
  const models = [{ id: 'actual-configured-model', name: 'Configured model', isDefault: true }];
  mockNative({ success: true, models, source: 'codex-app-server' });
  assert.deepEqual(await api.getLocalCodexModels(), { models, source: 'codex-app-server' });
});

test('Codex classification errors propagate instead of invoking heuristics', async () => {
  mockNative({ success: false, error: 'Selected model is unavailable' });
  await assert.rejects(api.planGroupByAI([
    { id: 1, title: 'GitHub', url: 'https://github.com', groupId: -1 },
    { id: 2, title: 'GitLab', url: 'https://gitlab.com', groupId: -1 },
  ], { provider: 'codex_native' }), /Selected model is unavailable/);
});

test('an empty successful classification stays empty', async () => {
  mockNative({ success: true, groups: [] });
  assert.deepEqual(await api.planGroupByAI([], { provider: 'codex_native' }), []);
});


test('custom API base URL resolves to the chat endpoint', () => {
  const endpoint = (apiEndpoint) => api.resolveAPIEndpoint({ provider: 'custom', apiEndpoint });
  assert.equal(endpoint('http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:3425/v1/'), 'http://127.0.0.1:3425/v1/chat/completions');
  assert.equal(endpoint('http://127.0.0.1:3425'), 'http://127.0.0.1:3425/v1/chat/completions');
  assert.equal(endpoint('https://example.test/proxy/v1/chat/completions?api-version=1'), 'https://example.test/proxy/v1/chat/completions?api-version=1');
  assert.throws(() => endpoint('file:///tmp/api'));
  assert.throws(() => endpoint('http://user:password@example.test/v1'));
  assert.throws(() => endpoint(''));
});

function mockCloud(granted, fetcher) {
  globalThis.chrome = { permissions: { request: async (permissions) => {
    assert.deepEqual(permissions, { origins: ['http://127.0.0.1/*'] });
    return granted;
  } } };
  globalThis.fetch = fetcher;
}
const customSettings = { provider: 'custom', apiEndpoint: 'http://127.0.0.1:3425/v1', model: 'local-model' };

test('denied host permission prevents network access and heuristic fallback', async () => {
  mockCloud(false, () => { throw Error('Network must not be used'); });
  await assert.rejects(api.planGroupByAI([], customSettings), /授权/);
});

test('custom API supports keyless local servers and the correct POST endpoint', async () => {
  mockCloud(true, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3425/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(JSON.parse(options.body).model, 'local-model');
    return Response.json({ choices: [{ message: { content: '[{"name":"Group","color":"blue","tabIds":[1]}]' } }] });
  });
  assert.deepEqual(await api.planGroupByAI([], customSettings), [{ name: 'Group', color: 'blue', tabIds: [1] }]);
});

test('connection test reads models without sending tabs or invoking inference', async () => {
  mockCloud(true, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3425/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return Response.json({ data: [{ id: 'local-model' }] });
  });
  assert.deepEqual(await api.testAPIConnection({ ...customSettings, apiKey: 'test-key' }), { modelCount: 1 });
});

test('network and HTTP errors surface instead of silently using heuristics', async () => {
  mockCloud(true, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api.planGroupByAI([], customSettings), /无法连接/);
  mockCloud(true, async () => new Response('private server error', { status: 401 }));
  await assert.rejects(api.planGroupByAI([], customSettings), (error) => /401/.test(error.message) && !error.message.includes('private'));
});

test('custom API requires a model rather than substituting a cloud model', async () => {
  await assert.rejects(api.planGroupByAI([], { ...customSettings, model: '' }), /模型名称/);
});

test('manifest declares optional network hosts without granting all sites by default', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.host_permissions, undefined);
});


test('model discovery displays full IDs despite colliding display names and removes duplicate IDs', async () => {
  mockCloud(true, async () => Response.json({ data: [
    { id: 'route-a/model', display_name: 'Same Model' },
    { id: 'route-b/model', display_name: 'Same Model' },
    { id: 'route-c/model', name: 'Same Model' },
    { id: 'route-a/model', display_name: 'Same Model' },
    null, { id: '' }, { id: 42 },
  ] }));
  assert.deepEqual(await api.getAPIModels(customSettings), [
    { id: 'route-a/model', name: 'route-a/model' },
    { id: 'route-b/model', name: 'route-b/model' },
    { id: 'route-c/model', name: 'route-c/model' },
  ]);
});

test('automatic model discovery uses existing grants without prompting', async () => {
  let calls = 0;
  globalThis.chrome = { permissions: {
    contains: async () => true,
    request: () => { throw Error('Automatic discovery must not prompt'); },
  } };
  globalThis.fetch = async () => { calls++; return Response.json({ data: [{ id: 'saved-server-model' }] }); };
  assert.deepEqual(await api.getAPIModels(customSettings, { requestPermission: false }), [
    { id: 'saved-server-model', name: 'saved-server-model' },
  ]);
  assert.equal(calls, 1);
});

test('automatic discovery of an unapproved host waits for explicit connection', async () => {
  globalThis.chrome = { permissions: {
    contains: async () => false,
    request: () => { throw Error('Must not prompt'); },
  } };
  globalThis.fetch = () => { throw Error('Must not fetch before permission'); };
  await assert.rejects(api.getAPIModels(customSettings, { requestPermission: false }),
    (error) => error instanceof api.APIAccessRequiredError);
});


test('unavailable Chrome model never silently falls back to local rules', async () => {
  delete globalThis.LanguageModel;
  await assert.rejects(api.planGroupByAI([
    { id: 1, title: 'GitHub', url: 'https://github.com', groupId: -1 },
    { id: 2, title: 'GitLab', url: 'https://gitlab.com', groupId: -1 },
  ], { provider: 'chrome_builtin' }), /Prompt API/);
});

test('Chrome provider dispatches to modern LanguageModel and releases the session', async () => {
  let destroyed = false;
  class Session extends EventTarget {
    async prompt(input, options) {
      assert.ok(options.responseConstraint);
      assert.match(input, /English/);
      return JSON.stringify([{ name: 'Development', color: 'blue', tabIds: [1, 2] }]);
    }
    destroy() { destroyed = true; }
  }
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => new Session(),
  };
  await builtinService.checkBuiltinModel();
  const groups = await api.planGroupByAI([
    { id: 1, title: 'GitHub', url: 'https://github.com', groupId: -1 },
    { id: 2, title: 'GitLab', url: 'https://gitlab.com', groupId: -1 },
  ], { provider: 'chrome_builtin' });
  assert.deepEqual(groups, [{ name: 'Development', color: 'blue', tabIds: [1, 2] }]);
  assert.equal(destroyed, true);
  delete globalThis.LanguageModel;
});


test('domain fallback returns its actual method and original failure reason', async () => {
  mockCloud(true, async () => { throw new TypeError('Failed to fetch'); });
  const result = await api.planGroupingWithFallback([
    { id: 1, title: 'Code', url: 'https://github.com/one', groupId: -1 },
    { id: 2, title: 'Docs', url: 'https://github.com/two', groupId: -1 },
    { id: 3, title: 'Search', url: 'https://example.test', groupId: -1 },
  ], customSettings);
  assert.equal(result.method, 'domain');
  assert.equal(result.provider, 'custom');
  assert.match(result.fallbackReason, /无法连接/);
  assert.deepEqual(result.groups.map((group) => group.tabIds), [[1, 2]]);
});

test('fallback with no matching domains still reports the reason without inventing groups', async () => {
  mockCloud(true, async () => new Response('', { status: 401 }));
  const result = await api.planGroupingWithFallback([
    { id: 1, title: 'Code', url: 'https://github.com', groupId: -1 },
    { id: 2, title: 'Search', url: 'https://example.test', groupId: -1 },
  ], customSettings);
  assert.equal(result.method, 'domain');
  assert.match(result.fallbackReason, /401/);
  assert.deepEqual(result.groups, []);
});

test('local rules are recorded as the chosen method rather than a model success', async () => {
  const result = await api.planGroupingWithFallback([], { provider: 'heuristic' });
  assert.equal(result.method, 'local-rules');
  assert.equal(result.fallbackReason, undefined);
});

test('user cancellation never triggers domain rearrangement', async () => {
  let resolveCreate;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: () => new Promise((resolve) => { resolveCreate = resolve; }),
  };
  await builtinService.checkBuiltinModel();
  const task = api.planGroupingWithFallback([
    { id: 1, title: 'One', url: 'https://github.com/one', groupId: -1 },
    { id: 2, title: 'Two', url: 'https://github.com/two', groupId: -1 },
  ], { provider: 'chrome_builtin' });
  builtinService.cancelBuiltinModel();
  await assert.rejects(task, { name: 'AbortError' });
  resolveCreate({ destroy() {} });
  delete globalThis.LanguageModel;
});


test('preflight waiting is not treated as a failure requiring domain fallback', async () => {
  let creates = 0;
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: () => { creates++; throw Error('Creation must wait for a fresh click'); },
  };
  await assert.rejects(api.planGroupingWithFallback([
    { id: 1, title: 'One', url: 'https://github.com/one', groupId: -1 },
    { id: 2, title: 'Two', url: 'https://github.com/two', groupId: -1 },
  ], { provider: 'chrome_builtin' }), { name: 'BootstrapRequiredError' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 0);
  delete globalThis.LanguageModel;
});


test('partial model assignments keep semantic grouping and expose the Other count', async () => {
  let requests = 0;
  class Session extends EventTarget {
    async prompt() {
      requests++;
      return JSON.stringify({ assignments: requests === 1 ? { '1': 'Development' } : {} });
    }
    destroy() {}
  }
  globalThis.LanguageModel = { availability: async () => 'available', create: async () => new Session() };
  try {
    await builtinService.checkBuiltinModel();
    const result = await api.planGroupingWithFallback([
      { id: 1, title: 'Code', url: 'https://github.com/one', groupId: -1 },
      { id: 2, title: 'Search', url: 'https://example.test', groupId: -1 },
    ], { provider: 'chrome_builtin' });
    assert.equal(result.method, 'model');
    assert.equal(result.fallbackReason, undefined);
    assert.deepEqual(result.groups.flatMap((group) => group.tabIds).sort(), [1, 2]);
    assert.deepEqual(result.groups.find((group) => group.name === 'Other').tabIds, [2]);
    assert.ok(result.notices.some((notice) => /1 个标签.*Other/.test(notice)));
    assert.equal(requests, 2);
  } finally { delete globalThis.LanguageModel; }
});


test('Codex status uses one native request and whitelists account fields', async () => {
  const requests = [];
  globalThis.chrome = { runtime: { sendNativeMessage(_host, payload, callback) {
    requests.push(payload);
    callback({ success: true, type: 'STATUS', account: { loggedIn: true, requiresOpenaiAuth: true, authMode: 'chatgpt', email: 'private@example.test' }, models: [{ id: 'model-one', name: 'Model One', isDefault: true, secret: 'private' }] });
  } } };
  const result = await api.getLocalCodexStatus();
  assert.deepEqual(requests, [{ action: 'GET_CODEX_STATUS' }]);
  assert.deepEqual(result.account, { loggedIn: true, requiresOpenaiAuth: true, authMode: 'chatgpt' });
  assert.deepEqual(result.models, [{ id: 'model-one', name: 'Model One', isDefault: true }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('failed account status preserves models without inventing logged-out status', async () => {
  mockNative({ success: true, type: 'STATUS', accountError: '账号状态读取失败，点击刷新重试', accountRpcCode: -32603, models: [{ id: 'model-one', name: 'One' }] });
  const result = await api.getLocalCodexStatus();
  assert.equal(result.account, undefined);
  assert.match(result.accountError, /读取失败/);
  assert.match(result.accountError, /RPC -32603/);
  assert.equal(result.models[0].id, 'model-one');
  assert.equal(result.error, undefined);
});

test('failed model query preserves the real account and reports its own failure', async () => {
  mockNative({ success: true, type: 'STATUS', account: { loggedIn: false, requiresOpenaiAuth: false }, models: [], modelsError: '模型列表读取失败，点击刷新重试' });
  const result = await api.getLocalCodexStatus();
  assert.deepEqual(result.account, { loggedIn: false, requiresOpenaiAuth: false });
  assert.equal(result.accountError, undefined);
  assert.match(result.modelsError, /模型列表/);
});

test('unknown or malformed Codex status cannot masquerade as an account result', async () => {
  mockNative(undefined, 'Native host unavailable');
  assert.match((await api.getLocalCodexStatus()).error, /unavailable/);
  mockNative({ success: true, type: 'ACCOUNT', account: { loggedIn: true } });
  assert.match((await api.getLocalCodexStatus()).error, /格式无效/);
  mockNative({ success: true, type: 'STATUS', account: { loggedIn: true }, models: 'not-an-array' });
  const result = await api.getLocalCodexStatus();
  assert.equal(result.account, undefined);
  assert.match(result.accountError, /账号状态读取失败/);
  assert.deepEqual(result.models, []);
  assert.match(result.modelsError, /格式无效/);
});

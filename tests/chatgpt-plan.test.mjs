import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test, { beforeEach } from 'node:test';

const toURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const authURL = toURL(`
let state; let failToken=false; const listeners=new Set();
export function setState(value) { state=value; for (const listener of listeners) listener(); }
export function getChatGPTPlanStatus() { return state; }
export function setTokenFailure(value) { failToken=value; }
export async function getChatGPTPlanAccessToken() {
  if(failToken) { setState({loggedIn:false,planAuthorized:false}); throw Error('Renewal failed'); }
  return 'MOCK_ONLY_ACCESS_TOKEN';
}
export function subscribeChatGPTPlanSession(listener) { listeners.add(listener); return ()=>listeners.delete(listener); }
`);
const auth = await import(authURL);
const source = await readFile(new URL('../src/services/chatgptPlan.ts', import.meta.url), 'utf8');
const moduleURL = toURL(stripTypeScriptTypes(source).replace("'./chatgptPlanAuth'", JSON.stringify(authURL)));
const api = await import(moduleURL);
const tabs = [
  { id: 11, title: '代码', url: 'https://github.com/example?q=keep#fragment', groupId: -1 },
  { id: 22, title: '文档', url: 'https://developer.mozilla.org/', groupId: -1 },
];
const groups = [{ name: '研发资料', color: 'blue', tabIds: [11, 22] }];
const text = JSON.stringify({ groups });
const signedIn = { loggedIn: true, planAuthorized: true, account: { id: 'test-account', label: '测试账户' } };
function responseStream(events, chunkSize = 100000, contentType = 'text/event-stream') {
  const bytes = new TextEncoder().encode(events);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
    controller.close();
  } }), { headers: { 'content-type': contentType, 'x-request-id': 'req_test_1' } });
}
const event = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const completed = (output = text) => event({ type: 'response.completed', response: { status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text: output }] },
] } });

beforeEach(() => {
  auth.setTokenFailure(false);
  auth.setState({ ...signedIn });
  globalThis.chrome = { permissions: { contains: async () => true } };
  globalThis.fetch = async () => { throw new Error('Unexpected fetch'); };
});

test('model discovery uses only the signed-in plan endpoint and visible account catalog', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('Authorization'), 'Bearer MOCK_ONLY_ACCESS_TOKEN');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return Response.json({ models: [
      { slug: 'account-model-b', display_name: '账户 B', visibility: 'list' },
      { slug: 'not-visible', display_name: '隐藏', visibility: 'hidden' },
      { slug: 'account-model-a', display_name: '账户 A', visibility: 'list' },
      { slug: 'account-model-b', display_name: '重复', visibility: 'list' },
    ] });
  };
  assert.deepEqual(await api.getChatGPTPlanModels(), [
    { id: 'account-model-b', name: '账户 B' }, { id: 'account-model-a', name: '账户 A' },
  ]);
});

test('ordinary API-key data/id catalogs are not misrepresented as plan catalogs', async () => {
  globalThis.fetch = async () => Response.json({ data: [{ id: 'some-model' }] });
  await assert.rejects(api.getChatGPTPlanModels(), /models 数组/);
});

test('empty catalogs remain unavailable instead of inventing models', async () => {
  globalThis.fetch = async () => Response.json({ models: [] });
  await assert.rejects(api.getChatGPTPlanModels(), /未返回可显示/);
});

test('login, plan permission and site permission are checked before any API request', async () => {
  for (const state of [{ loggedIn: false, planAuthorized: false }, { loggedIn: true, planAuthorized: false }]) {
    auth.setState(state);
    await assert.rejects(api.getChatGPTPlanModels(), { name: 'BootstrapRequiredError' });
  }
  auth.setState(signedIn);
  globalThis.chrome.permissions.contains = async () => false;
  await assert.rejects(api.getChatGPTPlanModels(), { name: 'BootstrapRequiredError' });
});

test('classification uses the public Responses contract and preserves the requested model and URL data', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.get('Authorization'), 'Bearer MOCK_ONLY_ACCESS_TOKEN');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'account-model-selected');
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.input[0].role, 'user');
    assert.equal(JSON.parse(body.input[0].content)[0].url, tabs[0].url);
    assert.match(body.instructions, /按我的主题/);
    assert.equal(body.text.format.type, 'json_schema');
    for (const unsupported of ['temperature', 'max_output_tokens', 'previous_response_id', 'conversation', 'metadata']) assert.equal(unsupported in body, false);
    return responseStream(event({ type: 'response.output_text.delta', delta: text }) + completed());
  };
  assert.deepEqual(await api.planGroupByChatGPTPlan(tabs, { model: 'account-model-selected', customPrompt: '按我的主题分类' }), groups);
});

test('no model is silently chosen without the account model selection', async () => {
  await assert.rejects(api.planGroupByChatGPTPlan(tabs), { name: 'BootstrapRequiredError' });
  assert.deepEqual(await api.planGroupByChatGPTPlan([]), []);
});

test('UTF-8, CRLF and frame boundaries survive one-byte network chunks', async () => {
  assert.equal(await api.readChatGPTPlanResponse(responseStream(': heartbeat\r\n\r\n' + event({ type: 'response.output_text.delta', delta: text }) + completed(), 1)), text);
});

test('completed final output is authoritative over a partial delta', async () => {
  assert.equal(await api.readChatGPTPlanResponse(responseStream(event({ type: 'response.output_text.delta', delta: '{"groups":' }) + completed(), 5)), text);
});

test('an empty or missing final output cannot approve earlier delta text', async () => {
  for (const terminal of [completed(''), event({ type: 'response.completed', response: { status: 'completed', output: [] } })]) {
    await assert.rejects(api.readChatGPTPlanResponse(responseStream(event({ type: 'response.output_text.delta', delta: text }) + terminal)), /没有返回分组/);
  }
});

test('an EOF or DONE sentinel cannot approve partial output', async () => {
  for (const ending of ['', 'data: [DONE]\n\n']) {
    await assert.rejects(api.readChatGPTPlanResponse(responseStream(event({ type: 'response.output_text.delta', delta: text }) + ending)), /response.completed/);
  }
});

test('a terminal completion frame is accepted even without a final blank line', async () => {
  assert.equal(await api.readChatGPTPlanResponse(responseStream(completed().trimEnd(), 3)), text);
});

test('quota errors after partial text remain failures with the real code and request id', async () => {
  await assert.rejects(api.readChatGPTPlanResponse(responseStream(
    event({ type: 'response.output_text.delta', delta: text }) + event({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }),
  )), error => error instanceof api.ChatGPTPlanAPIError && error.code === 'subscription_sharing_usage_limit_exceeded' && error.requestId === 'req_test_1');
});

test('incomplete and invalid completion statuses never approve a grouping', async () => {
  for (const value of [
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    { type: 'response.completed', response: { status: 'failed' } },
  ]) await assert.rejects(api.readChatGPTPlanResponse(responseStream(event(value))));
});

test('wrong content types, malformed event JSON and empty model output fail', async () => {
  await assert.rejects(api.readChatGPTPlanResponse(responseStream('{}', 10, 'application/json')), /事件流/);
  await assert.rejects(api.readChatGPTPlanResponse(responseStream('data: {broken}\n\n')), /无效 JSON/);
  await assert.rejects(api.readChatGPTPlanResponse(responseStream(completed(''))), /没有返回分组/);
});

test('HTTP admission errors never fall through to another endpoint or billing route', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ detail: 'MOCK_ONLY_ACCESS_TOKEN raw upstream body' }, { status: 403, headers: { 'x-request-id': 'req_admission' } }); };
  await assert.rejects(api.planGroupByChatGPTPlan(tabs, { model: 'account-model-selected' }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.requestId, 'req_admission');
    assert.doesNotMatch(error.message, /MOCK_ONLY_ACCESS_TOKEN|raw upstream/);
    return true;
  });
  assert.equal(calls, 1);
});

test('signing out while a request is pending aborts that request', async () => {
  let started;
  const inFetch = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    started();
  });
  const result = api.getChatGPTPlanModels();
  await inFetch;
  auth.setState({ loggedIn: false, planAuthorized: false });
  await assert.rejects(result, { name: 'AbortError' });
});

test('validated grouping covers every input ID exactly once', () => {
  assert.deepEqual(api.validateChatGPTPlanGroups(text, tabs), groups);
  for (const invalid of [
    { groups: [{ name: '未知', color: 'blue', tabIds: [11, 999] }] },
    { groups: [{ name: '重复', color: 'blue', tabIds: [11, 22, 22] }] },
    { groups: [{ name: '遗漏', color: 'blue', tabIds: [11] }] },
    { groups: [{ name: '类型', color: 'blue', tabIds: ['11', 22] }] },
    { groups: [{ name: '颜色', color: 'ultraviolet', tabIds: [11, 22] }] },
    { groups: [{ name: '', color: 'blue', tabIds: [11, 22] }] },
    { groups: [] },
  ]) assert.throws(() => api.validateChatGPTPlanGroups(JSON.stringify(invalid), tabs));
});

test('the dispatcher routes the new provider through the subscription channel, not native messaging', async () => {
  const dispatcherSource = await readFile(new URL('../src/services/aiGrouper.ts', import.meta.url), 'utf8');
  const builtin = toURL('export function classifyWithBuiltinModel(){throw Error("Unexpected builtin")} export function getBuiltinModelState(){return {}}');
  const dispatch = await import(toURL(stripTypeScriptTypes(dispatcherSource)
    .replace("'./builtinModel'", JSON.stringify(builtin)).replace("'./chatgptPlan'", JSON.stringify(moduleURL))));
  globalThis.chrome.runtime = { sendNativeMessage() { throw new Error('Native host must not be called'); } };
  globalThis.fetch = async () => responseStream(completed());
  assert.deepEqual(await dispatch.planGroupByAI(tabs, { provider: 'chatgpt_plan', model: 'account-model-selected' }), groups);
  auth.setState({ loggedIn: false, planAuthorized: false });
  await assert.rejects(dispatch.planGroupingWithFallback(tabs, { provider: 'chatgpt_plan', model: 'account-model-selected' }), { name: 'BootstrapRequiredError' });
  auth.setState(signedIn);
  auth.setTokenFailure(true);
  globalThis.fetch = async () => { throw new Error('No inference after a revoked renewal'); };
  await assert.rejects(dispatch.planGroupingWithFallback(tabs, { provider: 'chatgpt_plan', model: 'account-model-selected' }), { name: 'AbortError' });
});

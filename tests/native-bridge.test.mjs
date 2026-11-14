import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AppServer, BridgeError, readAccount } from '../scripts/codex-app-server.mjs';
import { handleMessage, serve, frame, MAX_NATIVE_BYTES, validateGroups } from '../scripts/native-bridge.mjs';
const fixture = fileURLToPath(new URL('./fixtures/mock-codex-app-server.mjs', import.meta.url));
const factory = scenario => () => new AppServer({ launch: { command: process.execPath, args: [fixture] }, env: { ...process.env, TABFLOW_MOCK_SCENARIO: scenario || '' }, timeoutMs: scenario === 'timeout' ? 80 : 3000 });
const tabs = [{ id: 1, title: 'One', url: 'https://one.test' }, { id: 2, title: 'Two', url: 'https://two.test' }];
const classify = scenario => handleMessage({ action: 'CLASSIFY_TABS', tabs }, factory(scenario));
test('PING does not start app-server', async () => {
  const r = await handleMessage({ action: 'PING' }, () => { throw Error('must not launch'); });
  assert.equal(r.type, 'PONG'); assert.equal(r.source, 'codex-app-server');
});
test('account whitelists status and never exposes personal fields', async () => {
  const r = await handleMessage({ action: 'GET_ACCOUNT' }, factory());
  assert.deepEqual(r.account, { loggedIn: true, authMode: 'chatgpt', requiresOpenaiAuth: true });
  assert.ok(!JSON.stringify(r).includes('private'));
});
test('legacy account alias preserves logged-out state', async () => {
  const r = await handleMessage({ action: 'GET_CODEX_ACCOUNT' }, factory('logged-out'));
  assert.equal(r.success, true); assert.equal(r.account.loggedIn, false);
});
test('model list paginates and uses selectable model values', async () => {
  const r = await handleMessage({ action: 'GET_MODELS' }, factory('pagination'));
  assert.deepEqual(r.models.map(m => m.id), ['model-one', 'model-two']); assert.equal(r.models[0].isDefault, true);
});
test('empty model catalog is an explicit failure', async () => {
  const r = await handleMessage({ action: 'GET_MODELS' }, factory('empty-models'));
  assert.equal(r.success, false); assert.equal(r.errorCode, 'NO_MODELS'); assert.equal(r.models, undefined);
});
test('RPC errors redact arbitrary upstream messages', async () => {
  const r = await handleMessage({ action: 'GET_ACCOUNT' }, factory('rpc-error'));
  assert.equal(r.errorCode, 'CODEX_RPC_ERROR'); assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN')); assert.ok(!JSON.stringify(r).includes('private'));
});
for (const [scenario, expected] of [['timeout', 'CODEX_TIMEOUT'], ['exit', 'CODEX_EXITED']]) test(`server ${scenario} fails clearly`, async () => {
  const r = await handleMessage({ action: 'GET_MODELS' }, factory(scenario)); assert.equal(r.success, false); assert.equal(r.errorCode, expected);
});
test('classification uses ephemeral read-only thread, disabled tools and schema; handles early events', async () => {
  const r = await classify(); assert.equal(r.success, true); assert.equal(r.type, 'CLASSIFICATION'); assert.equal(r.modelUsed, 'model-one'); assert.deepEqual(r.groups[0].tabIds, [1, 2]);
});
test('saved unavailable model fails without starting a turn', async () => {
  const r = await handleMessage({ action: 'CLASSIFY_TABS', tabs, model: 'made-up-model' }, factory()); assert.equal(r.errorCode, 'MODEL_UNAVAILABLE');
});
for (const [scenario, expected] of [['bad-json', 'INVALID_CLASSIFICATION'], ['bad-color', 'INVALID_CLASSIFICATION'], ['bad-ids', 'INVALID_CLASSIFICATION'], ['turn-failed', 'CLASSIFICATION_FAILED'], ['tool-request', 'TOOLS_NOT_ALLOWED'], ['logged-out', 'NOT_LOGGED_IN']]) test(`classification rejects ${scenario} without fallback`, async () => {
  const r = await classify(scenario); assert.equal(r.success, false); assert.equal(r.errorCode, expected); assert.equal(r.fallback, undefined); assert.equal(r.groups, undefined);
});
function trackedFactory(scenario) {
  const calls = []; let clients = 0;
  return { calls, get clients() { return clients; }, create: () => {
    clients++;
    const client = factory(scenario)(); const request = client.request.bind(client);
    client.request = (method, params) => { calls.push(method); return request(method, params); };
    return client;
  } };
}
for (const [scenario, count, success] of [['account-transient', 2, true], ['account-persistent', 2, false], ['account-other-error', 1, false]]) test(`account retry policy: ${scenario}`, async () => {
  const tracked = trackedFactory(scenario);
  const r = await handleMessage({ action: 'GET_ACCOUNT' }, tracked.create);
  assert.equal(tracked.clients, 1); assert.equal(tracked.calls.filter(m => m === 'account/read').length, count);
  assert.equal(r.success, success);
  if (success) assert.equal(r.account.loggedIn, true);
  else {
    assert.equal(r.rpcCode, scenario === 'account-other-error' ? -32000 : -32603); assert.equal(r.method, 'account/read');
    assert.match(r.error, /账号状态读取失败，点击刷新重试/); assert.equal(r.account, undefined);
  }
  assert.ok(!JSON.stringify(r).includes('private')); assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN'));
});
test('account retry requires matching RPC method and code', async () => {
  for (const error of [new BridgeError('CODEX_RPC_ERROR', 'safe', { rpcCode: -32603, method: 'model/list' }), new BridgeError('CODEX_TIMEOUT', 'safe', { rpcCode: -32603, method: 'account/read' })]) {
    let calls = 0;
    await assert.rejects(readAccount({ request: async () => { calls++; throw error; } }), e => e === error);
    assert.equal(calls, 1);
  }
});
for (const scenario of ['', 'account-persistent', 'model-error', 'logged-out', 'rpc-error']) test(`combined status uses one client and retains partial truth: ${scenario || 'success'}`, async () => {
  const tracked = trackedFactory(scenario);
  const r = await handleMessage({ action: 'GET_CODEX_STATUS' }, tracked.create);
  assert.equal(tracked.clients, 1); assert.equal(r.success, true); assert.equal(r.type, 'STATUS'); assert.equal(r.source, 'codex-app-server');
  const accountCalls = scenario === 'account-persistent' ? ['account/read', 'account/read'] : ['account/read'];
  assert.deepEqual(tracked.calls, ['initialize', ...accountCalls, 'model/list']);
  if (scenario === 'account-persistent' || scenario === 'rpc-error') {
    assert.equal(r.account, undefined); assert.equal(r.accountError, '账号状态读取失败，点击刷新重试'); assert.equal(r.accountErrorCode, 'CODEX_RPC_ERROR');
  } else assert.equal(r.account.loggedIn, scenario !== 'logged-out');
  if (scenario === 'model-error' || scenario === 'rpc-error') {
    assert.deepEqual(r.models, []); assert.equal(r.modelsErrorCode, 'CODEX_RPC_ERROR');
  } else assert.equal(r.models.length, 1);
  assert.ok(!JSON.stringify(r).includes('private')); assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN'));
});
test('combined initialize failure remains an outer error without further RPC', async () => {
  const tracked = trackedFactory('initialize-error');
  const r = await handleMessage({ action: 'GET_CODEX_STATUS' }, tracked.create);
  assert.equal(r.success, false); assert.equal(r.type, 'ERROR'); assert.equal(r.rpcCode, -32603);
  assert.deepEqual(tracked.calls, ['initialize']);
});
test('missing account field is a read failure, never a logged-out assertion', async () => {
  const r = await handleMessage({ action: 'GET_CODEX_STATUS' }, factory('account-missing'));
  assert.equal(r.account, undefined); assert.equal(r.accountErrorCode, 'CODEX_PROTOCOL_ERROR'); assert.equal(r.models.length, 1);
});
for (const scenario of ['account-transient', 'account-persistent']) test(`classification checks actual account and applies bounded retry: ${scenario}`, async () => {
  const tracked = trackedFactory(scenario);
  const r = await handleMessage({ action: 'CLASSIFY_TABS', tabs }, tracked.create);
  assert.equal(tracked.calls.filter(m => m === 'account/read').length, 2);
  assert.equal(r.success, scenario === 'account-transient');
  if (scenario === 'account-persistent') { assert.equal(r.errorCode, 'CODEX_RPC_ERROR'); assert.ok(!tracked.calls.includes('thread/start')); assert.equal(r.groups, undefined); }
});
test('model RPC -32603 never retries', async () => {
  const tracked = trackedFactory('model-error');
  const r = await handleMessage({ action: 'GET_MODELS' }, tracked.create);
  assert.equal(r.success, false); assert.equal(r.rpcCode, -32603); assert.deepEqual(tracked.calls, ['initialize', 'model/list']);
});
test('group validation rejects duplicate IDs and missing coverage', () => {
  assert.throws(() => validateGroups([{ name: 'G', color: 'blue', tabIds: [1, 1] }], tabs));
  assert.throws(() => validateGroups([{ name: 'G', color: 'blue', tabIds: [1] }], tabs));
});
async function exchange(chunks, createClient) {
  const writes = [];
  const output = new Writable({ write(chunk, encoding, callback) { writes.push(Buffer.from(chunk)); callback(); } });
  await serve(Readable.from(chunks), output, createClient);
  const bytes = Buffer.concat(writes); const messages = []; let offset = 0;
  while (offset < bytes.length) { const size = bytes.readUInt32LE(offset); messages.push(JSON.parse(bytes.subarray(offset + 4, offset + 4 + size))); offset += 4 + size; }
  return messages;
}
test('native framing accepts fragmented and multiple frames in order', async () => {
  const bytes = Buffer.concat([frame({ action: 'GET_ACCOUNT' }), frame({ action: 'GET_MODELS' }), frame({ action: 'PING' })]);
  let active = 0; let max = 0;
  const real = factory();
  const tracked = () => { active++; max = Math.max(max, active); const c = real(); const close = c.close.bind(c); c.close = () => { if (!c.closed) active--; close(); }; return c; };
  const r = await exchange([bytes.subarray(0, 2), bytes.subarray(2, 11), bytes.subarray(11)], tracked);
  assert.deepEqual(r.map(m => m.type), ['ACCOUNT', 'MODELS', 'PONG']); assert.equal(max, 1);
});
test('malformed JSON does not desynchronize the next native frame', async () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(1);
  const r = await exchange([Buffer.concat([header, Buffer.from('{'), frame({ action: 'PING' })])]);
  assert.equal(r[0].errorCode, 'INVALID_JSON'); assert.equal(r[1].pong, true);
});
test('oversized length and truncated frames fail without allocation', async () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(MAX_NATIVE_BYTES + 1);
  assert.equal((await exchange([header]))[0].errorCode, 'MESSAGE_TOO_LARGE');
  assert.equal((await exchange([frame({ action: 'PING' }).subarray(0, 5)]))[0].errorCode, 'TRUNCATED_MESSAGE');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const url = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`;
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const nativeURL = url(await read('../src/services/nativeInference.ts'));
const cleanupURL = url(await read('../src/services/cleanup.ts'));
const protocolURL = url(await read('../src/services/chatgptSessionProtocol.ts'));
const cloudURL = url('export const requestCloudJSON = (...args) => globalThis.__cleanupCloud(...args);');
const hostURL = url('export async function ensureChatGPTSessionOffscreen() {}');
const api = await import(url((await read('../src/services/cleanupAI.ts'))
  .replace("'./cleanup'", JSON.stringify(cleanupURL)).replace("'./nativeInference'", JSON.stringify(nativeURL)).replace("'./aiGrouper'", JSON.stringify(cloudURL))
  .replace("'../background/chatgptSessionBackground'", JSON.stringify(hostURL)).replace("'./chatgptSessionProtocol'", JSON.stringify(protocolURL))));
const candidates = [{ id: 1, url: 'https://example.com/search?token=synthetic#private', title: 'search', groupTitle: '检索', lastUsed: 0, visits: 1 }];
const context = [{ ...candidates[0], id: 2, title: 'active context' }];
const decisions = [{ id: 1, action: 'archive', kind: 'reference', task: '设计资料', reason: '长期闲置的设计资料' }];
const customPrompt = '只归档闲置的设计资料，保留检索页。';

test('an older native host reports an actionable error without retrying as grouping or another provider', async () => {
  let calls = 0;
  globalThis.chrome = { runtime: {
    sendNativeMessage(_host, request, callback) {
      calls++; assert.equal(request.action, 'GENERATE_JSON');
      callback({ success: false, errorCode: 'UNKNOWN_ACTION', error: 'Unknown native bridge action.' });
    },
  } };
  globalThis.__cleanupCloud = () => { throw new Error('must not switch providers'); };
  await assert.rejects(api.decideCleanup(candidates, context, 'balanced', { provider: 'codex_native' }), /通用推理协议/);
  assert.equal(calls, 1);
});

for (const provider of ['custom', 'codex_native', 'chatgpt_plan']) test(`${provider} sends sanitized candidate metadata and validates returned identity`, async () => {
  const verify = (input, prompt) => {
    assert(!input.includes('token=')); assert(!input.includes('#private'));
    const payload = JSON.parse(input); assert.equal(payload.candidates[0].id, 1); assert.equal(payload.context[0].id, 2);
    assert(prompt.includes('不可信数据')); assert(prompt.includes(customPrompt));
    assert(prompt.includes('保护规则优先于清理策略')); return { decisions };
  };
  globalThis.chrome = { runtime: {
    sendNativeMessage(_host, request, callback) { assert.equal(request.action, 'GENERATE_JSON'); callback({ success: true, protocolVersion: 1, data: verify(request.input, request.instructions) }); },
    async sendMessage(request) { assert.equal(request.target, 'host'); assert.equal(request.command, 'cleanup'); return { ok: true, value: verify(request.args[0], request.args[1]) }; },
  } };
  globalThis.__cleanupCloud = async (_settings, prompt, input) => verify(input, prompt);
  assert.deepEqual(await api.decideCleanup(candidates, context, 'conservative', { provider, model: 'fixture' }, customPrompt), decisions);
  globalThis.__cleanupCloud = async () => ({ decisions: [{ ...decisions[0], id: 999 }] });
  if (provider === 'custom') await assert.rejects(api.decideCleanup(candidates, context, 'balanced', { provider }), /未知/);
});

for (const provider of ['custom', 'codex_native']) test(`${provider} requires all eight candidate IDs in structured output, excluding context`, async () => {
  const ids = [103, 110, 117, 124, 131, 138, 145, 152];
  const tabs = ids.map(id => ({ ...candidates[0], id }));
  const verify = schema => {
    assert.deepEqual(schema.properties.decisions.required, ids.map(String));
    assert.deepEqual(Object.keys(schema.properties.decisions.properties), ids.map(String));
    assert.equal(schema.properties.decisions.additionalProperties, false);
    const properties = schema.properties.decisions.properties;
    for (const id of ids) {
      assert.deepEqual(properties[id].required, ['action', 'kind', 'task', 'reason']);
      assert.equal(properties[id].additionalProperties, false);
    }
    return { decisions: Object.fromEntries([...ids].reverse().map(id => [id,
      { action: 'keep', kind: 'other', task: '工作资料', reason: '保留可能继续使用的资料' }])) };
  };
  globalThis.chrome = { runtime: { sendNativeMessage(_host, request, callback) {
    assert.equal(request.action, 'GENERATE_JSON');
    callback({ success: true, protocolVersion: 1, data: verify(request.outputSchema) });
  } } };
  globalThis.__cleanupCloud = async (_settings, _prompt, _input, schema) => verify(schema);
  const result = await api.decideCleanup(tabs, context, 'aggressive', { provider });
  assert.deepEqual(result.map(item => item.id).sort((a, b) => a - b), ids);
  assert(result.every(item => item.action === 'keep'));
});

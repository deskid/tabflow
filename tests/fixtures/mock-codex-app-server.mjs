import readline from 'node:readline';
const scenario = process.env.TABFLOW_MOCK_SCENARIO;
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ id, result });
const notice = (method, params) => send({ method, params });
let initialized = false;
let accountReads = 0;
const rpcError = (id, code) => send({ id, error: { code, message: 'private@example.invalid SECRET_TOKEN', data: { accountId: 'private-account-id', token: 'SECRET_TOKEN' } } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (!msg.method) continue;
  if (scenario === 'exit') process.exit(3);
  if (scenario === 'timeout') continue;
  if (msg.method === 'initialize') { if (scenario === 'initialize-error') rpcError(msg.id, -32603); else reply(msg.id, {}); continue; }
  if (msg.method === 'initialized') { initialized = true; continue; }
  if (!initialized) throw new Error('Missing initialize handshake');
  if (scenario === 'rpc-error') { send({ id: msg.id, error: { code: -32000, message: 'private@example.invalid SECRET_TOKEN' } }); continue; }
  if (msg.method === 'account/read') {
    accountReads++;
    if (scenario === 'account-transient' && accountReads === 1 || scenario === 'account-persistent') { rpcError(msg.id, -32603); continue; }
    if (scenario === 'account-other-error') { rpcError(msg.id, -32000); continue; }
    if (scenario === 'account-missing') { reply(msg.id, { requiresOpenaiAuth: true }); continue; }
    reply(msg.id, { requiresOpenaiAuth: true, account: scenario === 'logged-out' ? null : { type: 'chatgpt', email: 'private@example.invalid', planType: 'plus' }, userId: 'private-user-id' });
  } else if (msg.method === 'model/list') {
    if (scenario === 'model-error') { rpcError(msg.id, -32603); continue; }
    reply(msg.id, { data: scenario === 'empty-models' ? [] : [{ id: 'internal-id', model: msg.params.cursor ? 'model-two' : 'model-one', displayName: 'Official model', isDefault: !msg.params.cursor }], nextCursor: !msg.params.cursor && scenario === 'pagination' ? 'next-page' : null });
  } else if (msg.method === 'config/read') {
    reply(msg.id, { config: { mcp_servers: { dangerous_integration: { command: 'do-not-run' } } } });
  } else if (msg.method === 'thread/start') {
    const p = msg.params;
    if (!p.ephemeral || p.sandbox !== 'read-only' || p.approvalPolicy !== 'never' || p.config['mcp_servers.dangerous_integration.enabled'] !== false) throw new Error('Unsafe thread');
    if (!process.argv.includes('features.shell_tool=false') || !process.argv.includes('features.hooks=false')) throw new Error('Tools/hooks enabled');
    reply(msg.id, { thread: { id: 'test-thread' }, model: p.model || 'model-one' });
  } else if (msg.method === 'turn/start') {
    if (!msg.params.outputSchema || msg.params.sandboxPolicy.type !== 'readOnly' || msg.params.sandboxPolicy.networkAccess !== false) throw new Error('Unsafe turn');
    if (scenario === 'tool-request') send({ id: 'tool-request', method: 'item/commandExecution/requestApproval', params: { threadId: 'test-thread' } });
    const groups = [{ name: '测试', color: scenario === 'bad-color' ? 'invalid' : 'blue', tabIds: scenario === 'bad-ids' ? [999] : [1, 2] }];
    const item = { type: 'agentMessage', id: 'final', phase: 'final_answer', text: scenario === 'bad-json' ? 'not JSON' : JSON.stringify({ groups }) };
    // Deliberately race notifications ahead of the turn/start reply.
    notice('item/completed', { threadId: 'test-thread', turnId: 'turn-1', item });
    notice('turn/completed', { threadId: 'test-thread', turn: { id: 'turn-1', status: scenario === 'turn-failed' ? 'failed' : 'completed', items: [item] } });
    reply(msg.id, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
  }
}

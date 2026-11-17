import { BRIDGE_TIMEOUT, isRecord, publicAccount, publicStatus, restoreError, safeError, withTimeout } from '../services/chatgptSessionProtocol';
import type { BridgeMethod, SessionReply, SessionSender } from '../services/chatgptSessionProtocol';
import type { TabData } from '../services/aiGrouper';
import { CLEANUP_DECISION_SCHEMA } from '../services/cleanup';

type Listener = (...args: unknown[]) => void;
function eventAdapter() {
  const listeners = new Set<Listener>();
  return { addListener(listener: Listener) { listeners.add(listener); }, removeListener(listener: Listener) { listeners.delete(listener); },
    emit(...args: unknown[]) { for (const listener of [...listeners]) listener(...args); } };
}
const scope = globalThis as unknown as { postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void; chrome: unknown };
const bridgePending = new Map<number, { resolve: (reply: SessionReply) => void }>();
const ports = new Map<number, ReturnType<typeof virtualPort>>();
const onConnect = eventAdapter();
const onRemoved = eventAdapter();
let sequence = 0;
let core: typeof import('../services/chatgptPlanAuth') | undefined;
let model: typeof import('../services/chatgptPlan') | undefined;
let boot: Promise<void> | undefined;
function rpc(method: BridgeMethod, args: unknown[]): Promise<unknown> {
  const id = ++sequence;
  const reply = new Promise<SessionReply>(resolve => { bridgePending.set(id, { resolve }); });
  scope.postMessage({ type: 'bridge', id, method, args });
  return withTimeout(reply, BRIDGE_TIMEOUT).then(value => { if (!value.ok) throw restoreError(value.error); return value.value; }).finally(() => { bridgePending.delete(id); });
}
function virtualPort(id: number, name: string, sender: SessionSender) {
  let disconnected = false;
  const onMessage = eventAdapter(), onDisconnect = eventAdapter();
  return { name, sender, onMessage, onDisconnect,
    postMessage(message: unknown) { if (!disconnected) scope.postMessage({ type: 'portPost', id, message }); },
    disconnect() { if (disconnected) return; disconnected = true; ports.delete(id); scope.postMessage({ type: 'portDisconnect', id }); onDisconnect.emit(); },
    closed() { disconnected = true; onDisconnect.emit(); } };
}
async function initialize(extensionId: string, baseURL: string): Promise<void> {
  // Minimal shim is installed before dynamic import; the unchanged core owns every token.
  scope.chrome = {
    runtime: { id: extensionId, getURL: (path: string) => new URL(path, baseURL).href, onConnect },
    storage: { local: { get: (key: string) => rpc('storage.get', [key]), set: (value: unknown) => rpc('storage.set', [value]) } },
    permissions: { contains: (value: unknown) => rpc('permissions.contains', [value]),
      request: (value: unknown) => rpc('permissions.contains', [value]) },
    tabs: { onRemoved, create: (value: unknown) => rpc('tabs.create', [value]), update: (id: number, value: unknown) => rpc('tabs.update', [id, value]), remove: (id: number) => rpc('tabs.remove', [id]) },
    declarativeNetRequest: { RuleActionType: { REDIRECT: 'redirect' }, ResourceType: { MAIN_FRAME: 'main_frame' },
      updateSessionRules: (value: unknown) => rpc('dnr.updateSessionRules', [value]) },
  };
  core = await import('../services/chatgptPlanAuth');
  model = await import('../services/chatgptPlan');
  core.subscribeChatGPTPlanSession(() => { scope.postMessage({ type: 'status', status: publicStatus(core!.getChatGPTPlanStatus()) }); });
  scope.postMessage({ type: 'ready' });
}
async function dispatch(command: unknown, args: unknown[]): Promise<unknown> {
  await boot;
  if (!core || !model) throw new Error('ChatGPT 会话尚未初始化。');
  switch (command) {
    case 'cleanup': {
      if (args.length !== 3 || !args.every(arg => typeof arg === 'string') ||
        String(args[0]).length > 100_000 || String(args[1]).length > 16_000 || String(args[2]).length > 200) break;
      return model.requestCleanupJSON(args[0] as string, args[1] as string, args[2] as string, CLEANUP_DECISION_SCHEMA);
    }
    case 'initialize': if (args.length) break; return publicStatus(core.getChatGPTPlanStatus());
    case 'accounts': if (args.length) break; return (await core.getChatGPTPlanAccounts()).map(publicAccount);
    case 'signIn': if (args.length > 1 || args[0] !== undefined && typeof args[0] !== 'string') break; return publicStatus(await core.signInChatGPTPlan(args[0] as string | undefined));
    case 'signOut': if (args.length) break; return core.signOutChatGPTPlan();
    case 'models': if (args.length) break; return model.getChatGPTPlanModels();
    case 'group': {
      if (args.length < 2 || args.length > 3 || !Array.isArray(args[0]) || args[0].length > 10000 || typeof args[1] !== 'string' ||
        args[2] !== undefined && typeof args[2] !== 'string') break;
      const tabs = args[0];
      if (!tabs.every(tab => isRecord(tab) && Number.isSafeInteger(tab.id) && typeof tab.title === 'string' && typeof tab.url === 'string')) break;
      return model.planGroupByChatGPTPlan(tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, groupId: -1 })) as TabData[], { model: args[1], customPrompt: args[2] as string | undefined });
    }
  }
  throw new Error('无效的 ChatGPT 会话命令参数。');
}
scope.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (!isRecord(message)) return;
  if (message.type === 'boot') {
    if (boot || typeof message.extensionId !== 'string' || typeof message.baseURL !== 'string') return;
    boot = initialize(message.extensionId, message.baseURL);
    void boot.catch(() => { scope.postMessage({ type: 'bootError', error: { name: 'Error', message: 'ChatGPT 会话核心初始化失败。' } }); }); return;
  }
  if (message.type === 'bridgeReply' && typeof message.id === 'number') { bridgePending.get(message.id)?.resolve(message.reply as SessionReply); return; }
  if (message.type === 'command' && typeof message.id === 'number' && Array.isArray(message.args)) {
    void dispatch(message.command, message.args).then(value => scope.postMessage({ type: 'reply', id: message.id, reply: { ok: true, value } }),
      error => scope.postMessage({ type: 'reply', id: message.id, reply: { ok: false, error: safeError(error) } })); return;
  }
  if (message.type === 'tabRemoved') { onRemoved.emit(message.tabId); return; }
  if (typeof message.id !== 'number') return;
  if (message.type === 'portConnect' && isRecord(message.sender) && typeof message.name === 'string') {
    const port = virtualPort(message.id, message.name, message.sender as SessionSender); ports.set(message.id, port); onConnect.emit(port); return;
  }
  if (message.type === 'portMessage') { ports.get(message.id)?.onMessage.emit(message.message); return; }
  if (message.type === 'portDisconnect') { ports.get(message.id)?.closed(); ports.delete(message.id); }
});

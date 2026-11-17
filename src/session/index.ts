import { BRIDGE_TIMEOUT, OAUTH_CHANNEL, SESSION_CHANNEL, SESSION_DOCUMENT, SESSION_TIMEOUT, isRecord, isSessionRequest, safeError, trustedSender, withTimeout } from '../services/chatgptSessionProtocol';
import type { SessionReply } from '../services/chatgptSessionProtocol';

// The offscreen document holds the worker, never the credentials or auth/model modules.
const worker = new Worker(new URL('./chatgpt-session.worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, { resolve: (reply: SessionReply) => void; reject: (error: Error) => void }>();
const ports = new Map<number, chrome.runtime.Port>();
let sequence = 0;
let readyResolve!: () => void;
let readyReject!: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
void ready.catch(() => {});
function request(command: string, args: unknown[]): Promise<SessionReply> {
  const id = ++sequence;
  const response = new Promise<SessionReply>((resolve, reject) => { pending.set(id, { resolve, reject }); });
  worker.postMessage({ type: 'command', id, command, args });
  return withTimeout(response, SESSION_TIMEOUT).finally(() => { pending.delete(id); });
}
worker.addEventListener('error', () => {
  const error = new Error('ChatGPT 会话 worker 启动或运行失败。');
  readyReject(error); for (const item of pending.values()) item.reject(error); pending.clear();
});
worker.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (!isRecord(message)) return;
  if (message.type === 'ready') { readyResolve(); return; }
  if (message.type === 'bootError') { readyReject(new Error('ChatGPT 会话核心初始化失败。')); return; }
  if (message.type === 'reply' && typeof message.id === 'number') { pending.get(message.id)?.resolve(message.reply as SessionReply); return; }
  if (message.type === 'status') {
    void chrome.runtime.sendMessage({ channel: SESSION_CHANNEL, event: 'status', status: message.status }).catch(() => {}); return;
  }
  if (message.type === 'bridge') {
    void withTimeout(chrome.runtime.sendMessage({ channel: SESSION_CHANNEL, target: 'background', event: 'bridge', method: message.method, args: message.args }) as Promise<SessionReply>, BRIDGE_TIMEOUT)
      .then(reply => worker.postMessage({ type: 'bridgeReply', id: message.id, reply }), error => worker.postMessage({ type: 'bridgeReply', id: message.id, reply: { ok: false, error: safeError(error) } }));
    return;
  }
  if (message.type === 'portPost' && typeof message.id === 'number') {
    try { ports.get(message.id)?.postMessage(message.message); } catch { /* callback already closed */ } return;
  }
  if (message.type === 'portDisconnect' && typeof message.id === 'number') {
    const port = ports.get(message.id); ports.delete(message.id); try { port?.disconnect(); } catch { /* closed */ }
  }
});
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || message.channel !== SESSION_CHANNEL || message.target !== 'host') return;
  // Only the installed background entry may dispatch commands or privileged events.
  if (!trustedSender(sender, chrome.runtime.id, ['background.js'])) {
    sendResponse({ ok: false, error: { name: 'SecurityError', message: '拒绝未经授权的会话宿主请求。' } }); return;
  }
  if (message.event === 'tabRemoved' && Number.isInteger(message.tabId)) {
    worker.postMessage({ type: 'tabRemoved', tabId: message.tabId }); return;
  }
  if (message.event === 'ready') {
    void withTimeout(ready, 10_000).then(() => sendResponse({ ok: true, value: true }), error => sendResponse({ ok: false, error: safeError(error) })); return true;
  }
  if (message.event === 'groupBuiltin' && Array.isArray(message.tabs) && typeof message.customPrompt === 'string') {
    const { tabs, customPrompt } = message;
    void (async () => {
      const builtin = await import('../services/builtinModel');
      const state = await builtin.checkBuiltinModel();
      // Automatic grouping may use an installed model, but cannot initiate a download.
      if (state.status !== 'downloaded') throw new Error('内置模型尚不可用于自动归组，请先在设置中准备模型。');
      return builtin.classifyWithBuiltinModel(tabs, customPrompt);
    })().then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }
  if (!isSessionRequest(message)) { sendResponse({ ok: false, error: { name: 'SecurityError', message: '无效的会话命令。' } }); return; }
  void withTimeout(ready, 10_000).then(() => request(message.command, message.args)).then(sendResponse, error => sendResponse({ ok: false, error: safeError(error) }));
  return true;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== OAUTH_CHANNEL) return;
  if (!trustedSender(port.sender ?? {}, chrome.runtime.id, ['oauth-callback.html']) || !Number.isInteger(port.sender?.tab?.id)) { port.disconnect(); return; }
  const id = ++sequence;
  ports.set(id, port);
  // Descriptor comes exclusively from the real Chrome port, never runtime message data.
  const sender = { id: port.sender!.id, url: port.sender!.url, tab: { id: port.sender!.tab!.id }, frameId: port.sender!.frameId, documentId: port.sender!.documentId };
  worker.postMessage({ type: 'portConnect', id, name: port.name, sender });
  port.onMessage.addListener(message => { worker.postMessage({ type: 'portMessage', id, message }); });
  port.onDisconnect.addListener(() => { ports.delete(id); worker.postMessage({ type: 'portDisconnect', id }); });
});
worker.postMessage({ type: 'boot', extensionId: chrome.runtime.id, baseURL: chrome.runtime.getURL(''), hostURL: chrome.runtime.getURL(SESSION_DOCUMENT) });

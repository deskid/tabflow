import { BRIDGE_TIMEOUT, SESSION_CHANNEL, SESSION_DOCUMENT, SESSION_TIMEOUT, UI_PATHS, isRecord, isSessionRequest, safeError, trustedSender, withTimeout } from '../services/chatgptSessionProtocol';
import type { BridgeMethod, SessionReply } from '../services/chatgptSessionProtocol';

const HOST_KEY = 'tabflow.chatgptPlan.host.v1';
const ACCOUNTS_KEY = 'tabflow.chatgptPlan.registrations.v1';
const metadataKeys = [HOST_KEY, ACCOUNTS_KEY];
const origins = ['https://auth.openai.com/*', 'https://api.openai.com/*', 'http://127.0.0.1/*'];
function only(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).every(key => keys.includes(key)); }
function integer(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 0; }
function validMetadata(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).length || !only(value, metadataKeys)) return false;
  return Object.entries(value).every(([key, item]) => key === HOST_KEY
    ? typeof item === 'string' && /^urn:uuid:[0-9a-f-]{36}$/i.test(item)
    : Array.isArray(item) && item.length <= 1000 && item.every(account => isRecord(account) &&
      only(account, ['id', 'label', 'email', 'clientId', 'subject']) &&
      ['id', 'label', 'clientId', 'subject'].every(field => typeof account[field] === 'string' && String(account[field]).length <= 4096) &&
      (account.email === undefined || typeof account.email === 'string' && account.email.length <= 4096)));
}
function validAuthorizeURL(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 32768) return false;
  try { const url = new URL(value); return url.origin === 'https://auth.openai.com' && url.pathname === '/api/accounts/authorize' &&
    !url.hash && !url.username && !url.password && [...url.searchParams.keys()].every(key => [
      'client_id', 'ext_agent_host_id', 'response_type', 'redirect_uri', 'scope', 'resource', 'state', 'nonce',
      'code_challenge_method', 'code_challenge', 'agent_name_hint', 'login_hint'].includes(key)); } catch { return false; }
}
export function validateBridgeCall(method: unknown, args: unknown, extensionId: string): method is BridgeMethod {
  if (!Array.isArray(args)) return false;
  const [first, second] = args;
  switch (method) {
    case 'storage.get': return args.length === 1 && typeof first === 'string' && metadataKeys.includes(first);
    case 'storage.set': return args.length === 1 && validMetadata(first);
    case 'permissions.contains': return args.length === 1 && isRecord(first) && only(first, ['origins']) && Array.isArray(first.origins) && first.origins.length > 0 && first.origins.every(origin => origins.includes(String(origin)));
    case 'tabs.create': return args.length === 1 && isRecord(first) && only(first, ['url', 'active']) && first.url === 'about:blank' && first.active === true;
    case 'tabs.update': return args.length === 2 && integer(first) && isRecord(second) && only(second, ['url']) && validAuthorizeURL(second.url);
    case 'tabs.remove': return args.length === 1 && integer(first);
    case 'dnr.updateSessionRules': {
      if (args.length !== 1 || !isRecord(first) || !only(first, ['addRules', 'removeRuleIds'])) return false;
      if (first.removeRuleIds !== undefined && (!Array.isArray(first.removeRuleIds) || !first.removeRuleIds.every(integer))) return false;
      if (first.addRules !== undefined && (!Array.isArray(first.addRules) || first.addRules.length !== 1 || !first.addRules.every(rule => {
        if (!isRecord(rule) || !only(rule, ['id', 'priority', 'action', 'condition']) || !integer(rule.id) || rule.priority !== 1 || !isRecord(rule.action) || !isRecord(rule.condition)) return false;
        const { action, condition } = rule;
        return only(action, ['type', 'redirect']) && action.type === 'redirect' && isRecord(action.redirect) && only(action.redirect, ['regexSubstitution']) &&
          action.redirect.regexSubstitution === `chrome-extension://${extensionId}/oauth-callback.html\\1` &&
          only(condition, ['regexFilter', 'isUrlFilterCaseSensitive', 'tabIds', 'resourceTypes']) &&
          condition.regexFilter === '^http://127[.]0[.]0[.]1:1455/auth/callback([?].*)?$' && condition.isUrlFilterCaseSensitive === true &&
          Array.isArray(condition.tabIds) && condition.tabIds.length === 1 && condition.tabIds.every(integer) &&
          Array.isArray(condition.resourceTypes) && condition.resourceTypes.length === 1 && condition.resourceTypes[0] === 'main_frame';
      }))) return false;
      return first.addRules !== undefined || first.removeRuleIds !== undefined;
    }
    default: return false;
  }
}
async function bridge(method: BridgeMethod, args: unknown[]): Promise<unknown> {
  // This switch deliberately exposes no generic Chrome path traversal.
  switch (method) {
    case 'storage.get': return chrome.storage.local.get(args[0] as string);
    case 'storage.set': return chrome.storage.local.set(args[0] as Record<string, unknown>);
    case 'permissions.contains': return chrome.permissions.contains(args[0] as chrome.permissions.Permissions);
    case 'tabs.create': { const tab = await chrome.tabs.create(args[0] as chrome.tabs.CreateProperties); return { id: tab.id }; }
    case 'tabs.update': await chrome.tabs.update(args[0] as number, args[1] as chrome.tabs.UpdateProperties); return undefined;
    case 'tabs.remove': return chrome.tabs.remove(args[0] as number);
    case 'dnr.updateSessionRules': return chrome.declarativeNetRequest.updateSessionRules(args[0] as Parameters<typeof chrome.declarativeNetRequest.updateSessionRules>[0]);
  }
}
let creation: Promise<void> | undefined;
let registered = false;
export async function ensureChatGPTSessionOffscreen(): Promise<void> {
  if (creation) return creation;
  const flight = withTimeout((async () => {
    const url = chrome.runtime.getURL(SESSION_DOCUMENT);
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
    if (!contexts.length) {
      try { await chrome.offscreen.createDocument({ url: SESSION_DOCUMENT, reasons: [chrome.offscreen.Reason.WORKERS], justification: 'Keep the explicitly requested ChatGPT session in a dedicated worker without persisting credentials.' }); }
      catch (error) { if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] })).length) throw error; }
    }
    // Bounded startup handshake only; no periodic service-worker keepalive.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const reply = await withTimeout(chrome.runtime.sendMessage({ channel: SESSION_CHANNEL, target: 'host', event: 'ready' }) as Promise<SessionReply>, 10_000);
        if (reply?.ok) return;
      } catch { /* document script may still be loading */ }
      if (Date.now() >= deadline) throw new Error('ChatGPT 会话宿主启动超时。');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })(), BRIDGE_TIMEOUT);
  creation = flight;
  try { await flight; } finally { if (creation === flight) creation = undefined; }
}
export function registerChatGPTSessionBackground(): void {
  if (registered) return;
  registered = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRecord(message) || message.channel !== SESSION_CHANNEL || message.target !== 'background') return;
    const offscreen = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(SESSION_DOCUMENT);
    const ui = trustedSender(sender, chrome.runtime.id, UI_PATHS);
    if (message.event === 'bridge') {
      if (!offscreen || !validateBridgeCall(message.method, message.args, chrome.runtime.id)) {
        sendResponse({ ok: false, error: { name: 'SecurityError', message: '拒绝未经授权的会话桥接请求。' } }); return;
      }
      void withTimeout(bridge(message.method, message.args as unknown[]), BRIDGE_TIMEOUT).then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: safeError(error) }));
      return true;
    }
    if (!ui || !isSessionRequest(message)) { sendResponse({ ok: false, error: { name: 'SecurityError', message: '拒绝未经授权的会话请求。' } }); return; }
    void (async () => {
      await ensureChatGPTSessionOffscreen();
      return await withTimeout(chrome.runtime.sendMessage({ ...message, target: 'host' }) as Promise<SessionReply>, SESSION_TIMEOUT);
    })().then(sendResponse, error => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    // Broadcast only; a closed UI or removed tab never destroys the host.
    void chrome.runtime.sendMessage({ channel: SESSION_CHANNEL, target: 'host', event: 'tabRemoved', tabId }).catch(() => {});
  });
}

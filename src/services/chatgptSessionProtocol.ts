import type { ChatGPTPlanAccount, ChatGPTPlanStatus } from './chatgptPlanAuth';

export const SESSION_CHANNEL = 'tabflow-chatgpt-session-v1';
export const OAUTH_CHANNEL = 'tabflow-chatgpt-plan-oauth-v1';
export const SESSION_DOCUMENT = 'chatgpt-session.html';
export const SESSION_ORIGINS = ['https://auth.openai.com/*', 'https://api.openai.com/*', 'http://127.0.0.1/*'];
export const SESSION_TIMEOUT = 210_000;
export const BRIDGE_TIMEOUT = 25_000;
export const UI_PATHS = ['options.html', 'popup.html', 'sidepanel.html'] as const;
export type SessionCommand = 'initialize' | 'accounts' | 'signIn' | 'signOut' | 'models' | 'group' | 'cleanup';
export type BridgeMethod = 'storage.get' | 'storage.set' | 'tabs.create' | 'tabs.update' | 'tabs.remove' | 'permissions.contains' | 'dnr.updateSessionRules';
export interface SafeSessionError { name: string; message: string; status?: number; code?: string; requestId?: string }
export type SessionReply = { ok: true; value: unknown } | { ok: false; error: SafeSessionError };
export interface SessionRequest { channel: typeof SESSION_CHANNEL; target: 'background' | 'host'; command: SessionCommand; args: unknown[] }
export interface SessionSender { id?: string; url?: string; tab?: { id?: number }; frameId?: number; documentId?: string }
export function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function trustedSender(sender: SessionSender, extensionId: string, paths: readonly string[]): boolean {
  if (sender.id !== extensionId || typeof sender.url !== 'string') return false;
  try { const url = new URL(sender.url); return url.protocol === 'chrome-extension:' && url.hostname === extensionId && paths.includes(url.pathname.slice(1)); } catch { return false; }
}
export function isSessionRequest(value: unknown): value is SessionRequest {
  return isRecord(value) && value.channel === SESSION_CHANNEL && ['background', 'host'].includes(String(value.target)) &&
    ['initialize', 'accounts', 'signIn', 'signOut', 'models', 'group', 'cleanup'].includes(String(value.command)) && Array.isArray(value.args);
}
export function safeError(error: unknown): SafeSessionError {
  // Core messages already exclude HTTP bodies and credentials. Never clone Error objects/stacks.
  if (!(error instanceof Error)) return { name: 'Error', message: 'ChatGPT 会话请求失败。' };
  const source = error as Error & { status?: unknown; code?: unknown; requestId?: unknown };
  return { name: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(source.name) ? source.name : 'Error', message: source.message.slice(0, 2048),
    ...(typeof source.status === 'number' && Number.isInteger(source.status) ? { status: source.status } : {}),
    ...(typeof source.code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(source.code) ? { code: source.code } : {}),
    ...(typeof source.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(source.requestId) ? { requestId: source.requestId } : {}) };
}
export function restoreError(value: SafeSessionError): Error {
  const error = new Error(value.message); error.name = value.name;
  for (const key of ['status', 'code', 'requestId'] as const) if (value[key] !== undefined) Object.assign(error, { [key]: value[key] });
  return error;
}
export function withTimeout<T>(promise: Promise<T>, milliseconds = BRIDGE_TIMEOUT): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { const error = new Error('ChatGPT 会话通信超时，请重试。'); error.name = 'TimeoutError'; reject(error); }, milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function publicAccount(value: ChatGPTPlanAccount): ChatGPTPlanAccount {
  return { id: value.id, label: value.label, clientId: value.clientId, subject: value.subject, ...(value.email ? { email: value.email } : {}) };
}
export function publicStatus(value: ChatGPTPlanStatus): ChatGPTPlanStatus {
  return Object.freeze({ loggedIn: value.loggedIn === true, planAuthorized: value.planAuthorized === true,
    ...(value.account ? { account: Object.freeze(publicAccount(value.account)) } : {}), ...(value.error ? { error: value.error } : {}) });
}

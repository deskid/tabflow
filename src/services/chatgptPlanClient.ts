import type { ChatGPTPlanAccount, ChatGPTPlanStatus } from './chatgptPlanAuth';
import type { CodexModel, ProposedGroup, TabData } from './aiGrouper';
import { SESSION_CHANNEL, SESSION_DOCUMENT, SESSION_ORIGINS, SESSION_TIMEOUT, isRecord, publicStatus, restoreError, trustedSender, withTimeout } from './chatgptSessionProtocol';
import type { SessionCommand, SessionReply } from './chatgptSessionProtocol';
export type { ChatGPTPlanAccount, ChatGPTPlanStatus } from './chatgptPlanAuth';

let cached: ChatGPTPlanStatus = Object.freeze({ loggedIn: false, planAuthorized: false });
const listeners = new Set<() => void>();
let listening = false;
let revision = 0;
let hydration: Promise<ChatGPTPlanStatus> | undefined;
function publish(status: ChatGPTPlanStatus) {
  revision++;
  cached = publicStatus(status);
  for (const listener of listeners) { try { listener(); } catch { /* isolate consumers */ } }
}
function listen() {
  if (listening) return;
  listening = true;
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!trustedSender(sender, chrome.runtime.id, [SESSION_DOCUMENT]) || !isRecord(message) ||
      message.channel !== SESSION_CHANNEL || message.event !== 'status' || !isRecord(message.status)) return;
    publish(message.status as unknown as ChatGPTPlanStatus);
  });
}
async function command<T>(name: SessionCommand, args: unknown[] = []): Promise<T> {
  listen();
  const reply = await withTimeout(chrome.runtime.sendMessage({ channel: SESSION_CHANNEL, target: 'background', command: name, args }) as Promise<SessionReply>, SESSION_TIMEOUT);
  if (!reply || !reply.ok) throw reply && !reply.ok ? restoreError(reply.error) : new Error('ChatGPT 会话后台未响应。');
  return reply.value as T;
}
export function getChatGPTPlanStatus(): ChatGPTPlanStatus { return cached; }
export function initializeChatGPTPlanSession(): Promise<ChatGPTPlanStatus> {
  if (!hydration) {
    const startedAt = revision;
    const flight = command<ChatGPTPlanStatus>('initialize').then(status => { if (revision === startedAt) publish(status); return cached; });
    hydration = flight;
    void flight.finally(() => { if (hydration === flight) hydration = undefined; }).catch(() => {});
  }
  return hydration;
}
export function subscribeChatGPTPlanSession(listener: () => void): () => void {
  listen(); listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getChatGPTPlanAccounts(): Promise<ChatGPTPlanAccount[]> { return command('accounts'); }
export async function signInChatGPTPlan(accountId?: string): Promise<ChatGPTPlanStatus> {
  // Must be invoked synchronously by the UI's explicit click, before any await/RPC.
  const granted = chrome.permissions.request({ origins: [...SESSION_ORIGINS] });
  if (!await granted) throw new Error('未授予 OpenAI 授权所需的可选网站权限。');
  const startedAt = revision;
  const status = await command<ChatGPTPlanStatus>('signIn', accountId === undefined ? [] : [accountId]);
  if (revision === startedAt) publish(status);
  return cached;
}
export function signOutChatGPTPlan(): Promise<{ revocationConfirmed: boolean }> { return command('signOut'); }
export function getChatGPTPlanModels(): Promise<CodexModel[]> { return command('models'); }
export function planGroupByChatGPTPlan(tabs: TabData[], settings: { model?: string; customPrompt?: string } = {}): Promise<ProposedGroup[]> {
  const args: unknown[] = [tabs, settings.model ?? ''];
  if (typeof settings.customPrompt === 'string') args.push(settings.customPrompt);
  return command('group', args);
}

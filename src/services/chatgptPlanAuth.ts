/* Experimental SIWC browser adapter. OpenAI documents a loopback listener, not this
 * tab-scoped DNR redirect. This adapter has not been confirmed by OpenAI or tested
 * with a real account. Tokens deliberately live only in this page's memory. */
export interface ChatGPTPlanAccount {
  id: string;
  label: string;
  email?: string;
  clientId: string;
  subject: string;
}
export interface ChatGPTPlanStatus {
  loggedIn: boolean;
  planAuthorized: boolean;
  account?: ChatGPTPlanAccount;
  error?: string;
}
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const CALLBACK = 'http://127.0.0.1:1455/auth/callback';
const CHANNEL = 'tabflow-chatgpt-plan-oauth-v1';
const STORAGE = 'tabflow.chatgptPlan.registrations.v1';
const HOST = 'tabflow.chatgptPlan.host.v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED = ['resource.invoke', 'chatgpt.tokens.use.direct'];
const TIMEOUT = 180_000;
interface Claims { sub: string; email?: string; name?: string; nonce?: string; [key: string]: unknown }
interface TokenSet {
  accessToken: string; refreshToken?: string; idToken: string;
  scopes: string[]; expiresAt: number; earliestRefreshAt: number;
}
interface Session extends TokenSet { account: ChatGPTPlanAccount; nonce: string; refreshRetryAt?: number; refreshFailures?: number }
export class ChatGPTPlanOAuthError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(code: string, status?: number, requestId?: string) {
    super(`OpenAI OAuth ${status ? `HTTP ${status} ` : ''}${code}${requestId ? ` (request_id=${requestId})` : ''}`);
    this.name = 'ChatGPTPlanOAuthError'; this.status = status; this.code = code; this.requestId = requestId;
  }
}
const SAFE_CODES = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'invalid_token', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable', 'rate_limit_exceeded']);
async function responseError(response: Response): Promise<ChatGPTPlanOAuthError> {
  let code = 'oauth_error';
  try {
    const data = await response.json();
    const candidate = typeof data.error === 'string' ? data.error : data.error?.code;
    if (SAFE_CODES.has(candidate)) code = candidate;
  } catch { /* Never include raw response bodies or error_description. */ }
  const header = response.headers.get('x-request-id');
  const requestId = header && /^req_[a-zA-Z0-9_-]{1,96}$/.test(header) ? header : undefined;
  return new ChatGPTPlanOAuthError(code, response.status, requestId);
}
function diagnostic(error: unknown): string {
  return error instanceof ChatGPTPlanOAuthError ? ` ${error.message}` : '';
}
let session: Session | undefined;
let status: ChatGPTPlanStatus = Object.freeze({ loggedIn: false, planAuthorized: false });
const listeners = new Set<() => void>();
let activeAttempt: { cancel: () => Promise<void> } | undefined;
let refreshFlight: Promise<string> | undefined;
let generation = 0;
const metadataQueues = new Map<string, Promise<void>>();
function withMetadataLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  // Web Locks coordinate extension pages of the same origin. The module queue
  // supports non-browser test environments; it is not cross-page coordination.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(key, action);
  const previous = metadataQueues.get(key) ?? Promise.resolve();
  const result = previous.then(action);
  const tail = result.then(() => {}, () => {});
  metadataQueues.set(key, tail);
  void tail.then(() => { if (metadataQueues.get(key) === tail) metadataQueues.delete(key); });
  return result;
}
function publish(error?: string) {
  status = Object.freeze({ loggedIn: !!session, planAuthorized: !!session && authorized(session.scopes),
    ...(session ? { account: Object.freeze({ ...session.account }) } : {}), ...(error ? { error } : {}) });
  for (const listener of listeners) { try { listener(); } catch { /* isolate UI listeners */ } }
}
export function getChatGPTPlanStatus(): ChatGPTPlanStatus { return status; }
export function subscribeChatGPTPlanSession(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function authorized(scopes: string[]) { return REQUIRED.every(scope => scopes.includes(scope)); }
function fail(message: string): never { throw new Error(message); }
function random(): string { return b64(crypto.getRandomValues(new Uint8Array(32))); }
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unb64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) fail('无效的 ID token 编码。');
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(20_000) });
  } catch { throw new ChatGPTPlanOAuthError('network_error'); }
}
async function discovery() {
  const response = await request(`${ISSUER}/.well-known/openid-configuration`);
  if (!response.ok) throw await responseError(response);
  const config = await response.json();
  if (config.issuer !== ISSUER || config.jwks_uri !== `${ISSUER}/.well-known/jwks.json`
    || config.revocation_endpoint !== `${ISSUER}/api/accounts/oauth/revoke`) fail('OpenAI 授权配置验证失败。');
  return config as { jwks_uri: string; revocation_endpoint: string };
}
async function validateIdToken(token: string, clientId: string, nonce: string, refreshing = false): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) fail('无效的 ID token。');
  const header = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) fail('不支持的 ID token 签名。');
  const config = await discovery();
  const response = await request(config.jwks_uri);
  if (!response.ok) throw await responseError(response);
  const jwks = await response.json();
  const keys = Array.isArray(jwks.keys) ? jwks.keys.filter((key: JsonWebKey & { kid?: string }) =>
    key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig')) : [];
  if (keys.length !== 1) fail('未找到唯一的 OpenAI 签名公钥。');
  const key = await crypto.subtle.importKey('jwk', keys[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) fail('ID token 签名验证失败。');
  const claims = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
  const now = Math.floor(Date.now() / 1000);
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (claims.iss !== ISSUER) fail('ID token issuer 验证失败。');
  if (!Array.isArray(audiences) || !audiences.includes(clientId)
    || (audiences.length > 1 && claims.azp !== clientId)
    || (claims.azp !== undefined && claims.azp !== clientId)) fail('ID token audience 验证失败。');
  if (!Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat)
    || claims.iat > now + 60 || claims.iat >= claims.exp
    || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + 60))) fail('ID token 已过期或时间无效。');
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) fail('ID token 缺少账户身份。');
  // OIDC Core 1.0 §12.2: a refreshed ID token may omit nonce. If included,
  // it must match the original authorization; initial sign-in always requires it.
  if ((!refreshing || claims.nonce !== undefined) && claims.nonce !== nonce) fail('ID token nonce 验证失败。');
  return claims as Claims;
}
function tokenSet(data: Record<string, unknown>, previous?: TokenSet): TokenSet {
  if (typeof data.access_token !== 'string' || !data.access_token || data.token_type !== 'Bearer'
    || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) fail('OpenAI token 响应无效。');
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
  return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    idToken: typeof data.id_token === 'string' ? data.id_token : previous?.idToken ?? '', scopes,
    expiresAt: Date.now() + data.expires_in * 1000,
    earliestRefreshAt: typeof data.earliest_refresh_at === 'number' ? data.earliest_refresh_at * 1000 : 0 };
}
async function exchange(body: URLSearchParams, signal?: AbortSignal) {
  const response = await request(`${ISSUER}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal });
  if (!response.ok) throw await responseError(response);
  return await response.json() as Record<string, unknown>;
}
export async function getChatGPTPlanAccounts(): Promise<ChatGPTPlanAccount[]> {
  const saved = (await chrome.storage.local.get(STORAGE))[STORAGE];
  if (!Array.isArray(saved)) return [];
  return saved.filter((a): a is ChatGPTPlanAccount => a && typeof a.id === 'string' && typeof a.subject === 'string'
    && typeof a.clientId === 'string' && a.clientId !== 'dynamic_agent_client' && typeof a.label === 'string')
    .map((a, index) => ({ id: a.id,
      label: a.label.includes(a.clientId) || a.label.includes(a.subject) ? `${a.email ?? 'ChatGPT 账户'} · 注册 ${index + 1}` : a.label,
      clientId: a.clientId, subject: a.subject,
      ...(typeof a.email === 'string' ? { email: a.email } : {}) }));
}
async function hostId(): Promise<string> {
  return withMetadataLock(HOST, async () => {
    const saved = (await chrome.storage.local.get(HOST))[HOST];
    if (typeof saved === 'string' && /^urn:uuid:[0-9a-f-]{36}$/i.test(saved)) return saved;
    const host = `urn:uuid:${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [HOST]: host }); return host;
  });
}
export async function signInChatGPTPlan(accountId?: string): Promise<ChatGPTPlanStatus> {
  if (activeAttempt) fail('已有 ChatGPT 登录正在进行。');
  // Invoke before the first await, while the explicit sign-in click has user activation.
  const permission = chrome.permissions.request({ origins: ['https://auth.openai.com/*', 'https://api.openai.com/*', 'http://127.0.0.1/*'] });
  const epoch = generation;
  const abort = new AbortController();
  let tabId: number | undefined;
  const ruleId = crypto.getRandomValues(new Uint32Array(1))[0] % 2_000_000_000 + 1;
  let ruleInstalled = false;
  let consumed = false;
  let settled = false;
  let resolveResult!: (status: ChatGPTPlanStatus) => void;
  const result = new Promise<ChatGPTPlanStatus>(resolve => { resolveResult = resolve; });
  let timer: ReturnType<typeof setTimeout>;
  const ports = new Set<chrome.runtime.Port>();
  const cleanup = async () => {
    clearTimeout(timer); abort.abort();
    chrome.runtime.onConnect.removeListener(onConnect);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    globalThis.removeEventListener?.('pagehide', onPageHide);
    let cleanupFailed = false;
    if (ruleInstalled) {
      try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); }
      catch { cleanupFailed = true; }
    }
    if (tabId !== undefined) { try { await chrome.tabs.remove(tabId); } catch { /* already closed */ } }
    for (const port of ports) { try { port.disconnect(); } catch { /* closed */ } }
    activeAttempt = undefined;
    return cleanupFailed;
  };
  const finish = async (error?: string) => {
    if (settled) return;
    settled = true;
    const cleanupFailed = await cleanup();
    publish(cleanupFailed ? 'OAuth 重定向规则清理失败，请关闭扩展或重启浏览器。' : error);
    resolveResult(status);
  };
  const onPageHide = () => { void finish('扩展页面已关闭，登录已取消。'); };
  const onRemoved = (id: number) => { if (id === tabId) void finish('ChatGPT 登录已取消。'); };
  const onConnect = (port: chrome.runtime.Port) => {
    if (port.name !== CHANNEL) return;
    if (port.sender?.id !== chrome.runtime.id || port.sender?.tab?.id !== tabId
      || port.sender?.url?.split('?')[0] !== chrome.runtime.getURL('oauth-callback.html')) { port.disconnect(); return; }
    ports.add(port);
    port.onMessage.addListener((message: unknown) => { void handleCallback(port, message); });
  };
  let state = ''; let nonce = ''; let verifier = ''; let selected: ChatGPTPlanAccount | undefined;
  const handleCallback = async (port: chrome.runtime.Port, message: unknown) => {
    if (settled || consumed) return;
    consumed = true; // Every callback is single-use, including failures.
    try {
      const data = message as Record<string, unknown>;
      if (!data || data.state !== state) fail('OAuth state 验证失败。');
      if (data.error) throw new ChatGPTPlanOAuthError(typeof data.error === 'string' && SAFE_CODES.has(data.error) ? data.error : 'oauth_error');
      if (typeof data.code !== 'string' || !data.code) fail('OAuth 回调缺少授权码。');
      const issuedId = selected?.clientId ?? data.client_id;
      if (typeof issuedId !== 'string' || !issuedId || issuedId === 'dynamic_agent_client'
        || (selected && data.client_id !== undefined && data.client_id !== selected.clientId)) fail('OAuth issued client_id 验证失败。');
      const tokens = tokenSet(await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: issuedId,
        code: data.code, code_verifier: verifier, redirect_uri: CALLBACK, resource: RESOURCE }), abort.signal));
      const claims = await validateIdToken(tokens.idToken, issuedId, nonce);
      if (selected && claims.sub !== selected.subject) fail('登录账户与所选注册账户不一致。');
      if (settled || generation !== epoch) return;
      const account = await withMetadataLock(STORAGE, async () => {
        if (settled || generation !== epoch) return undefined;
        const accounts = await getChatGPTPlanAccounts();
        if (settled || generation !== epoch) return undefined;
        const verified: ChatGPTPlanAccount = { id: selected?.id ?? `${issuedId}:${claims.sub}`, clientId: issuedId, subject: claims.sub,
          label: selected?.label ?? `${typeof claims.email === 'string' ? claims.email : typeof claims.name === 'string' ? claims.name : 'ChatGPT 账户'} · 注册 ${accounts.length + 1}`,
          ...(typeof claims.email === 'string' ? { email: claims.email } : {}) };
        await chrome.storage.local.set({ [STORAGE]: [...accounts.filter(a => a.id !== verified.id), verified] });
        return verified;
      });
      if (!account || settled || generation !== epoch) return;
      generation++;
      session = { ...tokens, account, nonce };
      refreshFlight = undefined; // A previous session's refresh must not gate this new login.
      try { port.postMessage({ ok: true }); } catch { /* Session is verified; a closed courier is only a notification failure. */ }
      await finish(authorized(tokens.scopes) ? undefined : '账户已登录，但未授予 ChatGPT 计划推理权限。');
    } catch (error) {
      try { port.postMessage({ ok: false }); } catch { /* callback closed */ }
      await finish(`ChatGPT 授权失败：回调、身份或授权验证未通过，请重新登录。${diagnostic(error)}`);
    }
  };
  activeAttempt = { cancel: () => finish('ChatGPT 登录已取消。') };
  timer = setTimeout(() => { void finish('ChatGPT 登录超时，请重试。'); }, TIMEOUT);
  try {
    if (!await permission) fail('未授予 OpenAI 授权所需的可选网站权限。');
    if (settled) return result;
    selected = accountId ? (await getChatGPTPlanAccounts()).find(a => a.id === accountId) : undefined;
    if (accountId && !selected) fail('找不到所选 ChatGPT 注册账户。');
    const host = await hostId();
    state = random(); nonce = random(); verifier = random();
    const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    if (settled) return result;
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    tabId = tab.id;
    if (tabId === undefined) fail('无法打开授权标签页。');
    if (settled) { await chrome.tabs.remove(tabId); return result; }
    chrome.runtime.onConnect.addListener(onConnect);
    chrome.tabs.onRemoved.addListener(onRemoved);
    globalThis.addEventListener?.('pagehide', onPageHide, { once: true });
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{ id: ruleId, priority: 1,
      action: { type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
        redirect: { regexSubstitution: `${chrome.runtime.getURL('oauth-callback.html')}\\1` } },
      condition: { regexFilter: '^http://127[.]0[.]0[.]1:1455/auth/callback([?].*)?$',
        isUrlFilterCaseSensitive: true, tabIds: [tabId], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME] } }] });
    ruleInstalled = true;
    if (settled) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); return result;
    }
    const query = new URLSearchParams({ client_id: selected?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: host,
      response_type: 'code', redirect_uri: CALLBACK, scope: SCOPES, resource: RESOURCE,
      state, nonce, code_challenge_method: 'S256', code_challenge: challenge });
    if (!selected) query.set('agent_name_hint', 'TabFlow');
    if (selected?.email) query.set('login_hint', selected.email);
    // Omit optional id_token_hint: putting an ID token into a browser tab URL
    // could retain it in navigation history beyond this page's memory lifetime.
    await chrome.tabs.update(tabId, { url: `${ISSUER}/api/accounts/authorize?${query}` });
  } catch { await finish('无法启动 ChatGPT 授权，请检查可选网站权限及浏览器支持。'); }
  return result;
}
export async function getChatGPTPlanAccessToken(): Promise<string> {
  const current = session;
  if (!current || !authorized(current.scopes)) fail('尚未授予 ChatGPT 计划推理权限，请登录并授权。');
  if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
  if (refreshFlight) return refreshFlight;
  if ((current.refreshRetryAt ?? 0) > Date.now()) fail('ChatGPT 刷新暂时不可用，请稍后重试。');
  if (!current.refreshToken || Date.now() < current.earliestRefreshAt) fail('当前会话无法刷新，请稍后重试或重新登录。');
  const epoch = generation;
  const flight = (async () => {
    let next: TokenSet;
    try {
      const data = await exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: current.account.clientId,
        refresh_token: current.refreshToken!, resource: RESOURCE }));
      next = tokenSet(data, current);
      // Keep the newest rotating refresh token even if JWKS is temporarily down.
      // Sign-out waits for this flight and revokes this latest token.
      if (next.refreshToken) current.refreshToken = next.refreshToken;
      if (typeof data.id_token === 'string') {
        const claims = await validateIdToken(next.idToken, current.account.clientId, current.nonce, true);
        if (claims.sub !== current.account.subject) fail('刷新返回的账户身份不一致。');
      }
      if (session !== current || generation !== epoch) fail('会话已结束。');
      if (!next.refreshToken) fail('刷新未返回轮换 refresh token。');
    } catch (error) {
      if (session === current && generation === epoch) {
        const terminated = error instanceof ChatGPTPlanOAuthError && (error.status === 400 || error.status === 401)
          && ['invalid_grant', 'invalid_token'].includes(error.code);
        if (terminated) {
          session = undefined; publish(`ChatGPT 会话已失效，请重新登录。${diagnostic(error)}`);
        } else {
          current.refreshFailures = Math.min((current.refreshFailures ?? 0) + 1, 6);
          current.refreshRetryAt = Date.now() + Math.min(1000 * 2 ** (current.refreshFailures - 1), 30_000);
          publish(`ChatGPT 刷新暂时失败，会话已保留，请稍后重试。${diagnostic(error)}`);
        }
      }
      if (error instanceof ChatGPTPlanOAuthError) throw error;
      fail('ChatGPT 会话刷新失败，请稍后重试或重新登录。');
    }
    session = { ...next, account: current.account, nonce: current.nonce };
    if (!authorized(next.scopes)) {
      publish('账户仍已登录，但 ChatGPT 计划推理权限已被撤销。');
      fail('ChatGPT 计划推理权限已被撤销。');
    }
    publish();
    return next.accessToken;
  })();
  refreshFlight = flight;
  try { return await flight; } finally { if (refreshFlight === flight) refreshFlight = undefined; }
}
export async function signOutChatGPTPlan(): Promise<{ revocationConfirmed: boolean }> {
  generation++;
  const current = session;
  const pendingRefresh = refreshFlight;
  session = undefined; publish();
  if (activeAttempt) await activeAttempt.cancel();
  if (pendingRefresh) { try { await pendingRefresh; } catch { /* session already cleared */ } }
  let revocationConfirmed = false;
  if (current?.refreshToken) {
    try {
      const config = await discovery();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await request(config.revocation_endpoint, { method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: current.refreshToken, token_type_hint: 'refresh_token', client_id: current.account.clientId }) });
          if (response.status === 200) { revocationConfirmed = true; break; }
          if (response.status < 500) break;
        } catch { /* one bounded retry while refresh token remains in this call's memory */ }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch { /* local sign-out still completes */ }
  }
  publish(revocationConfirmed || !current ? undefined : '已清除本页会话，但远程撤销未确认；可在 ChatGPT 设置中断开此应用。');
  return { revocationConfirmed };
}

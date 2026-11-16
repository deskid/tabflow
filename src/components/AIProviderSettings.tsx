import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, LoaderCircle, RefreshCw } from 'lucide-react';
import { BuiltinModelStatus } from './BuiltinModelStatus';
import { getNativeInstallCommand } from '../services/nativeCodexSetup';
import {
  getChatGPTPlanAccounts, getChatGPTPlanModels, getChatGPTPlanStatus,
  initializeChatGPTPlanSession, signInChatGPTPlan, signOutChatGPTPlan,
  subscribeChatGPTPlanSession, type ChatGPTPlanAccount, type ChatGPTPlanStatus,
} from '../services/chatgptPlanClient';
import {
  APIAccessRequiredError, getAPIModels, getLocalCodexStatus,
  type AISettings, type CodexAccount, type CodexModel,
} from '../services/aiGrouper';

interface Props {
  active: boolean;
  settings: AISettings;
  onUpdate: (updates: Partial<AISettings>) => void;
}

interface CodexGuide {
  title: string;
  detail: string;
  command?: string;
  note?: string;
}

const PROVIDERS: Array<{ id: AISettings['provider']; label: string }> = [
  { id: 'codex_native', label: '本机 Codex' },
  { id: 'chatgpt_plan', label: 'ChatGPT 订阅（实验）' },
  { id: 'custom', label: '自定义 API' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'heuristic', label: '本地规则' },
  { id: 'chrome_builtin', label: 'Chrome 端侧模型' },
];

const fieldClass = 'w-full min-w-0 px-2.5 py-2 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[13px] text-[var(--text-high)] outline-none';

function planAccountLabel(account: ChatGPTPlanAccount, accounts: ChatGPTPlanAccount[]): string {
  const identity = account.email || 'ChatGPT 账户';
  const duplicated = accounts.some((item) => item.id !== account.id && (item.email || 'ChatGPT 账户') === identity);
  if (!duplicated) return identity;
  const label = accounts.find((item) => item.id === account.id)?.label ?? account.label;
  const registration = /注册\s*([1-9]\d*)\s*$/u.exec(label);
  if (registration) return `${identity} · 账户${registration[1]}`;
  // Hash the registration ID instead of displaying client/subject identifiers.
  let suffix = 2166136261;
  for (let index = 0; index < account.id.length; index++) {
    suffix = Math.imul(suffix ^ account.id.charCodeAt(index), 16777619);
  }
  return `${identity} · 账户 ${(suffix >>> 0).toString(36).padStart(7, '0')}`;
}

function ChatGPTPlanSettings({ model, onUpdate }: Pick<Props, 'onUpdate'> & { model: string }) {
  const [session, setSession] = useState<ChatGPTPlanStatus>(getChatGPTPlanStatus);
  const [hydrating, setHydrating] = useState(true);
  const [accounts, setAccounts] = useState<ChatGPTPlanAccount[]>([]);
  const [models, setModels] = useState<Awaited<ReturnType<typeof getChatGPTPlanModels>>>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<'signin' | 'signout' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const modelRequest = useRef(0);
  const accountRequest = useRef(0);
  const operation = useRef(0);
  const latestSettings = useRef({ model, onUpdate });
  latestSettings.current = { model, onUpdate };
  const authorized = session.loggedIn && session.planAuthorized;
  const sessionAccount = session.account?.id;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const refreshSession = () => {
      setSession(getChatGPTPlanStatus());
      const id = ++accountRequest.current;
      void getChatGPTPlanAccounts().then((result) => {
        if (mounted.current && id === accountRequest.current) setAccounts(result);
      }).catch((cause: unknown) => {
        if (mounted.current && id === accountRequest.current) {
          setError(cause instanceof Error ? cause.message : '读取已保存账户失败');
        }
      });
    };
    const unsubscribe = subscribeChatGPTPlanSession(refreshSession);
    void initializeChatGPTPlanSession().then(() => {
      if (disposed) return;
      refreshSession();
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : '读取 ChatGPT 会话失败');
    }).finally(() => {
      if (!disposed) setHydrating(false);
    });
    return () => {
      disposed = true;
      mounted.current = false;
      operation.current++;
      modelRequest.current++;
      accountRequest.current++;
      unsubscribe();
    };
  }, []);

  const loadModels = useCallback(async () => {
    const id = ++modelRequest.current;
    const current = getChatGPTPlanStatus();
    if (!current.loggedIn || !current.planAuthorized || current.account?.id !== sessionAccount) return;
    setLoading(true);
    setError('');
    try {
      const result = await getChatGPTPlanModels();
      const latest = getChatGPTPlanStatus();
      if (!mounted.current || id !== modelRequest.current || !latest.loggedIn ||
          !latest.planAuthorized || latest.account?.id !== sessionAccount) return;
      setModels(result);
      if (result.length && !result.some((item) => item.id === latestSettings.current.model)) {
        latestSettings.current.onUpdate({ model: result[0].id });
      }
      if (!result.length) setError('当前账户未返回可用模型，请确认计划资格或重新授权。');
    } catch (cause) {
      if (!mounted.current || id !== modelRequest.current) return;
      setModels([]);
      setError(cause instanceof Error ? cause.message : '获取订阅模型目录失败');
    } finally {
      if (mounted.current && id === modelRequest.current) setLoading(false);
    }
  }, [sessionAccount]);

  useEffect(() => {
    setModels([]);
    setLoading(false);
    if (!hydrating && authorized) void loadModels();
    return () => { modelRequest.current++; };
  }, [hydrating, authorized, sessionAccount, loadModels]);

  const signIn = async (accountId?: string) => {
    const id = ++operation.current;
    setPending('signin');
    setError('');
    setNotice('');
    try {
      const result = await signInChatGPTPlan(accountId || undefined);
      if (mounted.current && id === operation.current) setSession(result);
    } catch (cause) {
      if (mounted.current && id === operation.current) {
        setError(cause instanceof Error ? cause.message : 'ChatGPT 授权失败，请重试');
      }
    } finally {
      if (mounted.current && id === operation.current) setPending(null);
    }
  };

  const signOut = async () => {
    const id = ++operation.current;
    modelRequest.current++;
    setModels([]);
    setLoading(false);
    setPending('signout');
    setError('');
    setNotice('');
    try {
      const result = await signOutChatGPTPlan();
      if (!mounted.current || id !== operation.current) return;
      setSession(getChatGPTPlanStatus());
      setNotice(result.revocationConfirmed ? '已退出并确认撤销授权。'
        : '已退出当前会话，但未确认远端撤销。请到 OpenAI 账户设置中断开此应用的授权。');
    } catch (cause) {
      if (!mounted.current || id !== operation.current) return;
      setSession(getChatGPTPlanStatus());
      setError(cause instanceof Error ? cause.message : '退出时发生错误');
      setNotice('未确认远端撤销，请到 OpenAI 账户设置中断开此应用的授权。');
    } finally {
      if (mounted.current && id === operation.current) setPending(null);
    }
  };

  const modelInCatalog = models.some((item) => item.id === model);
  const accountLabel = session.account ? planAccountLabel(session.account, accounts) : 'ChatGPT';
  return (
    <div className="space-y-2.5">
      <div className="flex min-h-9 items-center gap-2.5">
        <span className="w-7 shrink-0 text-[12px] font-medium text-[var(--text-medium)]">账户</span>
        {hydrating ? (
          <span role="status" className="flex items-center gap-1.5 text-[12px] text-[var(--text-medium)]">
            <LoaderCircle size={14} className="animate-spin" />正在连接…
          </span>
        ) : session.loggedIn ? (
          <>
            <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[12px] font-medium text-[var(--text-medium)]">
              {accountLabel.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-high)]" title={accountLabel}>{accountLabel}</span>
            <span role="status" className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-medium)]">
              {pending ? <LoaderCircle size={12} className="animate-spin" />
                : <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${authorized ? 'bg-[var(--success-text)]' : 'bg-[var(--text-low)]'}`} />}
              {pending === 'signin' ? '授权中' : pending === 'signout' ? '退出中' : authorized ? '已连接' : '需授权'}
            </span>
            {!authorized && !pending && <button type="button" onClick={() => { void signIn(sessionAccount); }}
              className="shrink-0 text-[12px] text-[var(--accent-text)]">重新授权</button>}
          </>
        ) : (
          <button type="button" disabled={!!pending} onClick={() => { void signIn(); }}
            className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--accent-text)] px-3 py-2 text-[13px] text-[var(--app-bg)] disabled:opacity-50">
            {pending === 'signin' && <LoaderCircle size={15} className="animate-spin" />}
            Continue with ChatGPT
          </button>
        )}
        {!hydrating && (session.loggedIn || accounts.length > 0) && <select
          aria-label="账户菜单" title="账户菜单" value="" disabled={!!pending}
          onChange={(event) => {
            const action = event.target.value;
            if (action === 'signout') void signOut();
            else if (action === 'add') void signIn();
            else if (action === 'reauthorize') void signIn(sessionAccount);
            else if (action.startsWith('account:')) void signIn(action.slice('account:'.length));
          }}
          className="h-8 w-8 shrink-0 cursor-pointer appearance-none rounded-md border-hairline border-[var(--border-subtle)] bg-[var(--app-bg)] text-center text-[16px] text-[var(--text-medium)] outline-none focus:border-[var(--accent-border)] disabled:opacity-50">
          <option value="" disabled>⋯</option>
          {accounts.some((account) => account.id !== sessionAccount) && <optgroup label="切换账户">
            {accounts.filter((account) => account.id !== sessionAccount).map((account) => (
              <option key={account.id} value={`account:${account.id}`}>{planAccountLabel(account, accounts)}</option>
            ))}
          </optgroup>}
          <option value="add">新增账户</option>
          {session.loggedIn && <option value="reauthorize">重新授权</option>}
          {session.loggedIn && <option value="signout">退出并撤销授权</option>}
        </select>}
      </div>
      {!hydrating && authorized && <div className="flex items-center gap-2.5">
        <label htmlFor="chatgpt-plan-model" className="w-7 shrink-0 text-[12px] font-medium text-[var(--text-medium)]">模型</label>
        <select id="chatgpt-plan-model" className={fieldClass} value={modelInCatalog ? model : ''}
          disabled={loading || !!pending || !models.length}
          onChange={(event) => onUpdate({ model: event.target.value })}>
          {!modelInCatalog && <option value="">{loading ? '正在读取模型…' : '暂无可用模型'}</option>}
          {models.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? '（默认）' : ''}</option>)}
        </select>
        <button type="button" disabled={loading || !!pending} title="刷新模型目录" aria-label="刷新模型目录"
          onClick={() => { void loadModels(); }}
          className="shrink-0 rounded-md border-hairline border-[var(--border-subtle)] px-2 py-2 text-[var(--accent-text)] disabled:opacity-50">
          {loading ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        </button>
      </div>}
      {[...new Set([error, session.error].filter(Boolean))].map((message) => (
        <p key={message} role="alert" className="text-[12px] text-[var(--text-medium)] break-words">{message}</p>
      ))}
      {notice && <p role="status" className="text-[12px] text-[var(--text-medium)]">{notice}</p>}
    </div>
  );
}

function getCodexGuide(
  error: string,
  errorCodes: string[],
  account?: CodexAccount,
): CodexGuide | null {
  const lower = error.toLowerCase();
  if (
    lower.includes('native messaging host not found')
    || lower.includes('native host has exited')
    || lower.includes('access to the specified native messaging host is forbidden')
  ) {
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
    return {
      title: '未检测到本机 Codex 桥接',
      detail: isMac
        ? '请先确认本机已登录 codex，打开「终端」运行下方命令后再点击重新检测：'
        : '请先在当前用户下完成 codex login，再打开 PowerShell 运行下方安装命令：',
      command: getNativeInstallCommand(
        typeof navigator !== 'undefined' ? navigator.userAgent : '',
        typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined,
      ),
      note: isMac
        ? '脚本将下载桥接文件到 ~/Library/Application Support/TabFlow/，为浏览器注册 Native Messaging Host，并自动检测本机 Codex 状态。'
        : '脚本将下载桥接文件到 %LOCALAPPDATA%\\TabFlowNativeHost，并为当前用户注册 Chrome Native Messaging Host，无需下载源码或管理员权限。',
    };
  }
  if (errorCodes.includes('CODEX_NOT_FOUND')) {
    return {
      title: '未检测到官方 Codex CLI',
      detail: '请先安装官方 Codex CLI 并完成登录，然后重新运行桥接安装脚本。',
      command: 'codex login',
    };
  }
  if (
    errorCodes.includes('NOT_LOGGED_IN')
    || (account && !account.loggedIn && account.requiresOpenaiAuth !== false)
  ) {
    return {
      title: '本机 Codex 尚未登录',
      detail: '请在终端运行下方命令完成登录，然后点击重新检测：',
      command: 'codex login',
    };
  }
  return null;
}

export function AIProviderSettings({ active, settings, onUpdate }: Props) {
  const { provider, apiEndpoint = '', apiKey = '', model = '' } = settings;
  const isAPI = provider === 'custom' || provider === 'openai' || provider === 'deepseek';
  const hasModels = isAPI || provider === 'codex_native';
  const [models, setModels] = useState<CodexModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsAccess, setNeedsAccess] = useState(false);
  const [connected, setConnected] = useState(false);
  const [codexStatus, setCodexStatus] = useState('');
  const [codexGuide, setCodexGuide] = useState<CodexGuide | null>(null);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const requestId = useRef(0);
  const copyTimer = useRef<number | null>(null);

  const loadModels = useCallback(async (requestPermission: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    setNeedsAccess(false);
    setConnected(false);
    setCodexStatus('');
    setCodexGuide(null);
    try {
      if (provider === 'codex_native') {
        const result = await getLocalCodexStatus();
        if (id !== requestId.current) return;
        const account = result.account;
        setModels(result.models);
        setConnected(!!account && (account.loggedIn || account.requiresOpenaiAuth === false));
        setCodexStatus(result.error ? '' : account
          ? account.loggedIn ? '已登录' : account.requiresOpenaiAuth === false ? '使用本机提供商配置' : '未登录'
          : '账号状态未确认');
        const errors = [result.error, result.accountError, result.modelsError].filter(Boolean) as string[];
        const codes = [result.accountErrorCode, result.modelsErrorCode].filter(Boolean) as string[];
        const mergedError = errors.join('；') || (account && !account.loggedIn && account.requiresOpenaiAuth !== false ? '请先登录本机 Codex' : '');
        setError(mergedError);
        setCodexGuide(getCodexGuide(mergedError, codes, account));
      } else {
        const result = await getAPIModels({ provider, apiEndpoint, apiKey }, { requestPermission });
        if (id !== requestId.current) return;
        setModels(result);
        setConnected(true);
        if (!result.length) setError('服务未返回模型，可手动输入');
      }
    } catch (cause) {
      if (id !== requestId.current) return;
      setModels([]);
      if (cause instanceof APIAccessRequiredError) setNeedsAccess(true);
      else setError(cause instanceof Error ? cause.message : '获取模型失败');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [provider, apiEndpoint, apiKey]);

  useEffect(() => {
    setModels([]);
    setError('');
    setNeedsAccess(false);
    setConnected(false);
    setCodexStatus('');
    setCodexGuide(null);
    setLoading(false);
    setManual(false);
    if (!active || !hasModels || (provider === 'custom' && !apiEndpoint.trim()) ||
        ((provider === 'openai' || provider === 'deepseek') && !apiKey.trim())) return;
    const timer = window.setTimeout(() => { void loadModels(false); }, 400);
    return () => { window.clearTimeout(timer); requestId.current++; };
  }, [active, hasModels, provider, apiEndpoint, apiKey, loadModels]);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const handleCopyCommand = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts; text remains selectable.
    }
  };

  const savedModelMissing = !!model && !models.some((item) => item.id === model);
  const status = loading
    ? (provider === 'codex_native' ? '正在连接本机 Codex…' : '正在获取模型…')
    : provider === 'codex_native'
      ? `${codexStatus}${models.length ? `${codexStatus ? '，' : ''}${models.length} 个模型` : ''}`
      : connected ? `已连接${models.length ? `，${models.length} 个模型` : ''}` : needsAccess ? '等待连接' : '';

  return (
    <section className="space-y-3">
      <div>
        <label htmlFor="ai-provider" className="block mb-1.5 text-[12px] font-medium text-[var(--text-medium)]">分类引擎</label>
        <select id="ai-provider" className={fieldClass} value={provider}
          onChange={(event) => onUpdate({ provider: event.target.value as AISettings['provider'] })}>
          {PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>

      {provider === 'chrome_builtin' && <BuiltinModelStatus />}
      {active && provider === 'chatgpt_plan' && <ChatGPTPlanSettings model={model} onUpdate={onUpdate} />}

      {hasModels && (
        <div className="space-y-3 rounded-lg border-hairline border-[var(--border-subtle)] bg-[var(--surface)] p-3">
          {provider === 'custom' && (
            <div>
              <label htmlFor="ai-endpoint" className="block mb-1 text-[12px] font-medium text-[var(--text-medium)]">API 地址</label>
              <input id="ai-endpoint" type="url" className={fieldClass} placeholder="http://127.0.0.1:3425/v1"
                value={apiEndpoint} onChange={(event) => onUpdate({ apiEndpoint: event.target.value })} />
            </div>
          )}
          {isAPI && (
            <div>
              <label htmlFor="ai-api-key" className="block mb-1 text-[12px] font-medium text-[var(--text-medium)]">
                API Key{provider === 'custom' && <span className="ml-1 font-normal opacity-60">可选</span>}
              </label>
              <input id="ai-api-key" type="password" autoComplete="off" className={fieldClass} placeholder="sk-…"
                value={apiKey} onChange={(event) => onUpdate({ apiKey: event.target.value })} />
            </div>
          )}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="ai-model" className="text-[12px] font-medium text-[var(--text-medium)]">模型</label>
              {isAPI && <button type="button" className="text-[12px] text-[var(--accent-text)]"
                onClick={() => setManual((value) => !value)}>{manual ? '从列表选择' : '手动输入'}</button>}
            </div>
            <div className="flex items-center gap-2">
              {manual ? (
                <input id="ai-model" className={fieldClass} value={model} placeholder="模型 ID"
                  onChange={(event) => onUpdate({ model: event.target.value })} />
              ) : (
                <select id="ai-model" className={fieldClass} value={model} disabled={loading}
                  onChange={(event) => onUpdate({ model: event.target.value })}>
                  <option value="">{provider === 'codex_native' ? 'Codex 默认模型' : '选择模型'}</option>
                  {savedModelMissing && <option value={model}>{model}</option>}
                  {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              )}
              <button type="button" disabled={loading || (provider === 'custom' && !apiEndpoint.trim())}
                onClick={() => { void loadModels(true); }} title={needsAccess ? '授权并获取模型' : '刷新模型'}
                aria-label={needsAccess ? '授权并获取模型' : '刷新模型'}
                className="shrink-0 flex items-center gap-1.5 rounded-md border-hairline border-[var(--border-subtle)] px-2.5 py-2 text-[var(--accent-text)] hover:bg-[var(--surface-hover)] disabled:opacity-50">
                {loading ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                {needsAccess && <span className="text-[12px]">连接</span>}
              </button>
            </div>
          </div>
          {status && <div role="status" className="flex items-center gap-1.5 text-[12px] text-[var(--text-medium)]">
            {connected && !loading && <CheckCircle2 size={13} className="text-[var(--success-text)]" />}{status}
          </div>}
          {codexGuide ? (
            <div role="alert" className="space-y-2 rounded-md border-hairline border-[var(--border-subtle)] bg-[var(--app-bg)] p-2.5 text-[12px] text-[var(--text-medium)]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[var(--text-high)]">{codexGuide.title}</span>
                <button type="button" disabled={loading} onClick={() => { void loadModels(true); }}
                  className="shrink-0 text-[var(--accent-text)] disabled:opacity-50">
                  重新检测
                </button>
              </div>
              <p className="leading-relaxed">{codexGuide.detail}</p>
              {codexGuide.command && (
                <div className="flex items-center gap-2 rounded border-hairline border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1.5">
                  <code className="min-w-0 flex-1 select-all truncate text-[12px] text-[var(--text-high)]">
                    {codexGuide.command}
                  </code>
                  <button type="button" onClick={() => { void handleCopyCommand(codexGuide.command!); }}
                    className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--accent-text)]">
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
              )}
              {codexGuide.note && (
                <p className="leading-relaxed opacity-80">{codexGuide.note}</p>
              )}
              {error && (
                <details>
                  <summary className="cursor-pointer">技术详情</summary>
                  <p className="mt-1 select-text break-words">{error}</p>
                </details>
              )}
            </div>
          ) : (
            error && <p role="alert" className="text-[12px] text-[var(--text-medium)] break-words">{error}</p>
          )}
        </div>
      )}
    </section>
  );
}

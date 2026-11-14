import { classifyWithBuiltinModel, getBuiltinModelState } from './builtinModel';

// AI and Rule-based Auto-Grouping Engine

export type ChromeGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan';

export const CHROME_GROUP_COLORS: ChromeGroupColor[] = [
  'blue', 'cyan', 'green', 'yellow', 'purple', 'pink', 'red', 'grey'
];

export const DEFAULT_GROUPING_PROMPT = `你是一个专业的浏览器标签页整理助手。请根据标签页的标题与网址，将其归纳整理为 2 到 6 个逻辑清晰的主题组。组名简明扼要（2 到 6 个汉字），并分配合适的颜色。`;

export interface TabData {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
  groupId: number;
}

export interface ProposedGroup {
  name: string;
  color: ChromeGroupColor;
  tabIds: number[];
}

export interface GroupingUndoState {
  originalTabState: Array<{
    tabId: number;
    originalGroupId: number;
    originalWindowId: number;
    originalIndex: number;
  }>;
  originalGroups: Array<{
    groupId: number;
    title: string;
    color: chrome.tabGroups.TabGroup['color'];
    collapsed: boolean;
    windowId: number;
    members: Array<{ tabId: number; index: number }>;
  }>;
  createdGroupIds: number[];
  affectedTabIds: number[];
  // Mutated immediately after recreation, so a failed undo can reuse its group.
  restoredGroupIds: Record<number, number>;
}

export interface AISettings {
  provider: 'codex_native' | 'heuristic' | 'chrome_builtin' | 'openai' | 'deepseek' | 'custom';
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  customPrompt?: string;
}

const NATIVE_HOST_NAME = 'com.tabflow.codex_bridge';

export interface CodexAccount {
  loggedIn: boolean;
  email?: string;
  authMode?: string;
  requiresOpenaiAuth?: boolean;
  error?: string;
}

export interface CodexModel {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface CodexModelsResult {
  models: CodexModel[];
  source?: string;
  error?: string;
}

function nativeRequest(payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.sendNativeMessage) {
      reject(new Error('当前环境不支持本机通信。'));
      return;
    }
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
      const error = chrome.runtime.lastError?.message;
      if (error || !response?.success) {
        reject(new Error(error || response?.error || '本机 Codex 桥接未返回有效结果。'));
      } else {
        resolve(response);
      }
    });
  });
}

// 0. Native Messaging Bridge to Local Codex Account
export async function getLocalCodexAccount(): Promise<CodexAccount> {
  try {
    const response = await nativeRequest({ action: 'GET_CODEX_ACCOUNT' });
    return { ...response.account, loggedIn: response.account?.loggedIn === true };
  } catch (error) {
    return { loggedIn: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getLocalCodexModels(): Promise<CodexModelsResult> {
  try {
    const response = await nativeRequest({ action: 'GET_MODELS' });
    if (!Array.isArray(response.models)) throw new Error('Codex 返回的模型列表格式无效。');
    return { models: response.models, source: response.source || 'Codex app-server' };
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CodexStatusResult {
  account?: CodexAccount;
  accountError?: string;
  models: CodexModel[];
  modelsError?: string;
  error?: string;
}

/** Read both channels through one host/server, retaining partial success. */
export async function getLocalCodexStatus(): Promise<CodexStatusResult> {
  try {
    const response = await nativeRequest({ action: 'GET_CODEX_STATUS' });
    if (response.type !== 'STATUS') throw new Error('本机 Codex 返回的状态格式无效。');
    const validAccount = response.account && typeof response.account.loggedIn === 'boolean'
      && typeof response.account.requiresOpenaiAuth === 'boolean';
    const validModels = Array.isArray(response.models) && response.models.every((item: any) =>
      item && typeof item.id === 'string' && item.id && typeof item.name === 'string');
    return {
      ...(validAccount ? { account: {
        loggedIn: response.account.loggedIn,
        requiresOpenaiAuth: response.account.requiresOpenaiAuth,
        ...(typeof response.account.authMode === 'string' ? { authMode: response.account.authMode } : {}),
      } } : {}),
      accountError: typeof response.accountError === 'string' && response.accountError
        ? `${response.accountError}${Number.isInteger(response.accountRpcCode) ? `（RPC ${response.accountRpcCode}）` : ''}`
        : validAccount ? undefined : '账号状态读取失败，点击刷新重试。',
      models: validModels ? response.models.map((item: CodexModel) => ({ id: item.id, name: item.name, isDefault: item.isDefault === true })) : [],
      modelsError: typeof response.modelsError === 'string' && response.modelsError
        ? `${response.modelsError}${Number.isInteger(response.modelsRpcCode) ? `（RPC ${response.modelsRpcCode}）` : ''}`
        : validModels ? undefined : 'Codex 返回的模型列表格式无效。',
    };
  } catch (cause) {
    return { models: [], error: cause instanceof Error ? cause.message : '本机 Codex 状态读取失败。' };
  }
}

export async function planGroupByCodexNative(tabs: TabData[], customPrompt?: string, model?: string): Promise<ProposedGroup[]> {
  const payload = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));
  const response = await nativeRequest({ action: 'CLASSIFY_TABS', tabs: payload, customPrompt, model });
  if (!Array.isArray(response.groups)) throw new Error('Codex 未返回有效的标签分组。');
  return response.groups;
}

// 1. Group by Domain (Rule-based)
export function planGroupByDomain(tabs: TabData[]): ProposedGroup[] {
  const domainMap = new Map<string, number[]>();

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      continue;
    }
    try {
      const parsed = new URL(tab.url);
      let host = parsed.hostname;
      host = host.replace(/^(www\.|m\.)/, '');
      const list = domainMap.get(host) || [];
      list.push(tab.id);
      domainMap.set(host, list);
    } catch {
      // ignore invalid urls
    }
  }

  const result: ProposedGroup[] = [];
  let colorIndex = 0;

  for (const [host, tabIds] of domainMap.entries()) {
    if (tabIds.length >= 2) {
      const cleanName = formatDomainTitle(host);
      result.push({
        name: cleanName,
        color: CHROME_GROUP_COLORS[colorIndex % CHROME_GROUP_COLORS.length],
        tabIds,
      });
      colorIndex++;
    }
  }

  return result;
}

function formatDomainTitle(host: string): string {
  const domainRules: Record<string, string> = {
    'github.com': 'GitHub 研发',
    'feishu.cn': '飞书协同',
    'larksuite.com': 'Lark',
    'google.com': 'Google 检索',
    'youtube.com': 'YouTube 视频',
    'bilibili.com': '哔哩哔哩',
    'zhihu.com': '知乎探索',
    'juejin.cn': '稀土掘金',
    'chatgpt.com': 'ChatGPT',
    'openai.com': 'OpenAI',
    'claude.ai': 'Claude',
    'v2ex.com': 'V2EX 社区',
    'stackoverflow.com': 'Stack Overflow',
    'taobao.com': '淘宝购物',
    'jd.com': '京东商城',
  };

  if (domainRules[host]) {
    return domainRules[host];
  }

  const parts = host.split('.');
  if (parts.length >= 2) {
    const main = parts[parts.length - 2];
    return main.charAt(0).toUpperCase() + main.slice(1);
  }
  return host;
}

// 2. Intelligent Semantic Heuristic (Local-first zero-config clustering)
export function planGroupBySmartHeuristic(tabs: TabData[]): ProposedGroup[] {
  const categories: Array<{
    name: string;
    color: ChromeGroupColor;
    keywords: string[];
    domains: string[];
    tabIds: number[];
  }> = [
    {
      name: '研发与代码',
      color: 'blue',
      keywords: ['github', 'gitlab', 'git', 'pull request', 'issue', 'code', 'commit', 'npm', 'pnpm', 'cargo', 'python', 'rust', 'typescript', 'api', 'docker', 'debug', 'stack overflow', '终端', '架构'],
      domains: ['github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com', 'crates.io', 'developer.mozilla.org'],
      tabIds: [],
    },
    {
      name: 'AI 与智能工具',
      color: 'purple',
      keywords: ['chatgpt', 'claude', 'gemini', 'deepseek', 'copilot', 'llm', 'prompt', 'model', 'agent', 'huggingface', 'ai', 'openai', 'midjourney', '豆包', '通义千问', '元宝'],
      domains: ['chatgpt.com', 'claude.ai', 'deepseek.com', 'huggingface.co', 'openai.com', 'doubao.com'],
      tabIds: [],
    },
    {
      name: '文档与工作协作',
      color: 'cyan',
      keywords: ['文档', '飞书', 'docs', 'sheet', 'notion', '语雀', 'confluence', 'jira', 'trello', 'meego', 'base', 'wiki', 'prd', '需求', '会议', '规划', '汇报'],
      domains: ['feishu.cn', 'larksuite.com', 'notion.so', 'yuque.com', 'atlassian.net', 'google.com/docs'],
      tabIds: [],
    },
    {
      name: '音视频与流媒体',
      color: 'red',
      keywords: ['bilibili', 'youtube', 'netflix', 'video', 'watch', 'movie', 'tv', '音乐', '网易云', 'spotify', '视频', '播放', '直播', '抖音', 'twitch'],
      domains: ['bilibili.com', 'youtube.com', 'netflix.com', 'music.163.com', 'douyin.com', 'twitch.tv'],
      tabIds: [],
    },
    {
      name: '资讯与技术社区',
      color: 'green',
      keywords: ['知乎', '掘金', 'v2ex', 'reddit', 'twitter', 'x.com', 'news', 'blog', 'article', '博客', '专栏', '论坛', '帖子', 'medium', 'hackernews'],
      domains: ['zhihu.com', 'juejin.cn', 'v2ex.com', 'reddit.com', 'twitter.com', 'x.com', 'medium.com', 'news.ycombinator.com'],
      tabIds: [],
    },
    {
      name: '电商与消费',
      color: 'yellow',
      keywords: ['淘宝', '京东', '拼多多', '天猫', 'amazon', 'shop', 'order', 'cart', 'buy', 'price', '优惠', '商品', '商城'],
      domains: ['taobao.com', 'jd.com', 'pinduoduo.com', 'amazon.com', 'tmall.com'],
      tabIds: [],
    },
    {
      name: '搜索与探索',
      color: 'pink',
      keywords: ['google 搜索', 'bing', 'baidu', 'search', '百度一下', 'query'],
      domains: ['google.com', 'bing.com', 'baidu.com'],
      tabIds: [],
    },
  ];

  const assignedTabIds = new Set<number>();

  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      continue;
    }

    const titleLower = (tab.title || '').toLowerCase();
    const urlLower = tab.url.toLowerCase();

    let bestCategory: (typeof categories)[0] | null = null;
    let maxScore = 0;

    for (const cat of categories) {
      let score = 0;
      for (const d of cat.domains) {
        if (urlLower.includes(d)) score += 5;
      }
      for (const kw of cat.keywords) {
        if (titleLower.includes(kw) || urlLower.includes(kw)) score += 2;
      }

      if (score > maxScore && score >= 2) {
        maxScore = score;
        bestCategory = cat;
      }
    }

    if (bestCategory) {
      bestCategory.tabIds.push(tab.id);
      assignedTabIds.add(tab.id);
    }
  }

  const result: ProposedGroup[] = [];
  for (const cat of categories) {
    if (cat.tabIds.length >= 2) {
      result.push({
        name: cat.name,
        color: cat.color,
        tabIds: cat.tabIds,
      });
    }
  }

  const remainingTabs = tabs.filter((t) => !assignedTabIds.has(t.id));
  const domainGroups = planGroupByDomain(remainingTabs);
  for (const dg of domainGroups) {
    result.push(dg);
  }

  return result;
}

// 3. AI Grouping Main Dispatcher
export async function planGroupByAI(tabs: TabData[], settings?: AISettings): Promise<ProposedGroup[]> {
  const provider = settings?.provider || 'codex_native';
  const customPrompt = settings?.customPrompt;
  const model = settings?.model;

  // 1. Prioritize Native Codex Bridge
  if (provider === 'codex_native') {
    return planGroupByCodexNative(tabs, customPrompt, model);
  }

  // 2. Chrome Built-in Prompt API
  if (provider === 'chrome_builtin') {
    return classifyWithBuiltinModel(tabs, customPrompt);
  }

  // 3. Cloud LLM
  if (provider === 'openai' || provider === 'deepseek' || provider === 'custom') {
    return callCloudLLM(tabs, { ...settings, provider });
  }

  // Fallback: Smart Heuristic
  return planGroupBySmartHeuristic(tabs);
}

export interface GroupingPlan {
  groups: ProposedGroup[];
  method: 'model' | 'local-rules' | 'domain';
  provider: AISettings['provider'];
  fallbackReason?: string;
  notices?: string[];
}

export async function planGroupingWithFallback(tabs: TabData[], settings?: AISettings): Promise<GroupingPlan> {
  const provider = settings?.provider || 'codex_native';
  try {
    const groups = await planGroupByAI(tabs, settings);
    return {
      groups, method: provider === 'heuristic' ? 'local-rules' : 'model', provider,
      ...(provider === 'chrome_builtin' ? { notices: [...(getBuiltinModelState().classificationNotes || [])] } : {}),
    };
  } catch (error) {
    // Cancellation and preflight require user intent; neither should rearrange tabs.
    if (error instanceof Error && ['AbortError', 'BootstrapRequiredError'].includes(error.name)) throw error;
    return {
      groups: planGroupByDomain(tabs), method: 'domain', provider,
      fallbackReason: error instanceof Error ? error.message : '分类引擎未能完成请求',
    };
  }
}

export function resolveAPIEndpoint(settings: AISettings): string {
  const value = settings.provider === 'custom'
    ? settings.apiEndpoint?.trim()
    : (settings.provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/chat/completions');
  if (!value) throw new Error('请填写自定义接口 URL。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('接口 URL 无效，请填写完整的 http:// 或 https:// 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('接口 URL 仅支持 HTTP/HTTPS，不能包含用户名、密码或片段。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname) url.pathname = '/v1/chat/completions';
  else if (!pathname.endsWith('/chat/completions')) url.pathname = `${pathname}/chat/completions`;
  else url.pathname = pathname;
  return url.href;
}

export class APIAccessRequiredError extends Error {
  constructor() { super('点击连接以授权访问'); this.name = 'APIAccessRequiredError'; }
}

async function authorizeAPIEndpoint(endpoint: string, requestPermission = true): Promise<void> {
  if (!chrome.permissions?.request) throw new Error('扩展权限接口不可用，请重新加载 TabFlow。');
  const url = new URL(endpoint);
  const origins = [`${url.protocol}//${url.hostname}/*`];
  if (!requestPermission) {
    if (!await chrome.permissions.contains({ origins })) throw new APIAccessRequiredError();
    return;
  }
  // Request synchronously from the initiating click to preserve the user gesture.
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error(`尚未授权访问 ${url.origin}，请在设置中点击“授权并测试连接”。`);
}

function apiHeaders(settings: AISettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = settings.apiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function fetchAPI(endpoint: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(endpoint, {
      ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error(`无法连接 ${new URL(endpoint).origin}：请检查服务和端口、扩展访问权限，以及是否存在重定向或浏览器网络限制。`);
  }
}

export async function getAPIModels(settings: AISettings, options: { requestPermission?: boolean } = {}): Promise<CodexModel[]> {
  const endpoint = resolveAPIEndpoint(settings);
  await authorizeAPIEndpoint(endpoint, options.requestPermission !== false);
  const modelsURL = new URL(endpoint);
  modelsURL.pathname = modelsURL.pathname.replace(/\/chat\/completions$/, '/models');
  const response = await fetchAPI(modelsURL.href, { method: 'GET', headers: apiHeaders(settings) });
  if (!response.ok) throw new Error(`模型列表接口返回 HTTP ${response.status}，请检查 API Key 和接口路径。`);
  let data: { data?: Array<{ id?: unknown; name?: unknown; display_name?: unknown }> };
  try { data = await response.json(); } catch { throw new Error('模型列表接口未返回有效 JSON。'); }
  if (!Array.isArray(data?.data)) throw new Error('模型列表格式不兼容，应返回 { data: [...] }。');
  const models = new Map<string, CodexModel>();
  for (const item of data.data) {
    if (item && typeof item.id === 'string' && item.id.trim()) {
      // API model IDs include routing prefixes; display them verbatim so distinct
      // routes with the same human-readable name remain distinguishable.
      models.set(item.id, { id: item.id, name: item.id });
    }
  }
  return [...models.values()];
}

export async function testAPIConnection(settings: AISettings): Promise<{ modelCount: number }> {
  return { modelCount: (await getAPIModels(settings)).length };
}

async function callCloudLLM(tabs: TabData[], settings: AISettings): Promise<ProposedGroup[]> {
  const endpoint = resolveAPIEndpoint(settings);
  const model = settings.model?.trim() || (settings.provider === 'deepseek' ? 'deepseek-chat' : settings.provider === 'openai' ? 'gpt-4o-mini' : '');
  if (!model) throw new Error('请填写自定义接口的模型名称。');
  if (settings.provider !== 'custom' && !settings.apiKey?.trim()) throw new Error('请填写 API Key。');
  await authorizeAPIEndpoint(endpoint);

  const instruction = settings.customPrompt || DEFAULT_GROUPING_PROMPT;
  const systemMessage = `${instruction}
必须严格输出 JSON 数组，格式为：
[
  { "name": "组名(2-6个中文字符)", "color": "blue", "tabIds": [101, 102] }
]
可选颜色仅限：grey, blue, red, yellow, green, pink, purple, cyan。除 JSON 数组外不要输出任何其他说明文字。`;

  const tabsSummary = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));

  const res = await fetchAPI(endpoint, {
    method: 'POST',
    headers: apiHeaders(settings),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: JSON.stringify(tabsSummary) },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new Error(`分类接口返回 HTTP ${res.status}，请检查接口路径、API Key 和模型名称。`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const match = text.match(/\[\s*\{.*\}\s*\]/s);
  if (!match) {
    throw new Error('Failed to parse JSON response from LLM');
  }

  const groups = JSON.parse(match[0]) as ProposedGroup[];
  return groups.filter((g) => g.name && Array.isArray(g.tabIds) && g.tabIds.length > 0);
}

// 4. Execution & Undo
export async function executeTabGrouping(proposedGroups: ProposedGroup[], allTabs: TabData[]): Promise<GroupingUndoState> {
  // TabData is a UI snapshot without positions; read Chrome before any mutation.
  const liveTabs = await chrome.tabs.query({});
  const inputIds = new Set(allTabs.map((tab) => tab.id));
  const originalTabState = liveTabs.filter((tab) => tab.id !== undefined && inputIds.has(tab.id)).map((tab) => ({
    tabId: tab.id!, originalGroupId: tab.groupId,
    originalWindowId: tab.windowId, originalIndex: tab.index,
  }));
  const originalGroupIds = new Set(originalTabState.map((tab) => tab.originalGroupId).filter((id) => id !== -1));
  const originalGroups = (await chrome.tabGroups.query({})).filter((group) => originalGroupIds.has(group.id)).map((group) => ({
    groupId: group.id, title: group.title || '', color: group.color,
    collapsed: group.collapsed, windowId: group.windowId,
    members: liveTabs.filter((tab) => tab.groupId === group.id && tab.id !== undefined)
      .map((tab) => ({ tabId: tab.id!, index: tab.index })).sort((a, b) => a.index - b.index),
  }));
  if (originalGroups.length !== originalGroupIds.size) {
    throw new Error('无法读取原标签组信息，请重试整理。');
  }
  const undoState: GroupingUndoState = {
    originalTabState, originalGroups, createdGroupIds: [], affectedTabIds: [], restoredGroupIds: {},
  };

  for (const group of proposedGroups) {
    if (!group.tabIds || group.tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: group.tabIds as [number, ...number[]] });
      // A metadata failure still leaves a real group that must be undoable.
      undoState.createdGroupIds.push(groupId);
      undoState.affectedTabIds.push(...group.tabIds);
      await chrome.tabGroups.update(groupId, {
        title: group.name, color: group.color, collapsed: false,
      });
    } catch (e) {
      console.warn('Failed to create group:', group.name, e);
    }
  }
  return undoState;
}

export async function undoTabGrouping(undoState: GroupingUndoState): Promise<void> {
  let step = '读取标签状态';
  try {
    const affected = new Set(undoState.affectedTabIds);
    const originals = undoState.originalTabState.filter((tab) => affected.has(tab.tabId));
    // A missing tab or one moved to a different window belongs to the user now.
    const eligibleTabs = async () => {
      const live = new Map((await chrome.tabs.query({})).map((tab) => [tab.id, tab]));
      return originals.filter((tab) => live.get(tab.tabId)?.windowId === tab.originalWindowId && !live.get(tab.tabId)?.pinned);
    };
    step = '恢复未分组标签';
    for (const tab of (await eligibleTabs()).filter((tab) => tab.originalGroupId === -1)) {
      await chrome.tabs.ungroup(tab.tabId);
    }

    const restoredGroups: Array<{ original: GroupingUndoState['originalGroups'][number]; groupId: number }> = [];
    for (const original of undoState.originalGroups) {
      const tabs = (await eligibleTabs()).filter((tab) => tab.originalGroupId === original.groupId)
        .sort((a, b) => a.originalIndex - b.originalIndex);
      if (!tabs.length) continue;
      step = `恢复标签组“${original.title || '未命名'}”`;
      const liveGroups = await chrome.tabGroups.query({});
      const priorId = undoState.restoredGroupIds[original.groupId];
      const existing = liveGroups.find((group) => group.windowId === original.windowId
        && (group.id === priorId || group.id === original.groupId));
      let groupId: number;
      if (existing) {
        groupId = existing.id;
        await chrome.tabs.group({ groupId, tabIds: tabs.map((tab) => tab.tabId) as [number, ...number[]] });
      } else {
        groupId = await chrome.tabs.group({ createProperties: { windowId: original.windowId },
          tabIds: tabs.map((tab) => tab.tabId) as [number, ...number[]] });
      }
      // Save before any further API call, including metadata and order restoration.
      undoState.restoredGroupIds[original.groupId] = groupId;
      restoredGroups.push({ original, groupId });

      step = `恢复标签组“${original.title || '未命名'}”的顺序`;
      for (const tab of tabs) {
        if (!(await eligibleTabs()).some((item) => item.tabId === tab.tabId)) continue;
        const members = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index);
        const originalMembers = original.members.filter((member) => members.some((live) => live.id === member.tabId));
        const memberIndex = originalMembers.findIndex((member) => member.tabId === tab.tabId);
        if (memberIndex >= 0 && members.length) {
          await chrome.tabs.move(tab.tabId, { index: members[0].index + memberIndex });
        }
      }
    }

    // Move whole groups as blocks to avoid tearing a restored group apart. New
    // members stay in their group; no tab is closed or recreated by undo.
    step = '恢复标签位置';
    const eligible = await eligibleTabs();
    const positions = [
      ...eligible.filter((tab) => tab.originalGroupId === -1).map((tab) => ({
        index: tab.originalIndex, windowId: tab.originalWindowId, tabId: tab.tabId, groupId: undefined as number | undefined,
      })),
      ...restoredGroups.map(({ original, groupId }) => ({
        index: original.members[0].index, windowId: original.windowId, tabId: undefined as number | undefined, groupId,
      })),
    ].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    for (const position of positions) {
      if (position.groupId !== undefined) {
        const live = (await chrome.tabGroups.query({})).find((group) => group.id === position.groupId);
        const original = restoredGroups.find((group) => group.groupId === position.groupId)!.original;
        if (!(await eligibleTabs()).some((tab) => tab.originalGroupId === original.groupId)) continue;
        if (live?.windowId !== position.windowId) throw new Error('待恢复的标签组已变化');
        const windowTabs = await chrome.tabs.query({ windowId: position.windowId });
        const size = windowTabs.filter((tab) => tab.groupId === position.groupId).length;
        const pinnedCount = windowTabs.filter((tab) => tab.pinned).length;
        await chrome.tabGroups.move(position.groupId, { index: Math.max(pinnedCount, Math.min(position.index, Math.max(0, windowTabs.length - size))) });
      } else if ((await eligibleTabs()).some((tab) => tab.tabId === position.tabId)) {
        const windowTabs = await chrome.tabs.query({ windowId: position.windowId });
        const pinnedCount = windowTabs.filter((tab) => tab.pinned).length;
        await chrome.tabs.move(position.tabId!, { index: Math.max(pinnedCount, Math.min(position.index, Math.max(0, windowTabs.length - 1))) });
      }
    }
    for (const { original, groupId } of restoredGroups) {
      step = `恢复标签组“${original.title || '未命名'}”的名称、颜色和折叠状态`;
      const live = (await chrome.tabGroups.query({})).find((group) => group.id === groupId);
      if (!(await eligibleTabs()).some((tab) => tab.originalGroupId === original.groupId)) continue;
      if (live?.windowId !== original.windowId) throw new Error('待恢复的标签组已变化');
      await chrome.tabGroups.update(groupId, { title: original.title, color: original.color, collapsed: original.collapsed });
    }
  } catch (error) {
    throw new Error(`撤销分组失败（${step}），请重试：${error instanceof Error ? error.message : String(error)}`);
  }
}

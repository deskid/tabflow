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
  }>;
  createdGroupIds: number[];
}

export interface AISettings {
  provider: 'codex_native' | 'heuristic' | 'chrome_builtin' | 'openai' | 'deepseek' | 'custom';
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  customPrompt?: string;
}

const NATIVE_HOST_NAME = 'com.tabflow.codex_bridge';

// 0. Native Messaging Bridge to Local Codex Account
export async function getLocalCodexAccount(): Promise<{ loggedIn: boolean; email?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendNativeMessage) {
      resolve({ loggedIn: false, error: 'Native messaging not supported' });
      return;
    }
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'GET_CODEX_ACCOUNT' },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.success) {
          resolve({ loggedIn: false, error: chrome.runtime.lastError?.message || res?.error });
        } else {
          resolve({ loggedIn: true, email: res.account?.email });
        }
      }
    );
  });
}

export async function getLocalCodexModels(): Promise<Array<{ id: string; name: string }>> {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendNativeMessage) {
      resolve([]);
      return;
    }
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'GET_MODELS' },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.success || !Array.isArray(res.models)) {
          resolve([]);
        } else {
          resolve(res.models);
        }
      }
    );
  });
}

export async function planGroupByCodexNative(tabs: TabData[], customPrompt?: string, model?: string): Promise<ProposedGroup[] | null> {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendNativeMessage) {
      resolve(null);
      return;
    }

    const payload = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'CLASSIFY_TABS', tabs: payload, customPrompt, model },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.success || !res.groups) {
          console.warn('Native bridge error or fallback:', chrome.runtime.lastError?.message, res);
          resolve(null);
        } else {
          resolve(res.groups);
        }
      }
    );
  });
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
    const nativeResult = await planGroupByCodexNative(tabs, customPrompt, model);
    if (nativeResult && nativeResult.length > 0) {
      return nativeResult;
    }
  }

  // 2. Chrome Built-in Prompt API
  if (provider === 'chrome_builtin') {
    const builtinResult = await tryChromeBuiltinPrompt(tabs, customPrompt);
    if (builtinResult && builtinResult.length > 0) {
      return builtinResult;
    }
  }

  // 3. Cloud LLM
  if ((provider === 'openai' || provider === 'deepseek' || provider === 'custom') && settings?.apiKey) {
    try {
      return await callCloudLLM(tabs, settings);
    } catch (err) {
      console.warn('Cloud LLM failed, falling back to heuristic:', err);
    }
  }

  // Fallback: Smart Heuristic
  return planGroupBySmartHeuristic(tabs);
}

async function tryChromeBuiltinPrompt(tabs: TabData[], customPrompt?: string): Promise<ProposedGroup[] | null> {
  const anyWindow = window as any;
  if (!anyWindow.ai?.languageModel) return null;

  try {
    const instruction = customPrompt || DEFAULT_GROUPING_PROMPT;
    const session = await anyWindow.ai.languageModel.create({
      systemPrompt: `${instruction} Respond strictly in valid JSON format: [{"name": "string", "color": "grey|blue|red|yellow|green|pink|purple|cyan", "tabIds": [1, 2]}]`,
    });

    const payload = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));
    const prompt = `Classify these tabs:\n${JSON.stringify(payload)}`;
    const responseText = await session.prompt(prompt);

    const jsonMatch = responseText.match(/\[\s*\{.*\}\s*\]/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ProposedGroup[];
      return parsed.filter((g) => g.name && Array.isArray(g.tabIds) && g.tabIds.length > 0);
    }
  } catch (err) {
    console.warn('Chrome built-in AI failed:', err);
  }
  return null;
}

async function callCloudLLM(tabs: TabData[], settings: AISettings): Promise<ProposedGroup[]> {
  const endpoint = settings.apiEndpoint || (settings.provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/chat/completions');
  const model = settings.model || (settings.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');

  const instruction = settings.customPrompt || DEFAULT_GROUPING_PROMPT;
  const systemMessage = `${instruction}
必须严格输出 JSON 数组，格式为：
[
  { "name": "组名(2-6个中文字符)", "color": "blue", "tabIds": [101, 102] }
]
可选颜色仅限：grey, blue, red, yellow, green, pink, purple, cyan。除 JSON 数组外不要输出任何其他说明文字。`;

  const tabsSummary = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
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
    throw new Error(`API returned ${res.status}: ${await res.text()}`);
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
  const originalTabState = allTabs.map((t) => ({
    tabId: t.id,
    originalGroupId: t.groupId,
  }));

  const createdGroupIds: number[] = [];

  for (const group of proposedGroups) {
    if (!group.tabIds || group.tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: group.tabIds as [number, ...number[]] });
      await chrome.tabGroups.update(groupId, {
        title: group.name,
        color: group.color,
        collapsed: false,
      });
      createdGroupIds.push(groupId);
    } catch (e) {
      console.warn('Failed to create group:', group.name, e);
    }
  }

  return {
    originalTabState,
    createdGroupIds,
  };
}

export async function undoTabGrouping(undoState: GroupingUndoState): Promise<void> {
  const ungroupTabIds: number[] = [];
  const regroupMap = new Map<number, number[]>();

  for (const item of undoState.originalTabState) {
    if (item.originalGroupId === chrome.tabGroups.TAB_GROUP_ID_NONE || item.originalGroupId === -1) {
      ungroupTabIds.push(item.tabId);
    } else {
      const list = regroupMap.get(item.originalGroupId) || [];
      list.push(item.tabId);
      regroupMap.set(item.originalGroupId, list);
    }
  }

  if (ungroupTabIds.length > 0) {
    try {
      await chrome.tabs.ungroup(ungroupTabIds as [number, ...number[]]);
    } catch (e) {
      console.warn('Failed to ungroup tabs during undo:', e);
    }
  }

  for (const [groupId, tabIds] of regroupMap.entries()) {
    try {
      await chrome.tabs.group({ groupId, tabIds: tabIds as [number, ...number[]] });
    } catch (e) {
      console.warn('Failed to restore tab to group:', groupId, e);
    }
  }
}

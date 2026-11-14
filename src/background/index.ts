// Background Service Worker for TabFlow
import { createSettingsWriter } from '../services/settingsStore';
import type { SettingsPatch } from '../services/settingsStore';

const writeSettings = createSettingsWriter();
const windowQueues = new Map<number, Promise<void>>();

function enqueueWindow(windowId: number, task: () => Promise<void>): Promise<void> {
  const pending = (windowQueues.get(windowId) ?? Promise.resolve()).then(task);
  const settled = pending.catch((error) => console.warn('Auto-group new tab error:', error));
  windowQueues.set(windowId, settled);
  void settled.then(() => { if (windowQueues.get(windowId) === settled) windowQueues.delete(windowId); });
  return settled;
}

const CATEGORIES: Array<{
  name: string;
  color: 'blue' | 'cyan' | 'green' | 'yellow' | 'purple' | 'pink' | 'red' | 'grey';
  keywords: string[];
  domains: string[];
}> = [
  {
    name: '研发与代码',
    color: 'blue',
    keywords: ['github', 'gitlab', 'npm', 'code', 'issue', 'pull request', 'rust', 'python', 'typescript', 'developer', 'api', 'docker', 'stack overflow', '终端'],
    domains: ['github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com', 'crates.io', 'developer.mozilla.org'],
  },
  {
    name: 'AI 与智能工具',
    color: 'purple',
    keywords: ['chatgpt', 'claude', 'deepseek', 'gemini', 'openai', 'ai', 'llm', 'model', 'prompt', '豆包', '通义千问', '元宝'],
    domains: ['chatgpt.com', 'claude.ai', 'deepseek.com', 'openai.com', 'doubao.com', 'huggingface.co'],
  },
  {
    name: '文档与工作协同',
    color: 'cyan',
    keywords: ['feishu', 'lark', 'docs', 'sheet', 'notion', 'wiki', '文档', '飞书', 'jira', 'confluence', 'meego', '语雀'],
    domains: ['feishu.cn', 'larksuite.com', 'notion.so', 'yuque.com', 'atlassian.net'],
  },
  {
    name: '音视频与流媒体',
    color: 'red',
    keywords: ['bilibili', 'youtube', 'video', 'watch', '视频', '播放', 'b站', '抖音', 'netflix', 'music'],
    domains: ['bilibili.com', 'youtube.com', 'netflix.com', 'douyin.com', 'music.163.com'],
  },
  {
    name: '资讯与技术社区',
    color: 'green',
    keywords: ['zhihu', 'v2ex', 'reddit', 'news', '知乎', '掘金', 'juejin', 'twitter', 'x.com', 'medium'],
    domains: ['zhihu.com', 'v2ex.com', 'juejin.cn', 'reddit.com', 'twitter.com', 'x.com', 'medium.com'],
  },
  {
    name: '电商与消费',
    color: 'yellow',
    keywords: ['taobao', 'jd', 'amazon', '淘宝', '京东', '拼多多', 'tmall', 'shop', '商品', '购物'],
    domains: ['taobao.com', 'jd.com', 'pinduoduo.com', 'amazon.com', 'tmall.com'],
  },
  {
    name: '搜索与探索',
    color: 'pink',
    keywords: ['google', 'bing', 'baidu', '搜索', 'search', '百度'],
    domains: ['google.com', 'bing.com', 'baidu.com'],
  },
];

const DOMAIN_COLOR_PALETTE: Array<'blue' | 'cyan' | 'green' | 'yellow' | 'purple' | 'pink' | 'red' | 'grey'> = [
  'blue', 'cyan', 'green', 'yellow', 'purple', 'pink', 'red', 'grey'
];

function pickColorByHost(host: string): 'blue' | 'cyan' | 'green' | 'yellow' | 'purple' | 'pink' | 'red' | 'grey' {
  let hash = 0;
  for (let i = 0; i < host.length; i++) {
    hash = (hash << 5) - hash + host.charCodeAt(i);
    hash |= 0;
  }
  return DOMAIN_COLOR_PALETTE[Math.abs(hash) % DOMAIN_COLOR_PALETTE.length];
}

function formatDomainName(host: string): string {
  const map: Record<string, string> = {
    'github.com': 'GitHub 研发',
    'feishu.cn': '飞书协同',
    'larksuite.com': 'Lark',
    'google.com': 'Google 检索',
    'bilibili.com': '哔哩哔哩',
    'youtube.com': 'YouTube 视频',
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
  if (map[host]) return map[host];
  const parts = host.split('.');
  if (parts.length >= 2) {
    const main = parts[parts.length - 2];
    return main.charAt(0).toUpperCase() + main.slice(1);
  }
  return host;
}

function matchCategory(url: string, title: string) {
  const u = url.toLowerCase();
  const t = (title || '').toLowerCase();

  for (const cat of CATEGORIES) {
    if (cat.domains.some((d) => u.includes(d))) {
      return cat;
    }
    if (cat.keywords.some((k) => u.includes(k) || t.includes(k))) {
      return cat;
    }
  }
  return null;
}

function eligibleTab(tab: chrome.tabs.Tab, windowId: number, url: string): boolean {
  return tab.windowId === windowId && tab.url === url && !tab.pinned &&
    (tab.groupId === undefined || tab.groupId === -1) && /^https?:\/\//.test(url);
}

async function freshTab(tabId: number, windowId: number, url: string) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return eligibleTab(tab, windowId, url) ? tab : null;
  } catch { return null; }
}

function hostOf(url?: string) {
  try { return new URL(url ?? '').hostname.replace(/^(www\.|m\.)/, ''); }
  catch { return ''; }
}

async function handleAutoGroupNewTab(tabId: number) {
  let initial: chrome.tabs.Tab;
  try { initial = await chrome.tabs.get(tabId); } catch { return; }
  const windowId = initial.windowId;
  const url = initial.url ?? '';
  if (!eligibleTab(initial, windowId, url)) return;
  return enqueueWindow(windowId, async () => {
    const tab = await freshTab(tabId, windowId, url);
    if (!tab) return;
    const settings = await chrome.storage.sync.get<{ sidetab_settings?: { autoGroupNewTabs?: boolean } }>('sidetab_settings');
    if (settings.sidetab_settings?.autoGroupNewTabs === false) return;
    const host = hostOf(url);
    if (!host) return;
    const category = matchCategory(url, tab.title || '');
    const windowTabs = await chrome.tabs.query({ windowId });
    const existingGroups = await chrome.tabGroups.query({ windowId });
    for (const group of existingGroups) {
      const tabsInGroup = windowTabs.filter((candidate) => candidate.groupId === group.id);
      const hasSameDomain = tabsInGroup.some((candidate) => hostOf(candidate.url) === host);
      const hostMain = host.split('.')[0];
      const titleMatches = group.title && hostMain.length > 2 &&
        (group.title.toLowerCase().includes(hostMain) || host.includes(group.title.toLowerCase()));
      const categoryMatches = category && group.title &&
        (group.title.includes(category.name) || category.name.includes(group.title));
      if (hasSameDomain || titleMatches || categoryMatches) {
        if (!await freshTab(tabId, windowId, url)) return;
        // Recheck the destination, too: it can be removed/moved while querying tabs.
        const destination = await chrome.tabGroups.get(group.id);
        if (destination.windowId !== windowId || !await freshTab(tabId, windowId, url)) return;
        await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
        return;
      }
    }
    const peer = windowTabs.find((candidate) => candidate.id !== tabId &&
      candidate.id !== undefined && eligibleTab(candidate, windowId, candidate.url ?? '') &&
      hostOf(candidate.url) === host);
    const tabIds: [number, ...number[]] = [tabId];
    if (peer?.id !== undefined && await freshTab(peer.id, windowId, peer.url ?? '')) tabIds.push(peer.id);
    // The last check is deliberately after every asynchronous preparation step.
    if (!await freshTab(tabId, windowId, url)) return;
    const newGroupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(newGroupId, {
      title: tabIds.length > 1 ? formatDomainName(host) : category?.name ?? formatDomainName(host),
      color: tabIds.length > 1 ? pickColorByHost(host) : category?.color ?? pickColorByHost(host),
      collapsed: false,
    });
  });
}

// 1. Extension lifecycle and side panel setup
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn('Failed to set panel behavior:', err);
    });
  }

  setupContextMenus();
});

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open_tabflow',
      title: '在侧边栏打开 TabFlow',
      contexts: ['all'],
    });

    chrome.contextMenus.create({
      id: 'add_to_reading_list',
      title: '将当前页面加入稍后读',
      contexts: ['page'],
    });

    chrome.contextMenus.create({
      id: 'group_by_domain',
      title: '将同域名标签页快速归类成组',
      contexts: ['all'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open_tabflow' && tab?.windowId) {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } else if (info.menuItemId === 'add_to_reading_list' && tab?.url && tab?.title) {
    try {
      if (chrome.readingList?.addEntry) {
        await chrome.readingList.addEntry({
          title: tab.title,
          url: tab.url,
          hasBeenRead: false,
        });
      }
    } catch (e) {
      console.warn('Reading list add error:', e);
    }
  } else if (info.menuItemId === 'group_by_domain' && tab?.windowId) {
    chrome.runtime.sendMessage({ action: 'TRIGGER_DOMAIN_GROUP', windowId: tab.windowId }).catch(() => {});
  }
});

// 2. Listen to tab updates for auto-grouping (fires on URL change or page load completion)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || (changeInfo.url && changeInfo.url.startsWith('http'))) {
    handleAutoGroupNewTab(tabId);
  }
});

// 3. Handle commands (keyboard shortcuts)
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_popup_window') {
    void openStandaloneWindow().catch((error) => console.warn('Open standalone window error:', error));
  }
});

// 4. Keep the response channel open until storage/window operations really finish.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let operation: Promise<unknown>;
  if (message.action === 'OPEN_STANDALONE_WINDOW') {
    operation = openStandaloneWindow(message.windowId).then((window) => ({ windowId: window.id }));
  } else if (message.action === 'UPDATE_SETTINGS' || message.action === 'UPDATE_AI_SETTINGS') {
    operation = writeSettings(message as SettingsPatch).then((settings) => ({ settings }));
  } else { return; }
  void operation.then((result) => sendResponse({ success: true, ...(result as object) }))
    .catch((error) => sendResponse({ success: false, error: String(error.message ?? error) }));
  return true;
});

async function openStandaloneWindow(sourceWindowId?: number) {
  let source: chrome.windows.Window;
  if (sourceWindowId !== undefined) {
    if (!Number.isInteger(sourceWindowId) || sourceWindowId < 0) throw new Error('来源浏览器窗口 ID 无效。');
    try { source = await chrome.windows.get(sourceWindowId); }
    catch { throw new Error('来源浏览器窗口已关闭或不可访问。'); }
  } else {
    try { source = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); }
    catch { throw new Error('无法确定来源浏览器窗口，请从普通浏览器窗口打开 TabFlow。'); }
  }
  if (source.type !== 'normal' || source.id === undefined) {
    throw new Error('来源必须是普通浏览器窗口，请从普通浏览器窗口打开 TabFlow。');
  }
  // Verify again before creating the popup if the source closed during resolution.
  try {
    const current = await chrome.windows.get(source.id);
    if (current.type !== 'normal') throw new Error('not normal');
  } catch { throw new Error('来源浏览器窗口已关闭或不可访问。'); }
  const popup = await chrome.windows.create({
    url: 'popup.html?windowId=' + source.id,
    type: 'popup', width: 380, height: 750,
    left: source.left !== undefined ? source.left + 20 : 100,
    top: source.top !== undefined ? source.top + 60 : 100,
    focused: true,
  });
  if (!popup || popup.id === undefined) throw new Error('浏览器未返回新建独立窗口。');
  return popup;
}

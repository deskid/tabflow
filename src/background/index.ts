// Background Service Worker for TabFlow

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

const processingTabs = new Set<number>();

async function handleAutoGroupNewTab(tabId: number) {
  if (processingTabs.has(tabId)) return;
  processingTabs.add(tabId);

  try {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }

    if (!tab || !tab.id || !tab.windowId || tab.pinned) return;

    // Ignore browser internal or blank pages
    if (
      !tab.url ||
      tab.url.startsWith('chrome://') ||
      tab.url.startsWith('edge://') ||
      tab.url.startsWith('about:') ||
      tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('devtools://')
    ) {
      return;
    }

    // Skip if already in a valid group
    const noneGroupId = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;
    if (tab.groupId !== undefined && tab.groupId !== -1 && tab.groupId !== noneGroupId) {
      return;
    }

    // Check user preference
    const settings = await new Promise<{ autoGroupNewTabs?: boolean }>((resolve) => {
      chrome.storage.sync.get('sidetab_settings', (res) => {
        resolve(res?.sidetab_settings || {});
      });
    });

    if (settings.autoGroupNewTabs === false) {
      return;
    }

    let host = '';
    try {
      host = new URL(tab.url).hostname.replace(/^(www\.|m\.)/, '');
    } catch {
      return;
    }
    if (!host) return;

    const category = matchCategory(tab.url, tab.title || '');
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    const existingGroups = await chrome.tabGroups.query({ windowId: tab.windowId });

    // 1. Join an existing group if domain, title, or category matches
    for (const group of existingGroups) {
      const tabsInGroup = windowTabs.filter((t) => t.groupId === group.id);
      const hasSameDomain = tabsInGroup.some((t) => t.url && t.url.includes(host));
      const hostMain = host.split('.')[0];
      const titleMatches = group.title && hostMain.length > 2 && (group.title.toLowerCase().includes(hostMain) || host.includes(group.title.toLowerCase()));
      const categoryMatches = category && group.title && (group.title.includes(category.name) || category.name.includes(group.title));

      if (hasSameDomain || titleMatches || categoryMatches) {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
        return;
      }
    }

    // 2. If no existing group, check for another ungrouped tab of the same domain
    const otherUngrouped = windowTabs.filter(
      (t) =>
        t.id !== tab.id &&
        !t.pinned &&
        (t.groupId === undefined || t.groupId === -1 || t.groupId === noneGroupId) &&
        t.url &&
        !t.url.startsWith('chrome://') &&
        !t.url.startsWith('about:')
    );

    const sameDomainTab = otherUngrouped.find((t) => t.url && t.url.includes(host));
    if (sameDomainTab && sameDomainTab.id) {
      const newGroupId = await chrome.tabs.group({
        tabIds: [sameDomainTab.id, tab.id] as [number, ...number[]],
      });
      const groupTitle = formatDomainName(host);
      const groupColor = pickColorByHost(host);
      await chrome.tabGroups.update(newGroupId, {
        title: groupTitle,
        color: groupColor,
        collapsed: false,
      });
      return;
    }

    // 3. Auto-create a group for this new tab based on category or domain
    if (category) {
      const newGroupId = await chrome.tabs.group({
        tabIds: [tab.id] as [number, ...number[]],
      });
      await chrome.tabGroups.update(newGroupId, {
        title: category.name,
        color: category.color,
        collapsed: false,
      });
      return;
    }

    // 4. Default: create group with domain title
    const newGroupId = await chrome.tabs.group({
      tabIds: [tab.id] as [number, ...number[]],
    });
    await chrome.tabGroups.update(newGroupId, {
      title: formatDomainName(host),
      color: pickColorByHost(host),
      collapsed: false,
    });
  } catch (err) {
    console.warn('Auto-group new tab error:', err);
  } finally {
    setTimeout(() => {
      processingTabs.delete(tabId);
    }, 1500);
  }
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
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open_popup_window') {
    openStandaloneWindow();
  }
});

// 4. Handle messages from Sidepanel or Popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'OPEN_STANDALONE_WINDOW') {
    openStandaloneWindow(message.windowId);
    sendResponse({ success: true });
    return true;
  }
});

async function openStandaloneWindow(currentWindowId?: number) {
  let targetWindow = null;
  if (currentWindowId) {
    try {
      targetWindow = await chrome.windows.get(currentWindowId);
    } catch {
      // ignore
    }
  }

  const left = targetWindow && targetWindow.left !== undefined ? targetWindow.left + 20 : 100;
  const top = targetWindow && targetWindow.top !== undefined ? targetWindow.top + 60 : 100;

  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 380,
    height: 750,
    left,
    top,
    focused: true,
  });
}

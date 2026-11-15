#!/usr/bin/env node
// Local-only screenshot harness. No real browser APIs, user data or model calls.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPING_PROMPT_PRESETS } from '../src/services/groupingPresets.ts';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
function bootstrap(scene) {
  return `(${function (scene, prompt) {
    const event = () => ({ addListener() {}, removeListener() {} });
    const changed = new Set();
    const icon = (label, fill) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="${fill}"/><text x="16" y="22" font-family="Arial" font-size="21" text-anchor="middle" fill="white">${label}</text></svg>`);
    const rows = [
      [1, -1, 'Chrome 扩展开发', 'https://developer.chrome.com/docs/extensions', 'C', '#4f77e8', true],
      [2, -1, '常用开发工具', 'https://tools.example.com', 'T', '#7057d8', true],
      [11, 10, 'TabFlow 演示项目', 'https://github.com/deskid/tabflow', 'G', '#334155'],
      [12, 10, 'React 官方文档', 'https://react.dev/learn', 'R', '#059bbf'],
      [13, 10, 'TypeScript 使用手册', 'https://www.typescriptlang.org/docs', 'T', '#3976d8'],
      [21, 20, 'Chrome 内置 AI 文档', 'https://developer.chrome.com/docs/ai', 'A', '#8065d8'],
      [22, 20, 'JavaScript 学习指南', 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript', 'J', '#d09915'],
      [23, 20, 'Web 性能优化参考', 'https://web.dev/learn/performance', 'W', '#0c9b71'],
      [31, 30, '演示项目设计文档', 'https://docs.example.com/project', 'D', '#0ba0ae'],
      [32, 30, '演示项目任务看板', 'https://tasks.example.com/board', 'K', '#0c95b2'],
      [41, -1, '稍后整理的参考资料', 'https://read.example.com/notes', 'N', '#64748b'],
    ];
    const tabs = rows.map(([id, groupId, title, url, label, color, pinned], index) => ({ id, groupId, title, url, windowId: 7, index, active: id === 12, pinned: !!pinned, favIconUrl: icon(label, color), audible: false, discarded: false }));
    const groups = [{ id: 10, windowId: 7, title: '研发与代码', color: 'blue', collapsed: false }, { id: 20, windowId: 7, title: '阅读与研究', color: 'purple', collapsed: false }, { id: 30, windowId: 7, title: '工作协同', color: 'cyan', collapsed: false }];
    const settings = { theme: 'light', density: 'comfortable', showFavicon: true, showDuplicateCount: true, autoGroupNewTabs: true, aiProfiles: {}, aiSettings: { provider: scene === 'settings' ? 'custom' : 'heuristic', apiKey: '', apiEndpoint: '', model: '', customPrompt: prompt } };
    const entries = [{ title: '打造易用的浏览器侧边栏', url: 'https://read.example.com/sidebar', hasBeenRead: false }, { title: 'Chrome 扩展权限指南', url: 'https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions', hasBeenRead: false }, { title: '用主题整理浏览会话', url: 'https://read.example.com/topics', hasBeenRead: false }, { title: '现代 Web 开发实践', url: 'https://read.example.com/web', hasBeenRead: true }];
    const bookmarkEvents = { onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event() };
    window.chrome = {
      runtime: { getURL: (file) => '/' + file, onMessage: event(), sendNativeMessage: (_host, _request, callback) => callback({ success: false, error: '演示界面不连接模型服务' }),
        sendMessage: async (request) => { if (request.action === 'UPDATE_AI_SETTINGS') Object.assign(settings.aiSettings, request.patch); else if (request.action === 'UPDATE_SETTINGS') Object.assign(settings, request.patch); changed.forEach((fn) => fn({ sidetab_settings: { newValue: structuredClone(settings) } }, 'sync')); return { success: true, settings }; } },
      storage: { sync: { get: (key, callback) => { const result = { [key]: structuredClone(settings) }; if (callback) queueMicrotask(() => callback(result)); return Promise.resolve(result); }, set: async () => {} }, onChanged: { addListener: (fn) => changed.add(fn), removeListener: (fn) => changed.delete(fn) } },
      windows: { getCurrent: async () => ({ id: 7, type: 'normal' }), get: async () => ({ id: 7, type: 'normal' }), getLastFocused: async () => ({ id: 7, type: 'normal' }), update: async () => {}, onRemoved: event() },
      tabs: { query: async (query) => tabs.filter((tab) => query.groupId === undefined || tab.groupId === query.groupId), create: async () => {}, update: async () => {}, onUpdated: event(), onCreated: event(), onRemoved: event(), onMoved: event(), onActivated: event(), onAttached: event(), onDetached: event() },
      tabGroups: { query: async () => groups, onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event() },
      bookmarks: { ...bookmarkEvents, getTree: async () => [{ id: '0', title: '', children: [{ id: '1', title: '书签栏', children: [{ id: '11', title: '开发资料', children: tabs.filter((tab) => tab.groupId === 10).map((tab) => ({ id: String(tab.id), title: tab.title, url: tab.url })) }] }, { id: '2', title: '其他书签', children: [] }] }] },
      readingList: { query: async () => entries, onEntryAdded: event(), onEntryRemoved: event(), onEntryUpdated: event() },
      permissions: { request: async () => false, contains: async () => false },
    };
    const fetchLocal = window.fetch.bind(window);
    window.fetch = (url, options) => new URL(url, location.href).origin === location.origin ? fetchLocal(url, options) : Promise.reject(new Error('Remote requests are disabled in the screenshot harness.'));
    window.addEventListener('error', (error) => { document.documentElement.dataset.demoError = error.message; });
    const ready = () => {
      if (!document.querySelector('button[title="设置"]')) return setTimeout(ready, 100);
      if (scene === 'settings') {
        document.querySelector('button[title="设置"]').click();
        setTimeout(() => { document.getElementById('grouping-style')?.scrollIntoView({ block: 'center' }); document.documentElement.dataset.demoReady = scene; }, 500);
      } else if (scene === 'reading') {
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('稍后读'))?.click();
        setTimeout(() => { document.documentElement.dataset.demoReady = scene; }, 500);
      } else document.documentElement.dataset.demoReady = scene;
    };
    setTimeout(ready, 500);
  }.toString()})(${JSON.stringify(scene)},${JSON.stringify(GROUPING_PROMPT_PRESETS[0].prompt)});`;
}
const contentTypes = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/demo.html') {
      const scene = ['tabs', 'reading', 'settings'].includes(url.searchParams.get('scene')) ? url.searchParams.get('scene') : 'tabs';
      const html = (await readFile(path.join(root, 'sidepanel.html'), 'utf8')).replace('<head>', `<head><script>${bootstrap(scene)}</script>`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream' }); response.end(data);
  } catch { if (!response.headersSent) { response.writeHead(404); response.end('Not found'); } else response.destroy(); }
});
server.listen(43187, '127.0.0.1', () => console.log('TabFlow screenshot demo: http://127.0.0.1:43187/demo.html (synthetic data only)'));

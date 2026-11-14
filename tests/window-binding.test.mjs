import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolveTargetWindowId, createTargetWindowBinding } from '../src/services/targetWindow.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const dataURL = (text) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`;
const targetURL = dataURL(await readFile(new URL('../src/services/targetWindow.ts', import.meta.url), 'utf8'));
const reactURL = dataURL(`
export const useState = (...args) => globalThis.__windowRunner.useState(...args);
export const useRef = (...args) => globalThis.__windowRunner.useRef(...args);
export const useEffect = (...args) => globalThis.__windowRunner.useEffect(...args);
export const useCallback = (...args) => globalThis.__windowRunner.useCallback(...args);
`);
const groupingURL = dataURL(`
export const planGroupByDomain = (...args) => globalThis.__windowGrouping.plan(...args);
export const planGroupingWithFallback = async (...args) => ({ groups: globalThis.__windowGrouping.plan(...args), method: 'model', provider: 'codex_native' });
export const executeTabGrouping = (...args) => globalThis.__windowGrouping.execute(...args);
export const undoTabGrouping = (...args) => globalThis.__windowGrouping.undo(...args);
`);
const hookSource = (await readFile(new URL('../src/hooks/useTabsManager.ts', import.meta.url), 'utf8'))
  .replace("'react'", JSON.stringify(reactURL))
  .replace("'../services/targetWindow'", JSON.stringify(targetURL))
  .replace(/import\s*\{[^}]+\}\s*from '\.\.\/services\/aiGrouper';/u,
    `import { planGroupByDomain, planGroupingWithFallback, executeTabGrouping, undoTabGrouping } from ${JSON.stringify(groupingURL)};`);
const { useTabsManager } = await import(dataURL(hookSource));
const { useBookmarks } = await import(dataURL((await readFile(new URL('../src/hooks/useBookmarks.ts', import.meta.url), 'utf8')).replace("'react'", JSON.stringify(reactURL))));
const { useReadingList } = await import(dataURL((await readFile(new URL('../src/hooks/useReadingList.ts', import.meta.url), 'utf8')).replace("'react'", JSON.stringify(reactURL))));
function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), fire: (...args) => [...listeners].forEach((fn) => fn(...args)) };
}
function runner(renderHook) {
  const slots = [], effects = [], cleanups = [];
  let cursor = 0;
  const changed = (old, deps) => !old || deps.some((item, i) => item !== old[i]);
  const instance = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn, deps) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
    render() { globalThis.__windowRunner = instance; cursor = 0; const result = renderHook(); effects.splice(0).forEach((fn) => fn()); return result; },
    stop() { cleanups.forEach((fn) => fn?.()); },
  };
  return instance;
}
function browser() {
  const queries = [], creates = [], focuses = [];
  const windows = new Map([[7, { id: 7, type: 'normal' }], [8, { id: 8, type: 'normal' }], [99, { id: 99, type: 'popup' }]]);
  const tabs = [{ id: 1, index: 0, windowId: 7, title: 'Code', url: 'https://example.test', groupId: -1, active: true }, { id: 2, index: 1, windowId: 7, title: 'Docs', url: 'https://example.test/docs', groupId: -1 }];
  globalThis.location = { search: '?windowId=7' };
  globalThis.chrome = {
    windows: { get: async (id) => { if (!windows.has(id)) throw Error('No window'); return windows.get(id); }, getCurrent: async () => windows.get(99), getLastFocused: async () => windows.get(8), onRemoved: event(), update: async (id) => { focuses.push(id); } },
    tabs: { query: async (query) => { queries.push(query); return tabs.filter((tab) => tab.windowId === query.windowId); }, create: async (details) => { creates.push(details); }, update: async () => {}, onUpdated: event(), onCreated: event(), onRemoved: event(), onMoved: event(), onActivated: event(), onAttached: event(), onDetached: event() },
    tabGroups: { query: async () => [], onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event() },
    bookmarks: { getTree: async () => [], onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event() },
    readingList: { query: async () => [], onEntryAdded: event(), onEntryRemoved: event(), onEntryUpdated: event() },
  };
  globalThis.__windowGrouping = { plan: () => [{ name: 'Work', color: 'blue', tabIds: [1, 2] }], execute: async () => ({ originalTabState: [], createdGroupIds: [100] }), undo: async () => {} };
  return { windows, tabs, queries, creates, focuses };
}

test('explicit source wins over popup and closed source never falls back to another window', async () => {
  const b = browser();
  assert.equal(await resolveTargetWindowId('?windowId=7'), 7);
  b.windows.delete(7);
  await assert.rejects(resolveTargetWindowId('?windowId=7'), /关闭|不可用/);
  await assert.rejects(resolveTargetWindowId('?windowId=99'), /关闭|不可用/);
  for (const id of ['-1', '1.2', 'abc', '1e2', '9007199254740992']) await assert.rejects(resolveTargetWindowId(`?windowId=${id}`), /参数无效/);
});
test('unbound view uses normal current window or filtered last focused browser', async () => {
  browser();
  chrome.windows.getCurrent = async () => ({ id: 7, type: 'normal' });
  assert.equal(await resolveTargetWindowId(''), 7);
  chrome.windows.getCurrent = async () => ({ id: 99, type: 'popup' });
  chrome.windows.getLastFocused = async (options) => { assert.deepEqual(options, { windowTypes: ['normal'] }); return { id: 8, type: 'normal' }; };
  assert.equal(await resolveTargetWindowId(''), 8);
  chrome.windows.getLastFocused = async () => ({ id: 99, type: 'popup' });
  await assert.rejects(resolveTargetWindowId(''), /不可用/);
});
test('binding shares initial lookup and stays fixed after focus changes', async () => {
  browser(); let calls = 0;
  chrome.windows.getCurrent = async () => { calls++; return { id: 7, type: 'normal' }; };
  const bind = createTargetWindowBinding('');
  assert.deepEqual(await Promise.all([bind(), bind()]), [7, 7]);
  chrome.windows.getCurrent = async () => ({ id: 8, type: 'normal' });
  assert.equal(await bind(), 7);
  assert.equal(calls, 1);
});
test('initial transient lookup failure does not poison a binding', async () => {
  browser();
  const bind = createTargetWindowBinding('');
  chrome.windows.getCurrent = async () => { throw Error('Temporary'); };
  await assert.rejects(bind());
  chrome.windows.getCurrent = async () => ({ id: 7, type: 'normal' });
  assert.equal(await bind(), 7);
});
test('actual tab hook reads source tabs, ignores foreign activation and creates there', async () => {
  const b = browser(); const r = runner(useTabsManager);
  try {
    r.render(); await tick();
    let view = r.render();
    assert.equal(view.currentWindowId, 7);
    assert.deepEqual(view.tabs.map((tab) => tab.id), [1, 2]);
    chrome.tabs.onActivated.fire({ tabId: 90, windowId: 8 });
    assert.equal(r.render().activeTabId, 1);
    await view.createNewTab();
    assert.equal(b.creates[0].windowId, 7);
    await view.activateTab(2);
    assert.equal(b.focuses.at(-1), 7);
    b.windows.delete(7); chrome.windows.onRemoved.fire(7); await tick();
    view = r.render();
    assert.equal(view.currentWindowId, null);
    assert.deepEqual(view.tabs, []);
    assert.match(view.windowError, /关闭/);
    await view.refresh();
    assert.equal(r.render().currentWindowId, null);
    assert.ok(b.queries.every((query) => query.windowId === 7));
  } finally { r.stop(); }
});
test('out-of-order refresh cannot overwrite newer source tab state', async () => {
  browser(); let resolveOld, calls = 0;
  chrome.tabs.query = async () => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : [{ id: 3, windowId: 7, index: 0, groupId: -1, active: true }];
  const r = runner(useTabsManager);
  try {
    r.render(); await tick(); chrome.tabs.onUpdated.fire(); await tick();
    assert.deepEqual(r.render().tabs.map((tab) => tab.id), [3]);
    resolveOld([{ id: 1, windowId: 7, index: 0, groupId: -1 }]); await tick();
    assert.deepEqual(r.render().tabs.map((tab) => tab.id), [3]);
  } finally { r.stop(); }
});
test('undo failure stays actionable and retry clears the toast only after success', async () => {
  browser(); let attempts = 0;
  __windowGrouping.undo = async () => { if (++attempts === 1) throw Error('恢复未完成，请重试。'); };
  const r = runner(useTabsManager);
  try {
    r.render(); await tick(); await r.render().groupWithAI();
    assert.equal(r.render().undoToastVisible, true);
    const pending = r.render().undoGrouping();
    assert.equal(r.render().isUndoing, true);
    await pending;
    let view = r.render();
    assert.equal(view.undoToastVisible, true);
    assert.match(view.undoError, /重试/);
    await view.undoGrouping(); view = r.render();
    assert.equal(view.undoToastVisible, false);
    assert.equal(view.undoError, '');
    assert.equal(attempts, 2);
  } finally { r.stop(); }
});
test('bookmark and reading-list navigation open in the managed source window', async () => {
  const b = browser(); const bookmarks = runner(() => useBookmarks(7)); const reading = runner(() => useReadingList(7));
  try {
    await bookmarks.render().openBookmark('https://book.example');
    await reading.render().openEntry('https://read.example');
    assert.deepEqual(b.creates.map((details) => details.windowId), [7, 7]);
    assert.deepEqual(b.focuses, [7, 7]);
  } finally { bookmarks.stop(); reading.stop(); }
});

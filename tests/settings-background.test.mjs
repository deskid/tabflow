import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const urlFor = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const providerURL = urlFor(await readFile(new URL('../src/services/providerSettings.ts', import.meta.url), 'utf8'));
const storeSource = (await readFile(new URL('../src/services/settingsStore.ts', import.meta.url), 'utf8'))
  .replace("'./providerSettings'", JSON.stringify(providerURL));
const storeURL = urlFor(storeSource);
const store = await import(storeURL);
const backgroundSource = (await readFile(new URL('../src/background/index.ts', import.meta.url), 'utf8'))
  .replace("'../services/settingsStore'", JSON.stringify(storeURL));
const reactURL = urlFor(`
export const useState = (...args) => globalThis.__settingsHookRunner.useState(...args);
export const useEffect = (...args) => globalThis.__settingsHookRunner.useEffect(...args);
export const useRef = (...args) => globalThis.__settingsHookRunner.useRef(...args);
`);
const hookSource = (await readFile(new URL('../src/hooks/useSettings.ts', import.meta.url), 'utf8'))
  .replace("'react'", JSON.stringify(reactURL))
  .replaceAll("'../services/settingsStore'", JSON.stringify(storeURL));
const { useSettings } = await import(urlFor(hookSource));
function hookRunner() {
  const slots = [];
  let cursor = 0;
  const effects = [];
  const cleanups = [];
  const runner = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!(index in slots) || deps.some((dep, i) => dep !== slots[index][i])) {
        slots[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
      }
    },
    render() { globalThis.__settingsHookRunner = runner; cursor = 0; const result = useSettings(); effects.splice(0).forEach((effect) => effect()); return result; },
    stop() { cleanups.forEach((cleanup) => cleanup?.()); },
  };
  return runner;
}
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function event() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener),
    fire: (...args) => [...listeners].forEach((listener) => listener(...args)), listeners };
}
function storageMock(initial = {}) {
  let saved = structuredClone(initial);
  const onChanged = event();
  const runtime = { id: 'test-extension' };
  const sync = {
    get(key, callback) { const result = { [key]: structuredClone(saved) }; if (callback) { callback(result); return; } return Promise.resolve(result); },
    async set(value) { saved = structuredClone(value[store.SETTINGS_KEY]); onChanged.fire({ [store.SETTINGS_KEY]: { newValue: structuredClone(saved) } }, 'sync'); },
  };
  globalThis.chrome = { storage: { sync, onChanged }, runtime };
  return { sync, onChanged, runtime, saved: () => saved };
}

test('two views subscribe before initial read and never replace a newer event with stale read data', async () => {
  const { sync, onChanged } = storageMock();
  const callbacks = [];
  sync.get = (_key, callback) => { assert.equal(onChanged.listeners.size > 0, true); callbacks.push(callback); };
  const values = [[], []];
  const stops = values.map((view) => store.observeSettings((s) => view.push(s), () => {}, assert.fail));
  onChanged.fire({ [store.SETTINGS_KEY]: { newValue: { theme: 'dark' } } }, 'sync');
  callbacks.forEach((callback) => callback({ [store.SETTINGS_KEY]: { theme: 'light' } }));
  await tick();
  for (const view of values) assert.deepEqual(view.map((s) => s.theme), ['dark']);
  onChanged.fire({ [store.SETTINGS_KEY]: { newValue: { density: 'compact' } } }, 'sync');
  assert.equal(values[0].at(-1).density, 'compact');
  assert.equal(values[1].at(-1).density, 'compact');
  stops.forEach((stop) => stop());
  assert.equal(onChanged.listeners.size, 0);
});

test('concurrent view patches read latest complete storage and preserve both writes', async () => {
  const mock = storageMock(store.normalizeSettings());
  const writer = store.createSettingsWriter();
  await Promise.all([
    writer({ action: 'UPDATE_SETTINGS', patch: { theme: 'dark' } }),
    writer({ action: 'UPDATE_SETTINGS', patch: { density: 'compact' } }),
  ]);
  assert.equal(mock.saved().theme, 'dark');
  assert.equal(mock.saved().density, 'compact');
});

test('stale provider editor updates its own profile without switching the globally selected provider', async () => {
  const mock = storageMock(store.normalizeSettings({ aiSettings: { provider: 'custom', model: 'old', customPrompt: 'global' } }));
  const writer = store.createSettingsWriter();
  await Promise.all([
    writer({ action: 'UPDATE_AI_SETTINGS', patch: { provider: 'openai', model: 'openai-model' }, targetProvider: 'openai' }),
    writer({ action: 'UPDATE_AI_SETTINGS', patch: { model: 'new-custom', apiKey: 'synthetic', customPrompt: 'global-edited' }, targetProvider: 'custom' }),
  ]);
  assert.equal(mock.saved().aiSettings.provider, 'openai');
  assert.equal(mock.saved().aiSettings.model, 'openai-model');
  assert.equal(mock.saved().aiProfiles.custom.model, 'new-custom');
  assert.equal(mock.saved().aiProfiles.custom.apiKey, 'synthetic');
  assert.equal(mock.saved().aiSettings.customPrompt, 'global-edited');
  await assert.rejects(writer({ action: 'UPDATE_AI_SETTINGS', patch: { model: 'no-target' } }), /provider/);
  await writer({ action: 'UPDATE_SETTINGS', patch: { showFavicon: false } });
  assert.equal(mock.saved().showFavicon, false);
});

test('failed storage write is observable and does not poison subsequent queue work', async () => {
  const mock = storageMock();
  const original = mock.sync.set;
  mock.sync.set = async () => { mock.sync.set = original; throw new Error('quota test'); };
  const writer = store.createSettingsWriter();
  await assert.rejects(writer({ action: 'UPDATE_SETTINGS', patch: { theme: 'dark' } }), /quota test/);
  await writer({ action: 'UPDATE_SETTINGS', patch: { density: 'compact' } });
  assert.equal(mock.saved().density, 'compact');
});

test('development fallback only applies without extension runtime; runtime failures stay visible', async () => {
  delete globalThis.chrome;
  const values = [];
  const stop = store.observeDevSettings((s) => values.push(s));
  await store.sendSettingsPatch({ action: 'UPDATE_SETTINGS', patch: { theme: 'light' } });
  assert.equal(values.at(-1).theme, 'light');
  stop();
  storageMock();
  chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated'); };
  await assert.rejects(store.sendSettingsPatch({ action: 'UPDATE_SETTINGS', patch: { theme: 'dark' } }), /invalidated/);
  chrome.runtime.sendMessage = async () => ({ success: false, error: 'actual storage failure' });
  await assert.rejects(store.sendSettingsPatch({ action: 'UPDATE_SETTINGS', patch: { theme: 'dark' } }), /actual storage failure/);
});

test('hook keeps synchronous API, rendered provider target, shared updates and visible transport errors', async () => {
  const mock = storageMock(store.normalizeSettings({ aiSettings: { provider: 'custom', model: 'custom-model' } }));
  globalThis.document = { documentElement: { classList: { toggle() {} } } };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const write = store.createSettingsWriter();
  const requests = [];
  chrome.runtime.sendMessage = async (request) => { requests.push(request); return { success: true, settings: await write(request) }; };
  const first = hookRunner();
  const second = hookRunner();
  first.render(); second.render(); await tick();
  const oldView = first.render();
  const other = second.render();
  assert.equal(other.updateAISettings({ provider: 'openai', model: 'openai-model' }), undefined);
  await tick();
  // Storage event has changed the ref, but an input handler still belongs to the old render.
  assert.equal(oldView.updateAISettings({ model: 'old-view-custom-edit' }), undefined);
  await tick();
  assert.equal(requests.at(-1).targetProvider, 'custom');
  assert.equal(mock.saved().aiSettings.provider, 'openai');
  assert.equal(mock.saved().aiSettings.model, 'openai-model');
  assert.equal(mock.saved().aiProfiles.custom.model, 'old-view-custom-edit');
  assert.equal(first.render().settings.aiSettings.provider, 'openai');
  assert.equal(second.render().settings.aiSettings.provider, 'openai');
  chrome.runtime.sendMessage = async () => { throw new Error('real runtime error'); };
  first.render().updateSettings({ theme: 'light' }); await tick();
  assert.match(first.render().error, /real runtime error/);
  first.stop(); second.stop();
});

async function backgroundMock(tabs = []) {
  const mock = storageMock();
  const state = new Map(tabs.map((tab) => [tab.id, { groupId: -1, pinned: false, ...tab }]));
  const groups = new Map();
  let nextGroup = 100;
  const grouped = [];
  const created = [];
  const windows = new Map([[1, { id: 1, type: 'normal', left: 50, top: 70 }], [2, { id: 2, type: 'normal' }], [9, { id: 9, type: 'popup' }]]);
  Object.assign(chrome.runtime, { onInstalled: event(), onMessage: event() });
  chrome.tabs = {
    onUpdated: event(),
    async get(id) { if (!state.has(id)) throw new Error('Tab closed'); return { ...state.get(id) }; },
    async query({ windowId }) { return [...state.values()].filter((tab) => tab.windowId === windowId).map((tab) => ({ ...tab })); },
    async group({ tabIds, groupId }) {
      const id = groupId ?? nextGroup++;
      const windowId = state.get(tabIds[0]).windowId;
      for (const tabId of tabIds) { assert.equal(state.get(tabId).windowId, windowId); state.get(tabId).groupId = id; }
      if (!groups.has(id)) groups.set(id, { id, windowId });
      grouped.push({ tabIds, groupId: id, windowId });
      return id;
    },
  };
  chrome.tabGroups = {
    TAB_GROUP_ID_NONE: -1,
    async query({ windowId }) { return [...groups.values()].filter((group) => group.windowId === windowId).map((g) => ({ ...g })); },
    async get(id) { if (!groups.has(id)) throw new Error('Group closed'); return { ...groups.get(id) }; },
    async update(id, value) { Object.assign(groups.get(id), value); },
  };
  chrome.contextMenus = { onClicked: event() };
  chrome.commands = { onCommand: event() };
  chrome.windows = {
    async get(id) { if (!windows.has(id)) throw new Error('Window closed'); return { ...windows.get(id) }; },
    async getLastFocused(options) { assert.deepEqual(options, { windowTypes: ['normal'] }); return { ...windows.get(1) }; },
    async create(options) { created.push(options); return { id: 10, ...options }; },
  };
  await import(urlFor(backgroundSource + `\n// mock instance ${Math.random()}\n`));
  const message = (value) => new Promise((resolve) => {
    const listener = [...chrome.runtime.onMessage.listeners][0];
    assert.equal(listener(value, {}, resolve), true);
  });
  const update = (id) => chrome.tabs.onUpdated.fire(id, { status: 'complete' });
  return { ...mock, state, groups, grouped, windows, created, message, update };
}
const tab = (id, windowId = 1, url = 'https://example.org/page/' + id) => ({ id, windowId, url, title: 'Example' });
async function settle() { for (let index = 0; index < 12; index++) await tick(); }

test('three same-domain simultaneous tabs in one window form one group', async () => {
  const mock = await backgroundMock([tab(1), tab(2), tab(3)]);
  [1, 2, 3].forEach(mock.update);
  await settle();
  assert.equal(mock.groups.size, 1);
  assert.equal(new Set([...mock.state.values()].map((t) => t.groupId)).size, 1);
  assert.notEqual(mock.state.get(1).groupId, -1);
});

test('different windows execute independently while one window is blocked', async () => {
  const mock = await backgroundMock([tab(1), tab(2, 2)]);
  const gate = defer();
  const query = chrome.tabs.query;
  chrome.tabs.query = async (options) => { if (options.windowId === 1) await gate.promise; return query(options); };
  mock.update(1); mock.update(2);
  await settle();
  assert.equal(mock.state.get(1).groupId, -1);
  assert.notEqual(mock.state.get(2).groupId, -1);
  gate.resolve(); await settle();
  assert.notEqual(mock.state.get(1).groupId, -1);
});

test('auto-group failure does not poison window queue or suppress subsequent navigation', async () => {
  const mock = await backgroundMock([tab(1), tab(2, 1, 'https://other.org')]);
  const group = chrome.tabs.group;
  let fail = true;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    chrome.tabs.group = async (options) => { if (fail) { fail = false; throw new Error('synthetic group failure'); } return group(options); };
    mock.update(1); mock.update(2);
    await settle();
    assert.notEqual(mock.state.get(2).groupId, -1);
    mock.state.get(1).url = 'https://new-navigation.org';
    mock.update(1); await settle();
    assert.notEqual(mock.state.get(1).groupId, -1);
    assert.match(warnings[0][1].message, /synthetic group failure/);
  } finally { console.warn = warn; }
});

for (const change of ['close', 'move', 'pin', 'group', 'url']) {
  test(`auto-group checks ${change} before committing`, async () => {
    const mock = await backgroundMock([tab(1)]);
    const gate = defer();
    const query = chrome.tabGroups.query;
    chrome.tabGroups.query = async (options) => { await gate.promise; return query(options); };
    mock.update(1); await tick();
    if (change === 'close') mock.state.delete(1);
    if (change === 'move') mock.state.get(1).windowId = 2;
    if (change === 'pin') mock.state.get(1).pinned = true;
    if (change === 'group') mock.state.get(1).groupId = 50;
    if (change === 'url') mock.state.get(1).url = 'https://changed.org';
    gate.resolve(); await settle();
    assert.equal(mock.grouped.length, 0);
  });
}

test('queued tab is rechecked when its window task starts', async () => {
  const mock = await backgroundMock([tab(1), tab(2, 1, 'https://other.org')]);
  const gate = defer();
  const query = chrome.tabs.query;
  let first = true;
  chrome.tabs.query = async (options) => { if (first) { first = false; await gate.promise; } return query(options); };
  mock.update(1); mock.update(2); await tick();
  mock.state.get(2).pinned = true;
  gate.resolve(); await settle();
  assert.equal(mock.state.get(2).groupId, -1);
});

test('standalone resolves normal source, retains coordinates and awaits window creation', async () => {
  const mock = await backgroundMock();
  const gate = defer();
  const create = chrome.windows.create;
  chrome.windows.create = async (options) => { await gate.promise; return create(options); };
  let responded = false;
  const result = mock.message({ action: 'OPEN_STANDALONE_WINDOW', windowId: 1 }).then((r) => { responded = true; return r; });
  await tick(); assert.equal(responded, false);
  gate.resolve();
  assert.equal((await result).success, true);
  assert.deepEqual(mock.created[0], { url: 'popup.html?windowId=1', type: 'popup', width: 380, height: 750, left: 70, top: 130, focused: true });
  assert.equal((await mock.message({ action: 'OPEN_STANDALONE_WINDOW' })).success, true);
  chrome.commands.onCommand.fire('open_popup_window'); await settle();
  assert.equal(mock.created.at(-1).url, 'popup.html?windowId=1');
});

test('standalone rejects popup sources, missing windows, source closure and creation failure', async () => {
  const mock = await backgroundMock();
  assert.equal((await mock.message({ action: 'OPEN_STANDALONE_WINDOW', windowId: 9 })).success, false);
  assert.match((await mock.message({ action: 'OPEN_STANDALONE_WINDOW', windowId: 99 })).error, /已关闭/);
  const get = chrome.windows.get;
  let calls = 0;
  chrome.windows.get = async (id) => { if (++calls > 1) throw new Error('closed during resolve'); return get(id); };
  assert.match((await mock.message({ action: 'OPEN_STANDALONE_WINDOW', windowId: 1 })).error, /已关闭/);
  chrome.windows.get = get;
  chrome.windows.create = async () => { throw new Error('create denied'); };
  assert.match((await mock.message({ action: 'OPEN_STANDALONE_WINDOW', windowId: 1 })).error, /create denied/);
  chrome.windows.getLastFocused = async () => ({ id: 9, type: 'popup' });
  assert.equal((await mock.message({ action: 'OPEN_STANDALONE_WINDOW' })).success, false);
});

test('background settings message responds with resulting settings or actual error', async () => {
  const mock = await backgroundMock();
  const result = await mock.message({ action: 'UPDATE_SETTINGS', patch: { theme: 'dark' } });
  assert.equal(result.success, true);
  assert.equal(result.settings.theme, 'dark');
  const error = await mock.message({ action: 'UPDATE_AI_SETTINGS', patch: { model: 'missing target' } });
  assert.equal(error.success, false);
  assert.match(error.error, /provider/);
});

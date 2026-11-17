import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = async path => stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'));
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const cleanupURL = url(await source('../src/services/cleanup.ts'));
const protocolURL = url(await source('../src/services/chatgptSessionProtocol.ts'));
const providerURL = url(await source('../src/services/providerSettings.ts'));
const storeURL = url((await source('../src/services/settingsStore.ts')).replace("'./providerSettings'", JSON.stringify(providerURL)));
const api = await import(cleanupURL);
const backend = await import(url((await source('../src/background/cleanupBackground.ts'))
  .replace("'../services/cleanup'", JSON.stringify(cleanupURL)).replace("'../services/chatgptSessionProtocol'", JSON.stringify(protocolURL))
  .replace("'../services/settingsStore'", JSON.stringify(storeURL))));
const { DAY, HOUR, CLEANUP_CONFIG_KEY: CONFIG, CLEANUP_ARCHIVE_KEY: ARCHIVE, CLEANUP_SESSION_KEY: SESSION } = api;
const decisions = (tabs, action = 'archive', kind = 'temporary') => tabs.map(tab => ({ id: tab.id, action, kind, task: '检索资料', reason: '长期未使用的临时检索页' }));

function fixture({ tabs: input, decide, mode = 'ai', tier = 'conservative', currentWindowId = 1 } = {}) {
  let time = 30 * DAY;
  const local = {}, session = {};
  const sync = { sidetab_settings: { aiSettings: { provider: 'custom', apiEndpoint: 'http://127.0.0.1:1234/v1', model: 'fixture' } } };
  const calls = [];
  const tabs = new Map((input ?? [{ id: 1 }, { id: 2 }]).map(tab => [tab.id, { windowId: 1, groupId: -1, index: tab.id - 1, active: false,
    pinned: false, audible: false, incognito: false, status: 'complete', title: '搜索资料', url: `https://example.com/search/${tab.id}?token=private#secret`, lastAccessed: time - 10 * DAY, ...tab }]));
  const groups = new Map();
  let failArchive = false;
  let nextId = 100;
  let nextGroup = 50;
  const event = () => ({ addListener() {}, removeListener() {} });
  const storage = state => ({ async get(key, callback) { const result = { [key]: structuredClone(state[key]) }; callback?.(result); return result; }, async set(values) {
    if (state === local && failArchive && ARCHIVE in values) throw new Error('quota failure');
    Object.assign(state, structuredClone(values));
  } });
  globalThis.chrome = {
    runtime: { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, onMessage: event() },
    storage: { local: storage(local), session: storage(session), sync: storage(sync), onChanged: event() },
    alarms: { get: async () => ({}), create: async () => {}, clear: async () => {} },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('closed'); return structuredClone(tabs.get(id)); },
      async query(filter = {}) { return [...tabs.values()].filter(tab => (filter.windowId === undefined || tab.windowId === filter.windowId) &&
        (filter.active === undefined || tab.active === filter.active)).map(tab => structuredClone(tab)); },
      async remove(id) { assert(local[ARCHIVE].some(entry => entry.tabId === id), 'recovery record must be persisted before close'); calls.push(['close', id]); tabs.delete(id); },
      async create(value) { const tab = { id: nextId++, groupId: -1, index: tabs.size, ...value }; tabs.set(tab.id, tab); calls.push(['create', value]); return structuredClone(tab); },
      async update(id, value) { Object.assign(tabs.get(id), value); return structuredClone(tabs.get(id)); },
      async group({ tabIds, groupId, createProperties }) {
        const windowId = groupId === undefined ? createProperties?.windowId ?? currentWindowId : groups.get(groupId).windowId;
        assert(tabIds.every(id => tabs.get(id).windowId === windowId), 'group target must be the source window');
        const id = groupId ?? nextGroup++; for (const tabId of tabIds) tabs.get(tabId).groupId = id; groups.set(id, { id, windowId }); return id;
      },
    },
    tabGroups: { async query() { return [...groups.values()]; }, async get(id) { if (!groups.has(id)) throw Error('missing'); return groups.get(id); },
      async update(id, changes) { Object.assign(groups.get(id), changes); } },
    windows: { async get(id) { if (id !== 1) throw Error('closed'); return { id, type: 'normal' }; }, async create() { return { id: 1, type: 'normal' }; }, async update() {} },
  };
  local[CONFIG] = { ...api.DEFAULT_CLEANUP_CONFIG, enabled: true, tier, mode, revision: 'initial', notBefore: 0 };
  const decideCalls = [];
  const controller = backend.createCleanupController(async (...args) => {
    decideCalls.push(args);
    const result = decide ? await decide(...args) : decisions(args[0]);
    return api.validateCleanupDecisions({ decisions: result }, args[0], args[4]?.trim() ? undefined : args[2]);
  }, () => time);
  return { local, session, sync, tabs, groups, calls, decideCalls, controller, advance: duration => { time += duration; }, time: () => time,
    failArchive: () => { failArchive = true; } };
}
async function ready(options) {
  const f = fixture(options); await f.controller.initialize(); f.advance(11 * 60_000);
  f.session[SESSION].lastScanAt = f.time(); return f;
}

test('tiers have distinct age limits and conservative mode cannot archive reference pages', () => {
  const tabs = [{ id: 1 }];
  assert.equal(api.CLEANUP_TIERS.conservative.age, 7 * DAY);
  assert.equal(api.CLEANUP_TIERS.balanced.age, 3 * DAY);
  assert.equal(api.CLEANUP_TIERS.aggressive.age, DAY);
  assert.equal(api.validateCleanupDecisions({ decisions: decisions(tabs, 'archive', 'reference') }, tabs, 'conservative')[0].action, 'keep');
  assert.match(api.validateCleanupDecisions({ decisions: decisions(tabs, 'archive', 'reference') }, tabs, 'conservative')[0].reason, /保守策略/);
  assert.equal(api.validateCleanupDecisions({ decisions: decisions(tabs, 'uncertain', 'reference') }, tabs, 'conservative')[0].action, 'uncertain');
  assert.equal(api.validateCleanupDecisions({ decisions: decisions(tabs, 'archive', 'reference') }, tabs, 'balanced')[0].action, 'archive');
});

test('AI uses a common recent-use guard while time mode keeps its day thresholds', async () => {
  for (const tier of ['conservative', 'balanced', 'aggressive']) {
    for (const mode of ['ai', 'time']) {
      const f = await ready({ tier, mode, tabs: [{ id: 1, lastAccessed: 30 * DAY - 2 * HOUR }, { id: 2, lastAccessed: 30 * DAY }] });
      await f.controller.run();
      assert.deepEqual(f.calls, mode === 'ai' ? [['close', 1]] : []);
      if (mode === 'ai') assert(!f.decideCalls[0][1].some(tab => tab.id === 1), 'candidates cannot also be protected context IDs');
    }
  }
});

test('prompt edits reach inference, invalidate old decisions and apply a fresh execution buffer', async () => {
  const f = await ready();
  const plan = await f.controller.run(true);
  const prompt = '只归档闲置的设计资料';
  await f.controller.update({ prompt });
  assert.equal(f.local[CONFIG].notBefore, f.time() + DAY);
  await f.controller.execute(plan);
  assert.equal(f.calls.length, 0);
  await f.controller.run(true);
  assert.equal(f.decideCalls.at(-1)[4], prompt);
  await assert.rejects(f.controller.update({ prompt: 'a'.repeat(4001) }), /4000/);
});

test('upgrading day-gated AI cleanup grants a new buffer before widening candidates', async () => {
  const f = await ready();
  delete f.local[CONFIG].prompt;
  await f.controller.initialize();
  assert.equal(f.local[CONFIG].prompt, '');
  assert.equal(f.local[CONFIG].notBefore, f.time() + DAY);
  await f.controller.run();
  assert.equal(f.calls.length, 0);
});

test('model response boundary rejects missing, repeated, foreign IDs and invalid reasons', () => {
  const tabs = [{ id: 1 }, { id: 2 }];
  for (const value of [[], decisions([{ id: 1 }, { id: 1 }]), decisions([{ id: 1 }, { id: 3 }]),
    [{ ...decisions(tabs)[0], reason: '' }, decisions(tabs)[1]]]) {
    assert.throws(() => api.validateCleanupDecisions({ decisions: value }, tabs, 'balanced'));
  }
  const keyed = Object.fromEntries(decisions(tabs).map(({ id, ...decision }) => [id, decision]));
  assert.deepEqual(api.validateCleanupDecisions({ decisions: keyed }, tabs, 'balanced'), decisions(tabs));
  for (const value of [{ 1: keyed[1] }, { ...keyed, 3: keyed[2] }, { 1: keyed[1], '02': keyed[2] },
    { 1: keyed[1], 2: { ...keyed[2], action: 'close' } }]) {
    assert.throws(() => api.validateCleanupDecisions({ decisions: value }, tabs, 'balanced'));
  }
  assert.throws(() => api.validateCleanupDecisions({ decisions: { 1: keyed[1] } }, tabs), /1 项判断.*2 项/);
});

test('site protection respects domain boundaries and model URLs remove credentials/query/hash', () => {
  assert.equal(api.protectedSite('https://sub.example.com/page', ['example.com']), true);
  assert.equal(api.protectedSite('https://notexample.com/page', ['example.com']), false);
  assert.equal(api.normalizeProtectedSite('HTTPS://Docs.Example.com'), 'docs.example.com');
  for (const host of ['*.example.com', 'example.com/path', 'example.com?key=x', 'ftp://example.com']) assert.throws(() => api.normalizeProtectedSite(host));
  assert.equal(api.cleanupURL('https://name:pw@example.com/page?q=secret#private'), 'https://example.com/page');
});

test('preview never closes, actual run persists each recovery record before closing', async () => {
  const f = await ready();
  const plan = await f.controller.run(true);
  assert.equal(plan.decisions.length, 2); assert.equal(f.calls.length, 0);
  f.advance(HOUR); f.session[SESSION].lastScanAt = f.time();
  await f.controller.run();
  assert.deepEqual(f.calls, [['close', 1], ['close', 2]]);
  assert.equal(f.local[ARCHIVE].length, 2);
  assert(f.local[ARCHIVE].every(entry => entry.state === 'archived'));
});

test('preview accounts for every open page across windows, with explicit guard reasons and uncertainty', async () => {
  const f = await ready({ tabs: [{ id: 1, active: true }, { id: 2, pinned: true }, { id: 3, audible: true },
    { id: 4, status: 'loading' }, { id: 5, url: 'https://safe.example.com' }, { id: 6 }, { id: 7, groupId: 9 },
    { id: 8 }, { id: 9, url: 'chrome://settings/' }, { id: 10, lastAccessed: 30 * DAY }, { id: 11, incognito: true },
    { id: 12, windowId: 2 }, { id: 13 }, { id: 14, lastAccessed: undefined }],
    decide: tabs => tabs.map(tab => ({ ...decisions([tab])[0],
      action: tab.id === 12 ? 'uncertain' : tab.id === 13 ? 'keep' : 'archive',
      reason: tab.id === 12 ? '用途暂无法确认' : tab.id === 13 ? '仍在使用的资料' : '临时检索已结束' })) });
  f.groups.set(9, { id: 9, windowId: 1, title: 'protected' });
  f.local[CONFIG].protectedSites = ['safe.example.com'];
  await f.controller.protect('tab', 6, true); await f.controller.protect('group', 9, true);
  const plan = await f.controller.run(true);
  assert.deepEqual(plan.pages.map(page => page.id).sort((a, b) => a - b), [...f.tabs.keys()]);
  const byId = new Map(plan.pages.map(page => [page.id, page]));
  for (const [id, reason] of [[1, /当前选中/], [2, /已固定/], [3, /播放声音/], [4, /加载/], [5, /网站已受保护/],
    [6, /页面已受保护/], [7, /分组已受保护/], [9, /浏览器或本地/], [10, /不足 1 小时/], [11, /隐私窗口/], [14, /不足 1 小时/]]) {
    assert.equal(byId.get(id).action, 'keep'); assert.match(byId.get(id).reason, reason);
  }
  assert.equal(byId.get(8).action, 'archive'); assert.equal(byId.get(13).action, 'keep');
  assert.equal(byId.get(12).action, 'pending'); assert.equal(byId.get(12).windowId, 2);
  assert.equal(byId.get(12).reason, '用途暂无法确认');
  assert.deepEqual(plan.pages.reduce((counts, page) => ({ ...counts, [page.action]: counts[page.action] + 1 }), { archive: 0, keep: 0, pending: 0 }), { archive: 1, keep: 12, pending: 1 });
  const [candidates, context] = f.decideCalls[0];
  assert.deepEqual(candidates.map(tab => tab.id), [8, 12, 13]);
  assert(![...candidates, ...context].some(tab => [5, 6, 7, 9, 11].includes(tab.id)));
  assert.equal(f.calls.length, 0);
});

test('manual preview analyzes every eligible page in bounded batches; automatic cleanup retains its batch limit', async () => {
  const tabs = Array.from({ length: 85 }, (_, index) => ({ id: index + 1 }));
  const f = await ready({ tabs });
  const plan = await f.controller.run(true);
  assert.deepEqual(f.decideCalls.map(args => args[0].length), [40, 40, 5]);
  assert.equal(plan.pages.length, 85); assert.equal(plan.pages.filter(page => page.action === 'archive').length, 85);
  assert.equal(new Set(plan.pages.map(page => page.id)).size, 85); assert.equal(f.calls.length, 0);
  const automatic = await ready({ tabs });
  await automatic.controller.run();
  assert.equal(automatic.decideCalls.length, 1); assert.equal(automatic.decideCalls[0][0].length, 40);
  assert.equal(automatic.calls.length, 40);
  const nativeTabs = Array.from({ length: 8 }, (_, index) => ({ id: index + 1 }));
  const native = await ready({ tabs: nativeTabs });
  native.sync.sidetab_settings.aiSettings = { provider: 'codex_native' };
  const nativePlan = await native.controller.run(true);
  assert.deepEqual(native.decideCalls.map(args => args[0].length), [4, 4]);
  assert.equal(nativePlan.pages.filter(page => page.action === 'archive').length, 8);
  assert.equal(native.calls.length, 0, 'preview never closes pages');
  const nativeAutomatic = await ready({ tabs: nativeTabs });
  nativeAutomatic.sync.sidetab_settings.aiSettings = { provider: 'codex_native' };
  await nativeAutomatic.controller.run();
  assert.deepEqual(nativeAutomatic.decideCalls.map(args => args[0].length), [4]);
  assert.equal(nativeAutomatic.calls.length, 4);
});

test('all locally retained pages remain visible without a model request', async () => {
  const f = await ready({ tabs: [{ id: 1, pinned: true }, { id: 2, active: true }] });
  const plan = await f.controller.run(true);
  assert.equal(plan.pages.length, 2); assert(plan.pages.every(page => page.action === 'keep' && page.reason));
  assert.equal(plan.decisions.length, 0); assert.equal(f.decideCalls.length, 0); assert.equal(f.calls.length, 0);
});

test('active, pinned, audio, loading, protected sites, tab and group never become model candidates', async () => {
  const f = await ready({ tabs: [{ id: 1, active: true }, { id: 2, pinned: true }, { id: 3, audible: true, mutedInfo: { muted: true } },
    { id: 4, status: 'loading' }, { id: 5, url: 'https://safe.example.com' }, { id: 6 }, { id: 7, groupId: 9 }, { id: 8 }] });
  f.groups.set(9, { id: 9, windowId: 1, title: 'protected' });
  f.local[CONFIG].protectedSites = ['safe.example.com'];
  await f.controller.protect('tab', 6, true); await f.controller.protect('group', 9, true);
  await f.controller.run();
  assert.deepEqual(f.calls, [['close', 8]]);
  const [candidates, context] = f.decideCalls[0];
  assert(![...candidates, ...context].some(tab => [5, 6, 7].includes(tab.id)));
});

test('unknown activity starts now; waking after a gap applies a grace period', async () => {
  const f = await ready({ tabs: [{ id: 1, lastAccessed: undefined }] });
  await f.controller.run(); assert.equal(f.calls.length, 0);
  f.advance(10 * DAY); await f.controller.run(); assert.equal(f.calls.length, 0);
  assert(f.session[SESSION].resumeAfter > f.time());
});

test('failed recovery write cannot close a tab', async () => {
  const f = await ready(); f.failArchive();
  await f.controller.run(); assert.equal(f.calls.length, 0); assert.equal(f.tabs.size, 2);
});

test('model failures and malformed results keep tabs instead of falling back to time cleanup', async () => {
  for (const decide of [async () => { throw Error('model unavailable'); }, async () => decisions([{ id: 999 }])]) {
    const f = await ready({ decide }); await f.controller.run(); assert.equal(f.calls.length, 0);
  }
});

test('disabling or changing tier during inference invalidates the complete result', async () => {
  for (const patch of [{ enabled: false }, { tier: 'aggressive' }]) {
    let finish, started;
    const inferenceStarted = new Promise(resolve => { started = resolve; });
    const f = await ready({ decide: candidates => new Promise(resolve => { finish = () => resolve(decisions(candidates)); started(); }) });
    const running = f.controller.run(); await inferenceStarted;
    await f.controller.update(patch); finish(); await running; assert.equal(f.calls.length, 0);
  }
});

test('visiting a tab and switching away during inference invalidates the old result', async () => {
  let finish, started;
  const inferenceStarted = new Promise(resolve => { started = resolve; });
  const f = await ready({ decide: candidates => new Promise(resolve => { finish = () => resolve(decisions(candidates)); started(); }) });
  const running = f.controller.run(); await inferenceStarted;
  await f.controller.touch(1); finish(); await running; assert.equal(f.calls.length, 0);
});

test('preview survives visiting and opening pages during inference, refreshing guards and marking stale context pending', async () => {
  let finish, started, requests = 0;
  const inferenceStarted = new Promise(resolve => { started = resolve; });
  const f = await ready({ decide: candidates => ++requests === 1 ? new Promise(resolve => { finish = () => resolve(decisions(candidates)); started(); }) : decisions(candidates) });
  const running = f.controller.run(true); await inferenceStarted;
  await f.controller.touch(1);
  f.tabs.set(3, { ...f.tabs.get(2), id: 3, title: '刚打开的页面', lastAccessed: f.time() });
  await f.controller.touch(3);
  finish(); const plan = await running;
  assert.equal(plan.pages.length, 3);
  const byId = new Map(plan.pages.map(page => [page.id, page]));
  assert.equal(byId.get(1).action, 'keep'); assert.match(byId.get(1).reason, /不足 1 小时/);
  assert.equal(byId.get(3).action, 'keep'); assert.match(byId.get(3).reason, /不足 1 小时/);
  assert.equal(byId.get(2).action, 'pending'); assert.match(byId.get(2).reason, /活跃页面已变化/);
  assert.equal(f.calls.length, 0);
  await f.controller.execute(plan); assert.equal(f.calls.length, 0);
  await f.controller.run(true); assert.equal(f.decideCalls.length, 2, 'changed context must not reuse old decisions');
});

test('unrelated browser events do not discard a preview or classify closed pages', async () => {
  let finish, started, requests = 0;
  const inferenceStarted = new Promise(resolve => { started = resolve; });
  const f = await ready({ decide: candidates => ++requests === 1 ? new Promise(resolve => { finish = () => resolve(decisions(candidates)); started(); }) : decisions(candidates) });
  const running = f.controller.run(true); await inferenceStarted;
  f.controller.invalidate(); f.tabs.delete(2);
  finish(); const plan = await running;
  assert.equal(plan.pages.length, 1); assert.equal(plan.pages[0].id, 1); assert.equal(plan.pages[0].action, 'archive');
  assert.equal(f.calls.length, 0);
  await f.controller.run(true); assert.equal(f.decideCalls.length, 1, 'unrelated events must not force another model call');
});

test('slow inference publishes all pages first and repeat previews reuse only matching model inputs', async () => {
  let finish, started, requests = 0;
  const inferenceStarted = new Promise(resolve => { started = resolve; });
  const f = await ready({ tabs: [{ id: 1 }, { id: 2 }, { id: 3, pinned: true }, { id: 4, active: true }],
    decide: candidates => ++requests === 1 ? new Promise(resolve => { finish = () => resolve(decisions(candidates)); started(); }) : decisions(candidates) });
  const running = f.controller.run(true, 'first'); await inferenceStarted;
  const preview = (await f.controller.view()).preview;
  assert.equal(preview.id, 'first'); assert.equal(preview.pages.length, 4);
  assert.equal(preview.pages.filter(page => page.action === 'pending').length, 2);
  assert.equal(preview.pages.find(page => page.id === 3).reason, '已固定'); assert.equal(f.calls.length, 0);
  finish(); await running;
  await f.controller.run(true, 'second');
  assert.equal(f.decideCalls.length, 1);
  assert.equal((await f.controller.view()).preview.id, 'second');
  assert.equal((await f.controller.view()).preview.pages.filter(page => page.action === 'archive').length, 2);
  f.tabs.get(4).url = 'https://changed.example.org/editor';
  await f.controller.run(true, 'third'); assert.equal(f.decideCalls.length, 2, 'a changed context URL must invalidate cached decisions');
});

test('a slow inference caches its original input age rather than the age when it finishes', async () => {
  let f, requests = 0;
  f = await ready({ decide: candidates => { if (++requests === 1) f.advance(HOUR); return decisions(candidates); } });
  const first = await f.controller.run(true);
  assert(first.pages.every(page => page.action === 'pending'));
  await f.controller.run(true); assert.equal(f.decideCalls.length, 2);
  assert.equal(f.calls.length, 0);
});

test('final live check prevents closing a pinned, moved or navigated candidate', async () => {
  for (const patch of [{ pinned: true }, { windowId: 2 }, { url: 'https://changed.example.com' }, { active: true }]) {
    const f = await ready({ decide: async candidates => { Object.assign(f.tabs.get(1), patch); return decisions(candidates); } });
    await f.controller.run(); assert(!f.calls.some(call => call[1] === 1));
  }
});

test('fresh setup waits 24 hours before first automatic execution and schedule is independent from preview', async () => {
  const f = await ready(); f.local[CONFIG].enabled = false;
  await f.controller.update({ enabled: true });
  assert.equal(f.local[CONFIG].notBefore, f.time() + DAY);
  await f.controller.run(); assert.equal(f.calls.length, 0);
  assert.equal((await f.controller.run(true)).decisions.length, 2);
});

test('restore succeeds before removing records, restores groups and protects reopened tabs', async () => {
  const f = await ready({ tabs: [{ id: 1, groupId: 9 }, { id: 2, groupId: 9 }] });
  f.groups.set(9, { id: 9, windowId: 1, title: '研发资料', color: 'blue', collapsed: true });
  await f.controller.run();
  const ids = f.local[ARCHIVE].map(entry => entry.id);
  await f.controller.restore(ids, 1);
  assert.equal(f.local[ARCHIVE].length, 0);
  const created = [...f.tabs.values()]; assert.equal(created.length, 2);
  assert.equal(created[0].groupId, created[1].groupId);
  assert.equal(f.session[SESSION].protectedTabIds.length, 2);
});

test('failed restore keeps records and missing source window is explicit', async () => {
  const f = await ready(); await f.controller.run();
  const ids = f.local[ARCHIVE].map(entry => entry.id);
  await assert.rejects(f.controller.restore(ids, 99), /新窗口/);
  chrome.tabs.create = async () => { throw Error('creation failed'); };
  await assert.rejects(f.controller.restore(ids, 1), /记录已保留/);
  assert.equal(f.local[ARCHIVE].length, 2);
});

test('restore recreates an empty group in its source window while a detached view is current', async () => {
  const f = await ready({ currentWindowId: 2, tabs: [{ id: 1, groupId: 7 }, { id: 2, groupId: 7 }] });
  f.groups.set(7, { id: 7, windowId: 1, title: 'Source group', color: 'blue' });
  await f.controller.run(); f.groups.clear();
  await f.controller.restore(f.local[ARCHIVE].map(entry => entry.id), 1);
  const tabs = [...f.tabs.values()];
  assert.equal(tabs.length, 2);
  assert(tabs.every(tab => tab.windowId === 1 && tab.groupId >= 0));
  assert.equal(tabs[0].groupId, tabs[1].groupId);
  assert.equal(f.groups.get(tabs[0].groupId).windowId, 1);
  assert.equal(f.local[ARCHIVE].length, 0);
});

test('restart reconciles saved-but-not-closed records and preserves closed recovery records', async () => {
  const f = await ready(); await f.controller.run();
  f.local[ARCHIVE].forEach(entry => { entry.state = 'pending'; });
  const second = backend.createCleanupController(async tabs => decisions(tabs), f.time);
  await second.initialize();
  assert.equal(f.local[ARCHIVE].length, 2);
  assert(f.local[ARCHIVE].every(entry => entry.state === 'archived'));
});

test('time mode requires no model and pending duplicate records prevent repeated closing', async () => {
  const f = await ready({ mode: 'time' });
  await f.controller.run(); assert.equal(f.decideCalls.length, 0); assert.equal(f.calls.length, 2);
});

test('upgrade removes the legacy cleanup model/key copy without changing shared configuration or enabled state', async () => {
  const f = await ready();
  f.local[CONFIG].model = { provider: 'openai', apiKey: 'obsolete-key' };
  await f.controller.initialize();
  assert(!Object.hasOwn(f.local[CONFIG], 'model'));
  assert.equal(f.local[CONFIG].enabled, true);
  assert.equal(f.sync.sidetab_settings.aiSettings.provider, 'custom');
});

test('cleanup reads the shared model and invalidates cached decisions when shared credentials change', async () => {
  const f = await ready({ decide: async tabs => decisions(tabs, 'keep') });
  await f.controller.run();
  assert.equal(f.decideCalls[0][3].model, 'fixture');
  f.sync.sidetab_settings.aiSettings.model = 'updated-model';
  f.sync.sidetab_settings.aiSettings.apiKey = 'updated-key';
  await f.controller.run();
  assert.equal(f.decideCalls.length, 2);
  assert.equal(f.decideCalls[1][3].model, 'updated-model');
  assert.equal(f.decideCalls[1][3].apiKey, 'updated-key');
  assert(!JSON.stringify(f.session).includes('updated-key'));
  assert(!Object.hasOwn(f.local[CONFIG], 'model'));
});

test('changing the shared model during inference cannot apply an old cleanup decision', async () => {
  let finish, started;
  const inferenceStarted = new Promise(resolve => { started = resolve; });
  const f = await ready({ decide: tabs => new Promise(resolve => { finish = () => resolve(decisions(tabs)); started(); }) });
  const running = f.controller.run(); await inferenceStarted;
  f.sync.sidetab_settings.aiSettings.model = 'changed-during-inference';
  finish(); await running;
  assert.equal(f.calls.length, 0);
});

test('changing shared models after preview prevents executing that preview', async () => {
  const f = await ready();
  const plan = await f.controller.run(true);
  f.sync.sidetab_settings.aiSettings.model = 'new-shared-model';
  await f.controller.execute(plan);
  assert.equal(f.calls.length, 0);
});

test('an unsupported shared engine keeps tabs and requires explicit time mode', async () => {
  const f = await ready();
  f.sync.sidetab_settings.aiSettings = { provider: 'heuristic' };
  await f.controller.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.decideCalls.length, 0);
  await f.controller.update({ enabled: false });
  await assert.rejects(f.controller.update({ enabled: true }), /AI 引擎/);
  await f.controller.update({ enabled: true, mode: 'time' });
  f.advance(25 * HOUR);
  await f.controller.run(); // A long gap gets the existing wake-up grace period.
  f.advance(11 * 60_000);
  await f.controller.run();
  assert.equal(f.calls.length, 2);
});

test('single restore focuses an existing exact URL without opening another tab', async () => {
  const f = await ready({ tabs: [{ id: 1 }] }); await f.controller.run();
  const entry = f.local[ARCHIVE][0];
  f.tabs.set(90, { id: 90, windowId: 1, groupId: -1, url: entry.url });
  await f.controller.restore([entry.id], 1);
  assert.equal(f.tabs.size, 1); assert.equal(f.tabs.get(90).active, true); assert.equal(f.local[ARCHIVE].length, 0);
});

test('explicitly allowing a restored tab removes its cleanup exemption after it becomes idle again', async () => {
  const f = await ready({ tabs: [{ id: 1 }] }); await f.controller.run();
  await f.controller.restore(f.local[ARCHIVE].map(entry => entry.id), 1);
  const restored = [...f.tabs.values()][0]; restored.active = false;
  await f.controller.protect('tab', restored.id, false);
  f.advance(8 * DAY); f.session[SESSION].lastScanAt = f.time(); f.session[SESSION].resumeAfter = 0;
  await f.controller.run();
  assert(f.calls.some(call => call[0] === 'close' && call[1] === restored.id));
});

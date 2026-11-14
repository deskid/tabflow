import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const builtin = await readFile(new URL('../src/services/builtinModel.ts', import.meta.url), 'utf8');
const builtinURL = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(builtin)).toString('base64')}`;
const source = await readFile(new URL('../src/services/aiGrouper.ts', import.meta.url), 'utf8');
const api = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source).replace("'./builtinModel'", JSON.stringify(builtinURL))).toString('base64')}`);

function browser(layout, metadata = []) {
  let tabs = layout.map(([id, groupId = -1, windowId = 1]) => ({ id, groupId, windowId }));
  const groups = new Map(metadata.map((group) => [group.id, { windowId: 1, title: '', color: 'grey', collapsed: false, ...group }]));
  const calls = [];
  let nextId = 100;
  let fail;
  const refresh = () => {
    for (const windowId of new Set(tabs.map((tab) => tab.windowId))) {
      tabs.filter((tab) => tab.windowId === windowId).forEach((tab, index) => { tab.index = index; });
    }
    for (const id of groups.keys()) if (!tabs.some((tab) => tab.groupId === id)) groups.delete(id);
  };
  const check = (operation) => {
    calls.push(operation);
    if (fail === operation) { fail = undefined; throw Error(`mock ${operation} failed`); }
  };
  const move = (ids, index, windowId) => {
    const selected = ids.map((id) => tabs.find((tab) => tab.id === id));
    assert.ok(selected.every(Boolean), 'closed tabs cannot be moved');
    windowId ??= selected[0].windowId;
    assert.ok(selected.every((tab) => tab.windowId === windowId), 'undo must not cross windows');
    tabs = tabs.filter((tab) => !ids.includes(tab.id));
    const windowTabs = tabs.filter((tab) => tab.windowId === windowId);
    const anchor = windowTabs[Math.min(index, windowTabs.length)];
    const insertion = anchor ? tabs.indexOf(anchor) : tabs.length;
    tabs.splice(insertion, 0, ...selected);
    refresh();
  };
  refresh();
  globalThis.chrome = {
    tabs: {
      async query(query) { check('queryTabs'); return tabs.filter((tab) => (query.groupId === undefined || tab.groupId === query.groupId) && (query.windowId === undefined || tab.windowId === query.windowId)).map((tab) => ({ ...tab })); },
      async group({ tabIds, groupId, createProperties }) {
        check('group');
        const selected = tabIds.map((id) => tabs.find((tab) => tab.id === id));
        assert.ok(selected.every(Boolean));
        const windowId = createProperties?.windowId ?? selected[0].windowId;
        assert.ok(selected.every((tab) => tab.windowId === windowId));
        if (groupId === undefined) {
          groupId = nextId++;
          groups.set(groupId, { id: groupId, windowId, title: '', color: 'grey', collapsed: false });
        } else assert.equal(groups.get(groupId)?.windowId, windowId);
        const existing = tabs.filter((tab) => tab.groupId === groupId && !tabIds.includes(tab.id));
        const index = existing.length ? existing.at(-1).index + 1 : selected[0].index;
        selected.forEach((tab) => { tab.groupId = groupId; });
        move(tabIds, index);
        return groupId;
      },
      async ungroup(ids) { check('ungroup'); for (const id of [].concat(ids)) { const tab = tabs.find((tab) => tab.id === id); assert.ok(tab); tab.groupId = -1; } refresh(); },
      async move(id, { index }) { check('moveTab'); move([id], index); },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query() { check('queryGroups'); return [...groups.values()].map((group) => ({ ...group })); },
      async update(id, details) { check('update'); assert.ok(groups.has(id)); Object.assign(groups.get(id), details); },
      async move(id, { index }) { check('moveGroup'); move(tabs.filter((tab) => tab.groupId === id).map((tab) => tab.id), index); },
    },
  };
  return {
    calls, groups,
    get tabs() { return tabs; },
    input: () => tabs.map((tab) => ({ id: tab.id, groupId: 999, title: '', url: '' })),
    failOnce(operation) { fail = operation; },
    close(id) { tabs = tabs.filter((tab) => tab.id !== id); refresh(); },
    crossWindow(id) { tabs.find((tab) => tab.id === id).windowId = 2; refresh(); },
    add(id, groupId = -1) { tabs.push({ id, groupId, windowId: 1 }); refresh(); },
    order: () => tabs.filter((tab) => tab.windowId === 1).map((tab) => tab.id),
  };
}
const plan = (...tabIds) => [{ name: '新组', color: 'red', tabIds }];
const oldGroup = { id: 10, title: '原组', color: 'cyan', collapsed: true };

test('recreates an emptied group and restores its title, color, collapse and order from Chrome', async () => {
  const mock = browser([[1], [2, 10], [3, 10], [4], [5]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(3, 1, 2, 4), mock.input());
  assert.equal(mock.groups.has(10), false);
  assert.deepEqual(undo.originalGroups[0].members, [{ tabId: 2, index: 1 }, { tabId: 3, index: 2 }]);
  await api.undoTabGrouping(undo);
  assert.deepEqual(mock.order(), [1, 2, 3, 4, 5]);
  const id = undo.restoredGroupIds[10];
  assert.deepEqual(mock.groups.get(id), { ...oldGroup, id, windowId: 1 });
  assert.deepEqual(mock.tabs.map((tab) => tab.groupId), [-1, id, id, -1, -1]);
});

test('restores originally ungrouped tabs to their actual indices', async () => {
  const mock = browser([[1], [2], [3], [4], [5]]);
  const undo = await api.executeTabGrouping(plan(5, 2, 4), mock.input());
  await api.undoTabGrouping(undo);
  assert.deepEqual(mock.order(), [1, 2, 3, 4, 5]);
  assert.ok(mock.tabs.every((tab) => tab.groupId === -1));
});

test('reuses a mixed original group and retains untouched and newly added members and tabs', async () => {
  const mock = browser([[1], [2, 10], [3, 10], [4, 10], [5]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(4, 2, 5), mock.input());
  mock.add(90, 10);
  mock.add(91, undo.createdGroupIds[0]);
  mock.add(92);
  await api.undoTabGrouping(undo);
  assert.equal(undo.restoredGroupIds[10], 10);
  assert.deepEqual(mock.tabs.filter((tab) => tab.groupId === 10).map((tab) => tab.id), [2, 3, 4, 90]);
  assert.equal(mock.tabs.find((tab) => tab.id === 91).groupId, undo.createdGroupIds[0]);
  assert.ok(mock.tabs.some((tab) => tab.id === 92));
});

test('does not reopen closed tabs or return tabs moved to another window', async () => {
  const mock = browser([[1, 10], [2, 10], [3], [4]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(1, 2, 3, 4), mock.input());
  mock.close(1);
  mock.crossWindow(2);
  mock.crossWindow(4);
  await api.undoTabGrouping(undo);
  assert.equal(mock.tabs.some((tab) => tab.id === 1), false);
  assert.equal(mock.tabs.find((tab) => tab.id === 2).windowId, 2);
  assert.equal(mock.tabs.find((tab) => tab.id === 4).windowId, 2);
  assert.equal(mock.tabs.find((tab) => tab.id === 3).groupId, -1);
  assert.equal(undo.restoredGroupIds[10], undefined);
});

test('failed restoration throws a Chinese summary and retry reuses the recreated group', async () => {
  const mock = browser([[1, 10], [2, 10], [3]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(2, 3, 1), mock.input());
  mock.failOnce('update');
  await assert.rejects(api.undoTabGrouping(undo), /撤销分组失败.*请重试.*mock update failed/);
  const id = undo.restoredGroupIds[10];
  assert.ok(mock.groups.has(id));
  const count = mock.groups.size;
  await api.undoTabGrouping(undo);
  assert.equal(undo.restoredGroupIds[10], id);
  assert.equal(mock.groups.size, count);
  assert.deepEqual(mock.order(), [1, 2, 3]);
  assert.equal(mock.groups.get(id).collapsed, true);
  await api.undoTabGrouping(undo);
  assert.equal(undo.restoredGroupIds[10], id);
  assert.deepEqual(mock.order(), [1, 2, 3]);
});

test('records a recreated group before order failure and retries without duplicate creation', async () => {
  const mock = browser([[1, 10], [2, 10], [3]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(3, 2, 1), mock.input());
  mock.failOnce('moveTab');
  await assert.rejects(api.undoTabGrouping(undo), /撤销分组失败.*顺序/);
  const id = undo.restoredGroupIds[10];
  assert.ok(mock.groups.has(id));
  await api.undoTabGrouping(undo);
  assert.equal(undo.restoredGroupIds[10], id);
  assert.deepEqual(mock.order(), [1, 2, 3]);
});

test('closed surrounding tabs do not make original positions impossible to restore', async () => {
  const mock = browser([[1], [2], [3], [4, 10], [5, 10], [6]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(6, 5, 4), mock.input());
  mock.close(1);
  mock.close(2);
  mock.close(3);
  await api.undoTabGrouping(undo);
  assert.deepEqual(mock.order(), [4, 5, 6]);
});

test('position failure and read failure remain visible and can be retried', async () => {
  const mock = browser([[1], [2], [3]]);
  const undo = await api.executeTabGrouping(plan(3, 1), mock.input());
  mock.failOnce('moveTab');
  await assert.rejects(api.undoTabGrouping(undo), /撤销分组失败.*恢复标签位置/);
  mock.failOnce('queryTabs');
  await assert.rejects(api.undoTabGrouping(undo), /撤销分组失败/);
  await api.undoTabGrouping(undo);
  assert.deepEqual(mock.order(), [1, 2, 3]);
});

test('partial execution records group creation before metadata failure so undo still restores it', async () => {
  const mock = browser([[1, 10], [2, 10], [3], [4]], [oldGroup]);
  mock.failOnce('update');
  const warn = console.warn;
  let undo;
  try {
    console.warn = () => {};
    undo = await api.executeTabGrouping([...plan(2, 1), ...plan(4, 3)], mock.input());
  } finally { console.warn = warn; }
  assert.equal(undo.createdGroupIds.length, 2);
  assert.deepEqual(undo.affectedTabIds, [2, 1, 4, 3]);
  await api.undoTabGrouping(undo);
  assert.deepEqual(mock.order(), [1, 2, 3, 4]);
  assert.equal(mock.groups.get(undo.restoredGroupIds[10]).title, oldGroup.title);
});

test('restores multiple original group blocks and ungrouped positions across proposal permutations', async () => {
  const permutations = (items) => items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest])) : [[]];
  for (const ids of permutations([1, 2, 4, 5])) {
    const mock = browser([[1], [2, 10], [3, 10], [4, 20], [5, 20], [6]], [oldGroup, { id: 20, title: '第二组', color: 'orange', collapsed: false }]);
    const undo = await api.executeTabGrouping(plan(...ids), mock.input());
    await api.undoTabGrouping(undo);
    assert.deepEqual(mock.order(), [1, 2, 3, 4, 5, 6], `proposal: ${ids}`);
    assert.equal(mock.groups.get(undo.restoredGroupIds[20]).color, 'orange');
  }
});

test('undo leaves input tabs excluded from the executed proposal untouched', async () => {
  const mock = browser([[1], [2], [3], [4]]);
  const undo = await api.executeTabGrouping(plan(2, 1), mock.input());
  // A later user action involving a different input tab must survive undo.
  const userGroup = await chrome.tabs.group({ tabIds: [3, 4] });
  await api.undoTabGrouping(undo);
  assert.equal(mock.tabs.find((tab) => tab.id === 3).groupId, userGroup);
  assert.equal(mock.tabs.find((tab) => tab.id === 4).groupId, userGroup);
});


test('undo preserves a tab pinned after grouping and restores groups after the pinned prefix', async () => {
  const mock = browser([[1, 10], [2, 10], [3]], [oldGroup]);
  const undo = await api.executeTabGrouping(plan(3, 2, 1), mock.input());
  const pinned = mock.tabs.find((tab) => tab.id === 1);
  pinned.pinned = true;
  pinned.groupId = -1;
  await chrome.tabs.move(1, { index: 0 });
  await api.undoTabGrouping(undo);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.groupId, -1);
  assert.equal(mock.order()[0], 1);
  assert.equal(mock.tabs.find((tab) => tab.id === 2).groupId, undo.restoredGroupIds[10]);
});

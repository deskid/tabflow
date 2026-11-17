import {
  CLEANUP_CONFIG_KEY, CLEANUP_ARCHIVE_KEY, CLEANUP_SESSION_KEY, CLEANUP_STATUS_KEY,
  DEFAULT_CLEANUP_CONFIG, CLEANUP_TIERS, DAY, HOUR, normalizeProtectedSite, protectedSite, supportedCleanupProvider,
} from '../services/cleanup';
import type { ArchiveEntry, CleanupCandidate, CleanupConfig, CleanupDecision, CleanupPlan, CleanupPreviewPage, CleanupStatus, CleanupView } from '../services/cleanup';
import type { AISettings } from '../services/aiGrouper';
import { trustedSender, UI_PATHS } from '../services/chatgptSessionProtocol';
import { readSettings, SETTINGS_KEY } from '../services/settingsStore';

const ALARM = 'tabflow-cleanup';
interface Activity { url: string; windowId: number; groupId: number; lastUsed: number; visits: number }
interface CleanupSession {
  id: string; tabs: Record<string, Activity>; protectedTabIds: number[]; protectedGroupIds: number[];
  restoreTabIds: number[]; restoreURLs: string[]; resumeAfter: number; lastScanAt: number; lastEvaluationAt: number;
  lastModelKey?: string;
  cache: Record<string, { key: string; at: number; decision: CleanupDecision }>;
  preview?: { id: string; pages: CleanupPreviewPage[] };
}
type Decide = (candidates: CleanupCandidate[], context: CleanupCandidate[], tier: CleanupConfig['tier'], model: AISettings, prompt: string) => Promise<CleanupDecision[]>;

/** One owner for local/session mutations; model inference deliberately runs outside this queue. */
export function createCleanupController(decide: Decide, now = () => Date.now()) {
  const readModel = async () => (await readSettings()).aiSettings;
  let tail: Promise<unknown> = Promise.resolve();
  let flight: Promise<CleanupPlan | undefined> | undefined;
  let activityRevision = 0;
  const queue = <T,>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task); tail = result.catch(() => {}); return result;
  };
  async function config(): Promise<CleanupConfig> {
    const stored = { ...(await chrome.storage.local.get(CLEANUP_CONFIG_KEY))[CLEANUP_CONFIG_KEY] as Partial<CleanupConfig> & { model?: unknown } };
    delete stored.model;
    return { ...DEFAULT_CLEANUP_CONFIG, ...stored };
  }
  async function modelKey(model: AISettings): Promise<string> {
    // Cache identity includes credentials without keeping another credential copy in session storage.
    const bytes = new TextEncoder().encode(JSON.stringify([model.provider, model.model ?? '', model.apiEndpoint ?? '', model.apiKey ?? '']));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function session(): Promise<CleanupSession> {
    const stored = (await chrome.storage.session.get(CLEANUP_SESSION_KEY))[CLEANUP_SESSION_KEY] as CleanupSession | undefined;
    if (stored) return stored;
    const created: CleanupSession = { id: crypto.randomUUID(), tabs: {}, protectedTabIds: [], protectedGroupIds: [],
      restoreTabIds: [], restoreURLs: [], resumeAfter: now() + 10 * 60_000, lastScanAt: now(), lastEvaluationAt: 0, cache: {} };
    await saveSession(created); return created;
  }
  const saveSession = (value: CleanupSession) => chrome.storage.session.set({ [CLEANUP_SESSION_KEY]: value });
  const archive = async (): Promise<ArchiveEntry[]> => (await chrome.storage.local.get(CLEANUP_ARCHIVE_KEY))[CLEANUP_ARCHIVE_KEY] as ArchiveEntry[] | undefined ?? [];
  async function saveArchive(entries: ArchiveEntry[]) {
    if (entries.length > 5000 || new TextEncoder().encode(JSON.stringify(entries)).length > 6 * 1024 * 1024) {
      throw new Error('归档容量不足，自动清理已停止本轮。请先导出并删除部分记录。');
    }
    await chrome.storage.local.set({ [CLEANUP_ARCHIVE_KEY]: entries });
  }
  const status = (value: CleanupStatus) => chrome.storage.local.set({ [CLEANUP_STATUS_KEY]: value });
  function retentionReason(tab: chrome.tabs.Tab, settings: CleanupConfig, state: CleanupSession, time: number): string | undefined {
    const activity = state.tabs[String(tab.id)];
    if (tab.id === undefined) return '无法识别此页面';
    if (tab.incognito) return '隐私窗口，不参与自动清理';
    if (!/^https?:\/\//.test(tab.url ?? '')) return '浏览器或本地页面，不自动清理';
    if (protectedSite(tab.url!, settings.protectedSites)) return '网站已受保护';
    if (state.protectedTabIds.includes(tab.id)) return '此页面已受保护';
    if (state.protectedGroupIds.includes(tab.groupId)) return '所在分组已受保护';
    if (tab.pinned) return '已固定';
    if (tab.active) return '当前选中的页面';
    if (tab.audible) return '正在播放声音';
    if (tab.status === 'loading') return '页面仍在加载';
    if (state.restoreURLs.includes(tab.url!)) return '页面正在恢复';
    if (!activity || activity.url !== tab.url || activity.windowId !== tab.windowId) return '使用记录不足，暂时保留';
    if (time - activity.lastUsed < (settings.mode === 'ai' ? HOUR : CLEANUP_TIERS[settings.tier].age)) {
      return settings.mode === 'ai' ? '闲置记录不足 1 小时' : `未满足 ${CLEANUP_TIERS[settings.tier].age / DAY} 天闲置条件`;
    }
  }
  const allowed = (tab: chrome.tabs.Tab, settings: CleanupConfig, state: CleanupSession, time: number) => retentionReason(tab, settings, state, time) === undefined;
  async function collect() {
    const settings = await config();
    const model = settings.mode === 'ai' ? await readModel() : undefined;
    const sharedModelKey = model ? await modelKey(model) : '';
    const state = await session();
    const time = now();
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const groups = await chrome.tabGroups.query({});
    const ids = new Set(tabs.map(tab => tab.id));
    for (const id of Object.keys(state.tabs)) if (!ids.has(Number(id))) { delete state.tabs[id]; delete state.cache[id]; }
    state.protectedTabIds = state.protectedTabIds.filter(id => ids.has(id));
    state.protectedGroupIds = state.protectedGroupIds.filter(id => groups.some(group => group.id === id));
    if (time - state.lastScanAt > 15 * 60_000) state.resumeAfter = time + 10 * 60_000;
    state.lastScanAt = time;
    for (const tab of tabs) {
      if (tab.id === undefined || tab.incognito || !/^https?:\/\//.test(tab.url ?? '')) continue;
      const previous = state.tabs[tab.id];
      if (!previous || previous.url !== tab.url || previous.windowId !== tab.windowId) {
        const accessed = tab.lastAccessed;
        state.tabs[tab.id] = { url: tab.url!, windowId: tab.windowId, groupId: tab.groupId,
          lastUsed: previous || !accessed || accessed > time ? time : accessed, visits: 0 };
      }
      state.tabs[tab.id].groupId = tab.groupId;
      if (tab.active) state.tabs[tab.id].lastUsed = time;
    }
    await saveSession(state);
    const candidate = (tab: chrome.tabs.Tab): CleanupCandidate => ({ id: tab.id!, title: tab.title ?? '', url: tab.url!,
      windowId: tab.windowId, groupId: tab.groupId, groupTitle: groups.find(group => group.id === tab.groupId)?.title ?? '',
      lastUsed: state.tabs[tab.id!].lastUsed, visits: state.tabs[tab.id!].visits });
    const candidates = tabs.filter(tab => allowed(tab, settings, state, time)).map(candidate);
    const candidateIds = new Set(candidates.map(tab => tab.id));
    // Protected sites are never sent to the model, even as task context.
    const context = tabs.filter(tab => tab.id !== undefined && !candidateIds.has(tab.id) && state.tabs[tab.id] && !tab.incognito &&
      !protectedSite(tab.url ?? '', settings.protectedSites) && !state.protectedTabIds.includes(tab.id) &&
      !state.protectedGroupIds.includes(tab.groupId) && (tab.active || time - state.tabs[tab.id].lastUsed < DAY)).slice(0, 20).map(candidate);
    return { settings, state, candidates, context, model, sharedModelKey, tabs, time };
  }
  async function evaluate(manual: boolean, previewId: string): Promise<CleanupPlan | undefined> {
    const snapshot = await queue(collect);
    const revision = activityRevision;
    const { settings, state, context, model, sharedModelKey } = snapshot;
    if (!manual && (!settings.enabled || now() < Math.max(settings.notBefore, settings.pausedUntil, state.resumeAfter))) return;
    if (!manual && settings.mode === 'ai' && state.lastModelKey === sharedModelKey && now() - state.lastEvaluationAt < HOUR) return;
    const contextIdentity = (tabs: CleanupCandidate[], time: number) => JSON.stringify(tabs.map(tab => [tab.id, tab.title, tab.url, tab.groupId, tab.groupTitle, Math.floor((time - tab.lastUsed) / HOUR), tab.visits]));
    const contextKey = contextIdentity(context, snapshot.time);
    const key = (tab: CleanupCandidate, time = snapshot.time) => JSON.stringify([settings.revision, sharedModelKey, tab.url, tab.title, tab.lastUsed, tab.visits,
      tab.windowId, tab.groupId, tab.groupTitle, Math.floor((time - tab.lastUsed) / HOUR), contextKey]);
    const sorted = snapshot.candidates.sort((a, b) => (state.cache[a.id]?.at ?? 0) - (state.cache[b.id]?.at ?? 0));
    const candidates = manual ? sorted : sorted.slice(0, 40);
    const pages = async (decisions: CleanupDecision[]): Promise<CleanupPreviewPage[]> => {
      if (!manual) return [];
      const latest = await queue(collect);
      const byId = new Map(decisions.map(item => [item.id, item]));
      const originals = new Map(candidates.map(tab => [tab.id, tab]));
      const current = new Map(latest.candidates.map(tab => [tab.id, tab]));
      const settingsChanged = latest.settings.revision !== settings.revision || latest.sharedModelKey !== sharedModelKey;
      const contextChanged = settings.mode === 'ai' && contextKey !== contextIdentity(latest.context, latest.time);
      return latest.tabs.filter(tab => tab.id !== undefined).map(tab => {
        const rule = retentionReason(tab, latest.settings, latest.state, latest.time);
        const decision = byId.get(tab.id!);
        const original = originals.get(tab.id!);
        const candidate = current.get(tab.id!);
        const changed = !original || !candidate || key(original) !== key(candidate, latest.time);
        const stale = settingsChanged ? '清理设置已变化，请重新分析' : contextChanged ? '活跃页面已变化，需重新判断' : changed ? '此页面已变化，需重新判断' : '';
        return { id: tab.id!, title: tab.title || tab.url || '未命名页面', url: tab.url || '', windowId: tab.windowId,
          action: rule ? 'keep' : stale || !decision || decision.action === 'uncertain' ? 'pending' : decision.action,
          reason: rule || stale || decision?.reason || '尚未完成 AI 判断' };
      });
    };
    const publish = async (decisions: CleanupDecision[]) => {
      if (!manual) return;
      const report = await pages(decisions);
      await queue(async () => { const current = await session(); current.preview = { id: previewId, pages: report }; await saveSession(current); });
    };
    if (!candidates.length) {
      return { candidates: [], decisions: [], pages: await pages([]), fingerprint: '', configRevision: settings.revision, createdAt: now() };
    }
    let decisions: CleanupDecision[];
    if (settings.mode === 'time') {
      decisions = candidates.map(tab => ({ id: tab.id, action: 'archive', kind: 'other', task: tab.groupTitle || '闲置标签',
        reason: `${Math.floor((now() - tab.lastUsed) / DAY)} 天未使用` }));
    } else {
      if (!model || !supportedCleanupProvider(model.provider)) throw new Error('当前 AI 引擎不支持后台清理，请在 AI 引擎设置中更换，或选择按时间清理。');
      const unresolved = candidates.filter(tab => state.cache[tab.id]?.key !== key(tab));
      const resolved = () => candidates.filter(tab => state.cache[tab.id]?.key === key(tab)).map(tab => state.cache[tab.id].decision);
      await publish(resolved());
      if (unresolved.length) {
        await queue(async () => { const current = await session(); current.lastEvaluationAt = now(); current.lastModelKey = sharedModelKey; await saveSession(current); });
      }
      for (let offset = 0; offset < unresolved.length; offset += 40) {
        const batch = unresolved.slice(offset, offset + 40);
        if (manual) await status({ message: `AI 判断中，剩余 ${unresolved.length - offset} 个页面` });
        const fresh = await decide(batch, context, settings.tier, model, settings.prompt);
        if (!manual && activityRevision !== revision) throw new Error('浏览状态已变化，本轮清理已跳过，稍后重新判断。');
        if (await modelKey(await readModel()) !== sharedModelKey) throw new Error('AI 引擎已更换，本轮清理已跳过。');
        // The adapter validates schema; validate identity again at the execution boundary.
        if (fresh.length !== batch.length || new Set(fresh.map(item => item.id)).size !== batch.length ||
          fresh.some(item => !batch.some(tab => tab.id === item.id))) throw new Error('清理决定与候选不一致。');
        for (const item of fresh) state.cache[item.id] = { key: key(batch.find(tab => tab.id === item.id)!), at: now(), decision: item };
        // Results remain keyed to their original inputs; unrelated focus/group events need not erase useful work.
        await queue(async () => { const current = await session(); current.cache = { ...current.cache, ...state.cache }; await saveSession(current); });
        await publish(resolved());
      }
      decisions = candidates.map(tab => state.cache[tab.id].decision);
    }
    return { candidates, decisions, pages: await pages(decisions), configRevision: settings.revision, createdAt: now(), activityRevision: revision,
      modelKey: sharedModelKey, modelLabel: model ? `${model.provider} / ${model.model || '默认模型'}` : '按时间清理',
      fingerprint: JSON.stringify(candidates.map(tab => [tab.id, tab.url, tab.lastUsed, tab.windowId, tab.groupId])) };
  }
  async function execute(plan: CleanupPlan) {
    const batchId = crypto.randomUUID();
    let count = 0;
    let failures = 0;
    for (const decision of plan.decisions.filter(item => item.action === 'archive')) {
      await queue(async () => {
        const settings = await config();
        const state = await session();
        if (settings.mode === 'ai' && await modelKey(await readModel()) !== plan.modelKey) return;
        if (activityRevision !== plan.activityRevision || !settings.enabled || settings.revision !== plan.configRevision || settings.pausedUntil > now() ||
          Math.max(settings.notBefore, state.resumeAfter) > now() || now() - plan.createdAt > 10 * 60_000) return;
        const original = plan.candidates.find(tab => tab.id === decision.id);
        if (!original || state.tabs[decision.id]?.lastUsed !== original.lastUsed) return;
        let tab: chrome.tabs.Tab;
        try { tab = await chrome.tabs.get(decision.id); } catch { return; }
        if (!allowed(tab, settings, state, now()) || tab.url !== original.url || tab.windowId !== original.windowId || tab.groupId !== original.groupId) return;
        let group: chrome.tabGroups.TabGroup | undefined;
        if (tab.groupId >= 0) { try { group = await chrome.tabGroups.get(tab.groupId); } catch { return; } }
        const entries = await archive();
        if (entries.some(entry => entry.state === 'pending' && entry.sessionId === state.id && entry.tabId === tab.id)) return;
        const entry: ArchiveEntry = { id: crypto.randomUUID(), batchId, tabId: tab.id!, sessionId: state.id, url: tab.url!, title: tab.title ?? tab.url!,
          windowId: tab.windowId, index: tab.index, groupId: tab.groupId, groupTitle: group?.title ?? '', groupColor: group?.color === 'orange' ? 'yellow' : group?.color ?? 'grey',
          groupCollapsed: group?.collapsed ?? false, task: decision.task, reason: decision.reason, archivedAt: now(), tier: settings.tier,
          model: plan.modelLabel ?? '按时间清理', state: 'pending' };
        await saveArchive([...entries, entry]);
        try {
          const fresh = await chrome.tabs.get(decision.id);
          if (activityRevision !== plan.activityRevision || !allowed(fresh, settings, state, now()) || fresh.url !== original.url || fresh.windowId !== original.windowId || fresh.groupId !== original.groupId) {
            await saveArchive(entries); return;
          }
          await chrome.tabs.remove(decision.id);
          // A refused beforeunload close must not be reported as a successful archive.
          let stillOpen = false;
          try { await chrome.tabs.get(decision.id); stillOpen = true; } catch { /* successfully closed */ }
          if (stillOpen) { failures++; await saveArchive(entries); return; }
          count++;
          entry.state = 'archived';
          await saveArchive([...entries, entry]);
        } catch (error) {
          failures++;
          // Keep pending recovery data if closing or the final write was interrupted.
          if (!count) throw error;
        }
      });
    }
    await status({ message: count ? `已归档 ${count} 个标签${failures ? `，${failures} 个未完成` : ''}` : '本轮没有关闭标签。',
      lastRunAt: now(), lastBatchId: count ? batchId : undefined, archivedCount: count });
  }
  async function run(manual = false, previewId = crypto.randomUUID()): Promise<CleanupPlan | undefined> {
    if (flight) throw new Error('清理正在进行，请稍后再试。');
    const work = (async () => {
      try {
        const plan = await evaluate(manual, previewId);
        if (manual && plan) await status({ message: '' });
        if (!manual && plan?.candidates.length) await execute(plan);
        return plan;
      } catch (error) {
        await status({ message: error instanceof Error ? error.message : '本轮清理失败，标签已保留。', lastRunAt: now() });
        if (manual) throw error;
      }
    })();
    flight = work;
    try { return await work; } finally { if (flight === work) flight = undefined; }
  }
  async function view(): Promise<CleanupView> {
    const settings = await config(); const state = await session();
    return { config: settings, entries: await archive(), status: (await chrome.storage.local.get(CLEANUP_STATUS_KEY))[CLEANUP_STATUS_KEY] as CleanupStatus | undefined ?? { message: '' },
      protectedTabIds: state.protectedTabIds, protectedGroupIds: state.protectedGroupIds, preview: state.preview };
  }
  async function update(patch: Partial<CleanupConfig>) {
    activityRevision++;
    return queue(async () => {
      const current = await config();
      const next = { ...current };
      if (patch.mode !== undefined) { if (!['ai', 'time'].includes(patch.mode)) throw new Error('无效清理方式。'); next.mode = patch.mode; }
      if (patch.tier !== undefined) { if (!Object.hasOwn(CLEANUP_TIERS, patch.tier)) throw new Error('无效清理档位。'); next.tier = patch.tier; }
      if (patch.prompt !== undefined) {
        if (typeof patch.prompt !== 'string' || patch.prompt.length > 4000) throw new Error('清理提示词最多 4000 字。');
        const prompt = patch.prompt.trim();
        next.prompt = prompt === CLEANUP_TIERS[next.tier].prompt ? '' : prompt;
      }
      if (patch.protectedSites !== undefined) {
        if (!Array.isArray(patch.protectedSites) || patch.protectedSites.length > 200) throw new Error('保护网站数量过多。');
        next.protectedSites = [...new Set(patch.protectedSites.map(normalizeProtectedSite))];
      }
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (typeof patch.pausedUntil === 'number' && Number.isFinite(patch.pausedUntil)) next.pausedUntil = Math.max(0, patch.pausedUntil);
      if (next.enabled && next.mode === 'ai' && (!current.enabled || next.mode !== current.mode) &&
        !supportedCleanupProvider((await readModel()).provider)) throw new Error('请先在 AI 引擎设置中选择模型，或改用按时间清理。');
      if (next.enabled && (!current.enabled || next.tier !== current.tier || next.mode !== current.mode ||
        next.mode === 'ai' && next.prompt !== current.prompt)) next.notBefore = now() + DAY;
      next.revision = crypto.randomUUID();
      await chrome.storage.local.set({ [CLEANUP_CONFIG_KEY]: next });
      await schedule(); return next;
    });
  }
  async function schedule() {
    if ((await config()).enabled) { if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 5 }); }
    else await chrome.alarms.clear(ALARM);
  }
  async function touch(tabId: number, navigationURL?: string) {
    activityRevision++;
    return queue(async () => {
      let tab: chrome.tabs.Tab;
      try { tab = await chrome.tabs.get(tabId); } catch { return; }
      if (tab.incognito || !/^https?:\/\//.test(tab.url ?? '')) return;
      const state = await session();
      const previous = state.tabs[tabId];
      if (navigationURL && previous && previous.url !== tab.url) state.restoreTabIds = state.restoreTabIds.filter(id => id !== tabId);
      // On activation, reset the previous active tab as well: long reading is use.
      const activeKey = activeIds.get(tab.windowId);
      if (!navigationURL && activeKey !== undefined && state.tabs[activeKey]) state.tabs[activeKey].lastUsed = now();
      if (!navigationURL) activeIds.set(tab.windowId, tabId);
      if (!navigationURL || previous?.url !== tab.url) {
        state.tabs[tabId] = { url: tab.url!, windowId: tab.windowId, groupId: tab.groupId, lastUsed: now(), visits: (previous?.visits ?? 0) + 1 };
        delete state.cache[tabId];
      }
      await saveSession(state);
    });
  }
  const activeIds = new Map<number, number>();
  async function protect(kind: 'tab' | 'group', id: number, enabled: boolean) {
    activityRevision++;
    if (!['tab', 'group'].includes(kind) || !Number.isSafeInteger(id) || id < 0) throw new Error('保护对象无效。');
    return queue(async () => {
      const state = await session(); const key = kind === 'tab' ? 'protectedTabIds' : 'protectedGroupIds';
      state[key] = enabled ? [...new Set([...state[key], id])] : state[key].filter(item => item !== id);
      await saveSession(state);
    });
  }
  async function removeEntries(ids: string[]) {
    return queue(async () => { await saveArchive((await archive()).filter(entry => !ids.includes(entry.id))); });
  }
  async function restore(ids: string[], windowId?: number, newWindow = false) {
    return queue(async () => {
      let target: chrome.windows.Window;
      if (newWindow) {
        const created = await chrome.windows.create({ type: 'normal', focused: true });
        if (!created) throw new Error('无法新建恢复窗口。');
        target = created;
      }
      else {
        if (!Number.isInteger(windowId)) throw new Error('来源窗口不可用，请选择在新窗口打开。');
        try { target = await chrome.windows.get(windowId!); } catch { throw new Error('来源窗口已关闭，请选择在新窗口打开。'); }
      }
      if (target.type !== 'normal' || target.incognito || target.id === undefined) throw new Error('恢复目的地必须是普通窗口。');
      const entries = await archive();
      const chosen = entries.filter(entry => ids.includes(entry.id)).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
      const groups = new Map<string, number>();
      const state = await session();
      const errors: string[] = [];
      for (const entry of chosen) {
        try {
          let tab = (await chrome.tabs.query({ windowId: target.id })).find(tab => tab.url === entry.url);
          if (!tab && entry.restoredTabId && entry.restoredWindowId === target.id) {
            try { const existing = await chrome.tabs.get(entry.restoredTabId); if (existing.url === entry.url) tab = existing; } catch { /* retry creates only if needed */ }
          }
          const created = !tab;
          if (!tab) {
            state.restoreURLs.push(entry.url); await saveSession(state);
            tab = await chrome.tabs.create({ windowId: target.id, url: entry.url, active: false });
            if (tab.id === undefined) throw new Error('浏览器未返回恢复标签。');
            state.restoreTabIds.push(tab.id);
            state.tabs[tab.id] = { url: entry.url, windowId: target.id, groupId: -1, lastUsed: now(), visits: 1 };
            entry.restoredTabId = tab.id; entry.restoredWindowId = target.id;
            await saveSession(state); await saveArchive((await archive()).map(item => item.id === entry.id ? entry : item));
          }
          if ((created || entry.restoredTabId === tab.id) && entry.groupId >= 0) {
            const key = `${entry.sessionId}/${entry.windowId}/${entry.groupId}`;
            let groupId = groups.get(key);
            if (groupId === undefined && entry.sessionId === state.id && entry.windowId === target.id) {
              try { const original = await chrome.tabGroups.get(entry.groupId); if (original.windowId === target.id) groupId = original.id; } catch { /* recreate */ }
            }
            groupId = await chrome.tabs.group({ tabIds: [tab.id!], ...(groupId !== undefined ? { groupId } : { createProperties: { windowId: target.id } }) });
            groups.set(key, groupId);
            await chrome.tabGroups.update(groupId, { title: entry.groupTitle, color: entry.groupColor, collapsed: entry.groupCollapsed });
          }
          if (tab.id !== undefined) {
            state.tabs[tab.id] = { url: entry.url, windowId: target.id, groupId: tab.groupId, lastUsed: now(), visits: 1 };
            state.protectedTabIds = [...new Set([...state.protectedTabIds, tab.id])];
          }
          await saveSession(state);
          if ((chosen.length === 1 || newWindow && entry.id === chosen[0]?.id) && tab.id !== undefined) {
            await chrome.tabs.update(tab.id, { active: true });
            await chrome.windows.update(target.id, { focused: true });
          }
          await saveArchive((await archive()).filter(item => item.id !== entry.id));
        } catch { errors.push(entry.title); }
        finally {
          state.restoreURLs = state.restoreURLs.filter(url => url !== entry.url);
          // Keep restored IDs for this session to prevent delayed page-load auto grouping.
          await saveSession(state);
        }
      }
      if (errors.length) throw new Error(`${errors.length} 个标签恢复未完成，记录已保留，请重试。`);
    });
  }
  async function initialize() {
    await queue(async () => {
      const stored = (await chrome.storage.local.get(CLEANUP_CONFIG_KEY))[CLEANUP_CONFIG_KEY] as Record<string, unknown> | undefined;
      if (stored && (Object.hasOwn(stored, 'model') || !Object.hasOwn(stored, 'prompt'))) {
        const migrated = { ...stored, prompt: stored.prompt ?? '' }; delete (migrated as Record<string, unknown>).model;
        if (!Object.hasOwn(stored, 'prompt') && stored.enabled && stored.mode === 'ai') {
          Object.assign(migrated, { notBefore: Math.max(Number(stored.notBefore) || 0, now() + DAY), revision: crypto.randomUUID() });
        }
        await chrome.storage.local.set({ [CLEANUP_CONFIG_KEY]: migrated });
      }
      await collect();
      const state = await session();
      const entries = await archive();
      const reconciled: ArchiveEntry[] = [];
      for (const entry of entries) {
        if (entry.state !== 'pending') { reconciled.push(entry); continue; }
        let live: chrome.tabs.Tab | undefined;
        if (entry.sessionId === state.id) { try { live = await chrome.tabs.get(entry.tabId); } catch { /* closed */ } }
        if (live?.url !== entry.url) reconciled.push({ ...entry, state: 'archived' });
      }
      if (entries.some(entry => entry.state === 'pending')) await saveArchive(reconciled);
      state.restoreURLs = []; await saveSession(state);
      for (const tab of await chrome.tabs.query({ active: true, windowType: 'normal' })) if (tab.id !== undefined) activeIds.set(tab.windowId, tab.id);
    });
    await queue(schedule);
  }
  return { initialize, view, update, run, execute, restore, protect, removeEntries, touch, queue, session, saveSession,
    invalidate: () => { activityRevision++; } };
}

export async function isCleanupRestoringTab(tab: chrome.tabs.Tab): Promise<boolean> {
  const state = (await chrome.storage.session.get(CLEANUP_SESSION_KEY))[CLEANUP_SESSION_KEY] as CleanupSession | undefined;
  return !!state && (state.restoreTabIds.includes(tab.id!) || state.restoreURLs.includes(tab.url ?? ''));
}

export function registerCleanupBackground(decide: Decide) {
  const controller = createCleanupController(decide);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[SETTINGS_KEY]) return;
    const before = changes[SETTINGS_KEY].oldValue as { aiSettings?: AISettings } | undefined;
    const after = changes[SETTINGS_KEY].newValue as { aiSettings?: AISettings } | undefined;
    if ((['provider', 'model', 'apiEndpoint', 'apiKey'] as const).some(field => before?.aiSettings?.[field] !== after?.aiSettings?.[field])) controller.invalidate();
  });
  const report = (error: unknown) => console.warn('TabFlow cleanup:', error instanceof Error ? error.message : '后台清理失败');
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void controller.run().catch(report); });
  chrome.tabs.onActivated.addListener(info => { void controller.touch(info.tabId).catch(report); });
  chrome.tabs.onCreated.addListener(tab => { if (tab.id !== undefined) void controller.touch(tab.id, tab.url ?? '').catch(report); });
  chrome.tabs.onUpdated.addListener((id, changes) => { if (changes.url) void controller.touch(id, changes.url).catch(report); });
  chrome.tabs.onAttached.addListener(() => controller.invalidate());
  chrome.tabs.onDetached.addListener(() => controller.invalidate());
  chrome.tabGroups.onUpdated.addListener(() => controller.invalidate());
  chrome.tabs.onRemoved.addListener(id => { void controller.queue(async () => {
    const state = await controller.session(); delete state.tabs[id]; delete state.cache[id];
    state.protectedTabIds = state.protectedTabIds.filter(item => item !== id);
    state.restoreTabIds = state.restoreTabIds.filter(item => item !== id); await controller.saveSession(state);
  }).catch(report); });
  chrome.windows.onFocusChanged.addListener(id => { if (id < 0) return;
    void chrome.tabs.query({ windowId: id, active: true }).then(tabs => { if (tabs[0]?.id !== undefined) return controller.touch(tabs[0].id); }).catch(report);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.action !== 'CLEANUP') return;
    if (!trustedSender(sender, chrome.runtime.id, UI_PATHS)) { respond({ success: false, error: '拒绝未经授权的清理请求。' }); return; }
    const operation = async () => {
      switch (message.command) {
        case 'view': return controller.queue(controller.view);
        case 'update': return controller.update(message.patch ?? {});
        case 'preview': {
          if (message.id !== undefined && (typeof message.id !== 'string' || message.id.length > 100)) throw new Error('无效预览请求。');
          return controller.run(true, message.id);
        }
        case 'protect': return controller.protect(message.kind, message.id, message.enabled === true);
        case 'delete':
        case 'restore': {
          if (!Array.isArray(message.ids) || message.ids.length > 5000 || !message.ids.every((id: unknown) => typeof id === 'string')) throw new Error('归档选择无效。');
          return message.command === 'delete' ? controller.removeEntries(message.ids) : controller.restore(message.ids, message.windowId, message.newWindow === true);
        }
        default: throw new Error('未知清理操作。');
      }
    };
    void operation().then(value => respond({ success: true, value }), error => respond({ success: false, error: error instanceof Error ? error.message : '清理操作失败。' }));
    return true;
  });
  void controller.initialize().catch(report);
  return controller;
}

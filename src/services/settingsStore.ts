import type { AISettings } from './aiGrouper';
import { migrateProviderSettings, updateProviderSettings } from './providerSettings';
import type { AIProfiles } from './providerSettings';

export interface UserSettings {
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  showFavicon: boolean;
  showDuplicateCount: boolean;
  autoGroupNewTabs: boolean;
  aiSettings: AISettings;
  aiProfiles: AIProfiles;
}

export const SETTINGS_KEY = 'sidetab_settings';
export const DEFAULT_SETTINGS: UserSettings = {
  aiProfiles: {}, theme: 'system', density: 'comfortable', showFavicon: true,
  showDuplicateCount: true, autoGroupNewTabs: true,
  aiSettings: {
    provider: 'codex_native', apiKey: '', apiEndpoint: '', model: '',
    customPrompt: '你是一个专业的浏览器标签页整理助手。请根据标签页的标题与网址，将其归纳整理为 2 到 6 个逻辑清晰的主题组。组名简明扼要（2 到 6 个汉字），并分配合适的颜色。',
  },
};

export function normalizeSettings(value?: unknown): UserSettings {
  const saved = value && typeof value === 'object' ? value as Partial<UserSettings> : undefined;
  return migrateProviderSettings({ ...DEFAULT_SETTINGS, ...saved,
    aiSettings: { ...DEFAULT_SETTINGS.aiSettings, ...saved?.aiSettings } });
}

export interface SettingsPatch {
  action: 'UPDATE_SETTINGS' | 'UPDATE_AI_SETTINGS';
  patch: Partial<UserSettings> | Partial<AISettings>;
  targetProvider?: AISettings['provider'];
}

export function applySettingsPatch(current: UserSettings, request: SettingsPatch): UserSettings {
  const patch = request.action === 'UPDATE_AI_SETTINGS'
    ? request.patch as Partial<AISettings>
    : (request.patch as Partial<UserSettings>).aiSettings;
  // Profiles are maintained exclusively by the provider helper, never a stale UI snapshot.
  const { aiSettings: _ai, aiProfiles: _profiles, ...general } = request.action === 'UPDATE_SETTINGS'
    ? request.patch as Partial<UserSettings> : {};
  let next = migrateProviderSettings({ ...current, ...general });
  if (!patch) return next;
  const target = patch.provider ?? request.targetProvider;
  if (!target) throw new Error('AI 设置更新缺少目标 provider。');
  if (patch.provider || target === next.aiSettings.provider) {
    return updateProviderSettings(next, { ...patch, provider: target });
  }
  // Editing an older view must not switch the provider selected in another view.
  const edited = updateProviderSettings(next, { ...patch, provider: target });
  next = { ...next, aiProfiles: edited.aiProfiles,
    aiSettings: { ...next.aiSettings,
      ...(patch.customPrompt !== undefined ? { customPrompt: patch.customPrompt } : {}) } };
  return migrateProviderSettings(next);
}

export function readSettings(): Promise<UserSettings> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      const error = chrome.runtime?.lastError?.message;
      if (error) reject(new Error(error));
      else resolve(normalizeSettings(result?.[SETTINGS_KEY]));
    });
  });
}

/** All extension writers use this single background-owned queue. A rejection never poisons it. */
export function createSettingsWriter() {
  let tail: Promise<unknown> = Promise.resolve();
  return (request: SettingsPatch): Promise<UserSettings> => {
    const task = tail.then(async () => {
      const next = applySettingsPatch(await readSettings(), request);
      await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
      return next;
    });
    tail = task.catch(() => {});
    return task;
  };
}

/** Subscribe before reading; an event received during the read supersedes its snapshot. */
export function observeSettings(onSettings: (settings: UserSettings) => void,
  onLoaded: () => void, onError: (message: string) => void): () => void {
  let active = true;
  let revision = 0;
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'sync' || !Object.hasOwn(changes, SETTINGS_KEY)) return;
    revision++;
    if (active) { onSettings(normalizeSettings(changes[SETTINGS_KEY].newValue)); onLoaded(); }
  };
  chrome.storage.onChanged.addListener(listener);
  const readRevision = revision;
  void readSettings().then((settings) => {
    if (active && revision === readRevision) onSettings(settings);
  }).catch((error) => { if (active) onError(String(error.message ?? error)); })
    .finally(() => { if (active) onLoaded(); });
  return () => { active = false; chrome.storage.onChanged.removeListener(listener); };
}

let devSettings = normalizeSettings();
const devListeners = new Set<(settings: UserSettings) => void>();
export function observeDevSettings(listener: (settings: UserSettings) => void) {
  devListeners.add(listener); listener(devSettings);
  return () => { devListeners.delete(listener); };
}
export async function sendSettingsPatch(request: SettingsPatch): Promise<void> {
  // Only a genuinely absent extension runtime uses the in-memory development fallback.
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    devSettings = applySettingsPatch(devSettings, request);
    devListeners.forEach((listener) => listener(devSettings));
    return;
  }
  const response = await chrome.runtime.sendMessage(request);
  if (!response?.success) throw new Error(response?.error || '后台未确认设置更新。');
}

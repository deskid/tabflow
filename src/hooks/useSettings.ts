import { useState, useEffect, useRef } from 'react';
import type { AISettings } from '../services/aiGrouper';
import { DEFAULT_SETTINGS, applySettingsPatch, observeSettings, observeDevSettings, sendSettingsPatch } from '../services/settingsStore';
import type { UserSettings, SettingsPatch } from '../services/settingsStore';
export type { UserSettings } from '../services/settingsStore';

export function useSettings() {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const current = useRef(settings);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const receive = (next: UserSettings) => { current.current = next; setSettings(next); };
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      const unsubscribe = observeDevSettings(receive);
      setLoaded(true);
      return unsubscribe;
    }
    try {
      return observeSettings(receive, () => setLoaded(true), setError);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
      setLoaded(true);
    }
  }, []);

  const update = (request: SettingsPatch) => {
    setError(null);
    // Keep the target stable for consecutive edits before React renders again.
    try {
      const next = applySettingsPatch(current.current, request);
      current.current = next;
      setSettings(next);
      void sendSettingsPatch(request).catch((reason) => setError(String(reason.message ?? reason)));
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
  };
  const updateSettings = (updates: Partial<UserSettings>) => update({
    action: 'UPDATE_SETTINGS', patch: updates,
    targetProvider: updates.aiSettings?.provider ?? settings.aiSettings.provider,
  });
  const updateAISettings = (patch: Partial<AISettings>) => update({
    action: 'UPDATE_AI_SETTINGS', patch,
    targetProvider: patch.provider ?? settings.aiSettings.provider,
  });

  useEffect(() => {
    const root = document.documentElement;
    const isDark = settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', isDark);
  }, [settings.theme]);

  return { settings, loaded, error, updateSettings, updateAISettings };
}

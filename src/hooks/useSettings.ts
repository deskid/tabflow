import { useState, useEffect } from 'react';
import { AISettings, DEFAULT_GROUPING_PROMPT } from '../services/aiGrouper';

export interface UserSettings {
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  showFavicon: boolean;
  showDuplicateCount: boolean;
  autoGroupNewTabs: boolean;
  aiSettings: AISettings;
}

const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  density: 'comfortable',
  showFavicon: true,
  showDuplicateCount: true,
  autoGroupNewTabs: true,
  aiSettings: {
    provider: 'codex_native',
    apiKey: '',
    apiEndpoint: '',
    model: 'antigravity/gemini-3.8-flash',
    customPrompt: DEFAULT_GROUPING_PROMPT,
  },
};

export function useSettings() {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!chrome.storage?.sync) {
      setLoaded(true);
      return;
    }

    chrome.storage.sync.get('sidetab_settings', (res: { [key: string]: any }) => {
      if (res?.sidetab_settings) {
        const saved = res.sidetab_settings as Partial<UserSettings>;
        setSettings({
          ...DEFAULT_SETTINGS,
          ...saved,
          aiSettings: {
            ...DEFAULT_SETTINGS.aiSettings,
            ...(saved.aiSettings || {}),
          },
        });
      }
      setLoaded(true);
    });
  }, []);

  const updateSettings = (updates: Partial<UserSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates };
      if (chrome.storage?.sync) {
        chrome.storage.sync.set({ sidetab_settings: next }).catch(() => {});
      }
      return next;
    });
  };

  const updateAISettings = (aiUpdates: Partial<AISettings>) => {
    setSettings((prev) => {
      const next: UserSettings = {
        ...prev,
        aiSettings: { ...prev.aiSettings, ...aiUpdates },
      };
      if (chrome.storage?.sync) {
        chrome.storage.sync.set({ sidetab_settings: next }).catch(() => {});
      }
      return next;
    });
  };

  useEffect(() => {
    const root = document.documentElement;
    const isDark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [settings.theme]);

  return {
    settings,
    loaded,
    updateSettings,
    updateAISettings,
  };
}

import type { AISettings } from './aiGrouper';

export type AIProviderProfile = Pick<AISettings, 'model' | 'apiKey' | 'apiEndpoint'>;
export type AIProfiles = Partial<Record<AISettings['provider'], AIProviderProfile>>;

interface ProviderSettingsState {
  aiSettings: AISettings;
  aiProfiles?: AIProfiles;
}

function profileFrom(settings: AIProviderProfile): AIProviderProfile {
  return {
    model: settings.model ?? '',
    apiKey: settings.apiKey ?? '',
    apiEndpoint: settings.apiEndpoint ?? '',
  };
}

/**
 * The active aiSettings is authoritative for its provider, including empty values.
 * Legacy settings seed only that provider; other saved profiles stay independent.
 * Profiles contain no prompt: customPrompt remains global in active aiSettings.
 */
export function migrateProviderSettings<T extends ProviderSettingsState>(settings: T): T & { aiProfiles: AIProfiles } {
  const aiProfiles: AIProfiles = {};
  for (const provider of Object.keys(settings.aiProfiles ?? {}) as AISettings['provider'][]) {
    const profile = settings.aiProfiles?.[provider];
    if (profile) aiProfiles[provider] = profileFrom(profile);
  }

  const activeProfile = profileFrom(settings.aiSettings);
  aiProfiles[settings.aiSettings.provider] = activeProfile;
  return {
    ...settings,
    aiSettings: { ...settings.aiSettings, ...activeProfile },
    aiProfiles,
  };
}

/** Save the outgoing provider before selecting a target, then apply explicit edits. */
export function updateProviderSettings<T extends ProviderSettingsState>(
  settings: T,
  updates: Partial<AISettings>,
): T & { aiProfiles: AIProfiles } {
  const current = migrateProviderSettings(settings);
  const provider = updates.provider ?? current.aiSettings.provider;
  const profile = profileFrom(current.aiProfiles[provider] ?? {});
  const aiSettings: AISettings = {
    ...current.aiSettings,
    ...profile,
    ...updates,
    provider,
  };

  return migrateProviderSettings({ ...current, aiSettings });
}

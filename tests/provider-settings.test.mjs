import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateProviderSettings, updateProviderSettings } from '../src/services/providerSettings.ts';

const custom = {
  provider: 'custom', model: 'custom-model', apiKey: 'synthetic-custom-key',
  apiEndpoint: 'https://custom.example/v1', customPrompt: 'Global grouping prompt',
};
const emptyProfile = { model: '', apiKey: '', apiEndpoint: '' };
const fields = ({ model, apiKey, apiEndpoint }) => ({ model, apiKey, apiEndpoint });
const initial = () => ({
  theme: 'dark', density: 'compact', showFavicon: false,
  showDuplicateCount: false, autoGroupNewTabs: false,
  aiSettings: { ...custom },
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('custom → codex → custom restores independent model, key and endpoint', () => {
  const source = initial();
  const codex = updateProviderSettings(source, { provider: 'codex_native' });
  assert.deepEqual(fields(codex.aiSettings), emptyProfile);
  assert.deepEqual(codex.aiProfiles.custom, fields(custom));

  const configured = updateProviderSettings(codex, { model: 'codex-model' });
  const restored = updateProviderSettings(configured, { provider: 'custom' });
  assert.deepEqual(restored.aiSettings, custom);
  assert.deepEqual(restored.aiProfiles.codex_native, { ...emptyProfile, model: 'codex-model' });
  assert.equal(updateProviderSettings(restored, { provider: 'codex_native' }).aiSettings.model, 'codex-model');
  for (const field of ['theme', 'density', 'showFavicon', 'showDuplicateCount', 'autoGroupNewTabs']) {
    assert.equal(restored[field], source[field]);
  }
});

test('openai and deepseek do not inherit or overwrite one another', () => {
  const openaiFields = { model: 'openai-model', apiKey: 'synthetic-openai-key', apiEndpoint: 'https://openai.example/v1' };
  const deepseekFields = { model: 'deepseek-model', apiKey: 'synthetic-deepseek-key', apiEndpoint: 'https://deepseek.example/v1' };
  const openai = updateProviderSettings(initial(), { provider: 'openai', ...openaiFields });
  const blankDeepseek = updateProviderSettings(openai, { provider: 'deepseek' });
  assert.deepEqual(fields(blankDeepseek.aiSettings), emptyProfile);
  const deepseek = updateProviderSettings(blankDeepseek, deepseekFields);
  const restored = updateProviderSettings(deepseek, { provider: 'openai' });
  assert.deepEqual(fields(restored.aiSettings), openaiFields);
  assert.deepEqual(restored.aiProfiles.deepseek, deepseekFields);
  const cleared = updateProviderSettings(restored, { apiKey: '', apiEndpoint: '' });
  assert.deepEqual(cleared.aiProfiles.openai, { ...openaiFields, apiKey: '', apiEndpoint: '' });
  assert.deepEqual(cleared.aiProfiles.deepseek, deepseekFields);
});

test('legacy migration seeds only the active provider and is idempotent', () => {
  const migrated = migrateProviderSettings(initial());
  assert.deepEqual(migrated.aiSettings, custom);
  assert.deepEqual(migrated.aiProfiles, { custom: fields(custom) });
  assert.deepEqual(migrateProviderSettings(migrated), migrated);
  assert.deepEqual(migrateProviderSettings(JSON.parse(JSON.stringify(migrated))), migrated);
});

test('reload preserves inactive profiles while active aiSettings wins conflicts, including blanks', () => {
  const source = {
    ...initial(),
    aiSettings: { ...custom, model: '', apiKey: '' },
    aiProfiles: {
      custom: { model: 'stale-model', apiKey: 'stale-key', apiEndpoint: 'https://stale.example/v1' },
      openai: { model: 'saved-model', apiKey: 'synthetic-saved-key', apiEndpoint: 'https://saved.example/v1' },
      codex_native: { model: 'saved-codex' },
    },
  };
  const migrated = migrateProviderSettings(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(migrated.aiSettings, source.aiSettings);
  assert.deepEqual(migrated.aiProfiles.custom, fields(source.aiSettings));
  assert.deepEqual(migrated.aiProfiles.openai, source.aiProfiles.openai);
  assert.deepEqual(migrated.aiProfiles.codex_native, { ...emptyProfile, model: 'saved-codex' });
  assert.deepEqual(migrateProviderSettings(migrated), migrated);
  assert.deepEqual(fields(updateProviderSettings(migrated, { provider: 'openai' }).aiSettings), source.aiProfiles.openai);
});

test('customPrompt is global across switches and never stored in provider profiles', () => {
  const changed = updateProviderSettings(initial(), { customPrompt: 'New global prompt' });
  assert.deepEqual(changed.aiProfiles.custom, fields(custom));
  const codex = updateProviderSettings(changed, { provider: 'codex_native' });
  assert.equal(codex.aiSettings.customPrompt, 'New global prompt');
  const cleared = updateProviderSettings(codex, { customPrompt: '' });
  const restored = updateProviderSettings(cleared, { provider: 'custom' });
  assert.equal(restored.aiSettings.customPrompt, '');
  for (const profile of Object.values(restored.aiProfiles)) {
    assert.equal(Object.hasOwn(profile, 'customPrompt'), false);
    assert.equal(Object.hasOwn(profile, 'provider'), false);
  }
});

test('migration and updates accept frozen inputs without mutations or shared profile objects', () => {
  const source = deepFreeze({
    ...initial(),
    aiProfiles: { openai: { model: 'frozen-model', apiKey: 'synthetic-frozen-key' } },
  });
  const snapshot = structuredClone(source);
  const updates = deepFreeze({ provider: 'openai', apiEndpoint: 'https://frozen.example/v1', customPrompt: 'Frozen prompt' });
  const migrated = migrateProviderSettings(source);
  const changed = updateProviderSettings(source, updates);
  assert.deepEqual(source, snapshot);
  assert.notEqual(migrated.aiSettings, source.aiSettings);
  assert.notEqual(migrated.aiProfiles, source.aiProfiles);
  assert.notEqual(migrated.aiProfiles.openai, source.aiProfiles.openai);
  assert.notEqual(changed.aiProfiles.openai, source.aiProfiles.openai);
  assert.deepEqual(changed.aiProfiles.openai, {
    model: 'frozen-model', apiKey: 'synthetic-frozen-key', apiEndpoint: 'https://frozen.example/v1',
  });
  assert.deepEqual(changed.aiProfiles.custom, fields(custom));
});

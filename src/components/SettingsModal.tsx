import React from 'react';
import { X, Moon, Sun, Monitor, LayoutGrid, List, RotateCcw } from 'lucide-react';
import { UserSettings } from '../hooks/useSettings';
import { DEFAULT_GROUPING_PROMPT, type AISettings } from '../services/aiGrouper';
import { AIProviderSettings } from './AIProviderSettings';
import { GROUPING_PROMPT_PRESETS } from '../services/groupingPresets';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  error?: string | null;
  onUpdateSettings: (updates: Partial<UserSettings>) => void;
  onUpdateAISettings: (aiUpdates: Partial<AISettings>) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  error,
  onUpdateSettings,
  onUpdateAISettings,
}) => {
  if (!isOpen) return null;

  const { theme, density, autoGroupNewTabs, aiSettings } = settings;
  const currentPrompt = aiSettings.customPrompt ?? DEFAULT_GROUPING_PROMPT;
  const currentPreset = currentPrompt === DEFAULT_GROUPING_PROMPT ? 'default'
    : GROUPING_PROMPT_PRESETS.find((preset) => preset.prompt === currentPrompt)?.id || 'custom';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 select-none">
      <div className="w-full max-w-sm rounded-xl bg-[var(--app-bg)] border-hairline border-[var(--border-interactive)] shadow-sm p-4 text-[13px] text-[var(--text-high)] animate-in fade-in duration-200 ease-out">
        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 border-b-hairline border-[var(--border-subtle)]">
          <span className="font-semibold text-[14px]">偏好设置</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-medium)] hover:text-[var(--text-high)] transition-colors duration-150 ease-out"
          >
            <X size={15} />
          </button>
        </div>

        <div className="py-3 space-y-3.5 max-h-[75vh] overflow-y-auto scrollbar-thin">
          {error && <p role="alert" className="break-words text-[12px] text-[var(--text-medium)]">{error}</p>}
          {/* Theme */}
          <div>
            <label className="font-medium block mb-1 text-[12px] text-[var(--text-medium)]">外观主题</label>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: 'system', label: '跟随系统', icon: Monitor },
                { id: 'light', label: '浅色', icon: Sun },
                { id: 'dark', label: '暗黑', icon: Moon },
              ].map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onUpdateSettings({ theme: id as any })}
                  className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md border-hairline transition-colors duration-150 ease-out text-[12px] ${
                    theme === id
                      ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[var(--accent-text)] font-medium'
                      : 'border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] text-[var(--text-medium)]'
                  }`}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Density */}
          <div>
            <label className="font-medium block mb-1 text-[12px] text-[var(--text-medium)]">列表密度</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => onUpdateSettings({ density: 'comfortable' })}
                className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md border-hairline transition-colors duration-150 ease-out text-[12px] ${
                  density === 'comfortable'
                    ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[var(--accent-text)] font-medium'
                    : 'border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] text-[var(--text-medium)]'
                }`}
              >
                <LayoutGrid size={13} />
                <span>舒适</span>
              </button>

              <button
                type="button"
                onClick={() => onUpdateSettings({ density: 'compact' })}
                className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md border-hairline transition-colors duration-150 ease-out text-[12px] ${
                  density === 'compact'
                    ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[var(--accent-text)] font-medium'
                    : 'border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] text-[var(--text-medium)]'
                }`}
              >
                <List size={13} />
                <span>紧凑</span>
              </button>
            </div>
          </div>

          {/* Auto Group New Tabs Switch */}
          <div className="flex items-center justify-between p-2 rounded-md bg-[var(--surface)] border-hairline border-[var(--border-subtle)]">
            <div>
              <div className="font-medium text-[13px] text-[var(--text-high)]">新标签页自动归类</div>

            </div>
            <button
              type="button"
              onClick={() => onUpdateSettings({ autoGroupNewTabs: !autoGroupNewTabs })}
              className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-out flex items-center shrink-0 ${
                autoGroupNewTabs ? 'bg-[var(--accent-solid)] justify-end' : 'bg-[var(--border-interactive)] justify-start'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-white shadow-2xs" />
            </button>
          </div>

          <div className="h-hairline bg-[var(--border-subtle)]" />

          <AIProviderSettings active={isOpen} settings={aiSettings} onUpdate={onUpdateAISettings} />

          {aiSettings.provider !== 'heuristic' && <>
            <div className="h-hairline bg-[var(--border-subtle)]" />

            {/* Grouping style and editable prompt */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="grouping-style" className="font-medium text-[12px] text-[var(--text-medium)]">
                  分组风格
                </label>
                <button
                  type="button"
                  onClick={() => onUpdateAISettings({ customPrompt: DEFAULT_GROUPING_PROMPT })}
                  title="重置为默认提示词"
                  className="flex items-center gap-1 text-[12px] text-[var(--accent-text)] hover:underline transition-colors duration-150 ease-out"
                >
                  <RotateCcw size={11} />
                  <span>恢复默认</span>
                </button>
              </div>

              <select
                id="grouping-style"
                value={currentPreset}
                onChange={(event) => {
                  const preset = GROUPING_PROMPT_PRESETS.find((item) => item.id === event.target.value);
                  if (event.target.value === 'default') onUpdateAISettings({ customPrompt: DEFAULT_GROUPING_PROMPT });
                  else if (preset) onUpdateAISettings({ customPrompt: preset.prompt });
                }}
                className="w-full min-w-0 mb-1.5 px-2.5 py-2 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[13px] text-[var(--text-high)] outline-none"
              >
                <option value="default">默认</option>
                {GROUPING_PROMPT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                {currentPreset === 'custom' && <option value="custom">自定义</option>}
              </select>

              <textarea
                aria-label="分组提示词"
                rows={4}
                value={currentPrompt}
                onChange={(e) => onUpdateAISettings({ customPrompt: e.target.value })}
                placeholder="输入自定义标签分组规则..."
                className="w-full p-2 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[12px] text-[var(--text-high)] placeholder-[var(--text-low)] outline-none leading-relaxed resize-y scrollbar-thin transition-colors duration-150 ease-out"
              />

            </div>
          </>}
        </div>

        {/* Footer */}
        <div className="pt-2.5 border-t-hairline border-[var(--border-subtle)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1 rounded-md bg-[var(--accent-solid)] hover:bg-[var(--accent-solid)]/90 text-white font-medium text-[12px] transition-colors duration-150 ease-out"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};

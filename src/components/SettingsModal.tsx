import React, { useState, useEffect } from 'react';
import { X, Moon, Sun, Monitor, LayoutGrid, List, Sparkles, Key, Check, CheckCircle2, RotateCcw, Cpu } from 'lucide-react';
import { UserSettings } from '../hooks/useSettings';
import { getLocalCodexAccount, getLocalCodexModels, DEFAULT_GROUPING_PROMPT } from '../services/aiGrouper';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onUpdateSettings: (updates: Partial<UserSettings>) => void;
  onUpdateAISettings: (aiUpdates: any) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onUpdateAISettings,
}) => {
  const [codexAccount, setCodexAccount] = useState<{ loggedIn: boolean; email?: string } | null>(null);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (isOpen) {
      getLocalCodexAccount().then(setCodexAccount);
      getLocalCodexModels().then((models) => {
        if (models && models.length > 0) {
          setAvailableModels(models);
        }
      });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const { theme, density, autoGroupNewTabs, aiSettings } = settings;

  const modelOptions = availableModels.length > 0 ? availableModels : [
    { id: 'antigravity/gemini-3.8-flash', name: 'Gemini 3.8 Flash (推荐/极速)' },
    { id: 'deepseek/deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'auto/gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'auto/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'antigravity/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ];

  const currentModel = aiSettings.model || 'antigravity/gemini-3.8-flash';
  const currentPrompt = aiSettings.customPrompt ?? DEFAULT_GROUPING_PROMPT;

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
                <span>舒适 (36px)</span>
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
                <span>紧凑 (28px)</span>
              </button>
            </div>
          </div>

          {/* Auto Group New Tabs Switch */}
          <div className="flex items-center justify-between p-2 rounded-md bg-[var(--surface)] border-hairline border-[var(--border-subtle)]">
            <div>
              <div className="font-medium text-[13px] text-[var(--text-high)]">新标签页自动归类</div>
              <div className="text-[12px] text-[var(--text-medium)]">打开新页面时自动归入匹配的标签组</div>
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

          {/* AI Provider */}
          <div>
            <div className="flex items-center gap-1.5 font-medium text-[12px] text-[var(--text-medium)] mb-1.5">
              <Sparkles size={13} className="text-[var(--accent-text)]" />
              <span>自动分类引擎</span>
            </div>

            <div className="space-y-1 mb-2.5">
              {[
                { id: 'codex_native', label: '本机已登录 Codex 账号 (免授权桥接)' },
                { id: 'heuristic', label: '本地启发式 (免配置)' },
                { id: 'chrome_builtin', label: 'Chrome 端侧模型 (Gemini Nano)' },
                { id: 'deepseek', label: 'DeepSeek API' },
                { id: 'openai', label: 'OpenAI API' },
                { id: 'custom', label: '自定义端点 (Ollama / 兼容接口)' },
              ].map((opt) => (
                <div
                  key={opt.id}
                  onClick={() => onUpdateAISettings({ provider: opt.id })}
                  className={`px-2.5 py-1.5 rounded-md border-hairline cursor-pointer transition-colors duration-150 ease-out flex items-center justify-between ${
                    aiSettings.provider === opt.id
                      ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[var(--accent-text)] font-medium'
                      : 'border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] text-[var(--text-high)]'
                  }`}
                >
                  <span className="text-[13px]">{opt.label}</span>
                  {aiSettings.provider === opt.id && <Check size={14} className="text-[var(--accent-text)] shrink-0" />}
                </div>
              ))}
            </div>

            {/* Native Codex Settings (Account + Model Picker) */}
            {aiSettings.provider === 'codex_native' && (
              <div className="space-y-2 p-2 rounded-md bg-[var(--surface)] border-hairline border-[var(--border-subtle)]">
                {/* Account status */}
                <div className="flex items-center gap-2 text-[12px]">
                  <CheckCircle2 size={14} className="text-[var(--success-text)] shrink-0" />
                  <div className="truncate flex-1">
                    <span className="font-medium text-[var(--text-high)]">
                      {codexAccount?.loggedIn ? `已连接本机: ${codexAccount.email}` : '本机 Codex 桥接就绪'}
                    </span>
                  </div>
                </div>

                {/* Model Selector */}
                <div>
                  <div className="flex items-center gap-1 text-[12px] font-medium text-[var(--text-medium)] mb-1">
                    <Cpu size={12} className="text-[var(--accent-text)]" />
                    <span>推理模型</span>
                  </div>
                  <select
                    value={currentModel}
                    onChange={(e) => onUpdateAISettings({ model: e.target.value })}
                    className="w-full px-2 py-1.5 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[12px] text-[var(--text-high)] outline-none cursor-pointer"
                  >
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Cloud Credentials */}
            {(aiSettings.provider === 'openai' || aiSettings.provider === 'deepseek' || aiSettings.provider === 'custom') && (
              <div className="space-y-2 p-2 rounded-md bg-[var(--surface-subtle)] border-hairline border-[var(--border-subtle)]">
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-medium)] mb-1">API Key</label>
                  <div className="relative flex items-center">
                    <Key size={12} className="absolute left-2.5 text-[var(--text-medium)]" />
                    <input
                      type="password"
                      placeholder="sk-..."
                      value={aiSettings.apiKey || ''}
                      onChange={(e) => onUpdateAISettings({ apiKey: e.target.value })}
                      className="w-full pl-7 pr-2.5 py-1 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[12px] text-[var(--text-high)] outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-medium)] mb-1">模型名称</label>
                  <input
                    type="text"
                    placeholder={aiSettings.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'}
                    value={aiSettings.model || ''}
                    onChange={(e) => onUpdateAISettings({ model: e.target.value })}
                    className="w-full px-2.5 py-1 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[12px] text-[var(--text-high)] outline-none"
                  />
                </div>

                {aiSettings.provider === 'custom' && (
                  <div>
                    <label className="block text-[12px] font-medium text-[var(--text-medium)] mb-1">接口 URL</label>
                    <input
                      type="text"
                      placeholder="http://localhost:11434/v1/chat/completions"
                      value={aiSettings.apiEndpoint || ''}
                      onChange={(e) => onUpdateAISettings({ apiEndpoint: e.target.value })}
                      className="w-full px-2.5 py-1 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[12px] text-[var(--text-high)] outline-none"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="h-hairline bg-[var(--border-subtle)]" />

          {/* Custom Grouping Prompt Section */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="font-medium text-[12px] text-[var(--text-medium)]">
                自定义分组提示词
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

            <textarea
              rows={4}
              value={currentPrompt}
              onChange={(e) => onUpdateAISettings({ customPrompt: e.target.value })}
              placeholder="输入自定义标签分组规则..."
              className="w-full p-2 rounded-md bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] focus:border-[var(--accent-border)] text-[12px] text-[var(--text-high)] placeholder-[var(--text-low)] outline-none leading-relaxed resize-y scrollbar-thin transition-colors duration-150 ease-out"
            />
            <div className="text-[12px] text-[var(--text-medium)] mt-1">
              可指定分类偏好（如：按业务项目 KAL / ATK 分组、限制组数、定制组名风格）
            </div>
          </div>
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

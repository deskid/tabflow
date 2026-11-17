import { useEffect, useId, useRef, useState } from 'react';
import { Archive, ChevronRight, RotateCcw } from 'lucide-react';
import { SelectField } from './SelectField';
import { CLEANUP_TIERS, DAY, supportedCleanupProvider } from '../services/cleanup';
import type { CleanupTier } from '../services/cleanup';
import type { AISettings } from '../services/aiGrouper';
import type { CleanupManager } from '../hooks/useCleanup';

export function CleanupSettings({ cleanup, currentModel, onManage }: {
  cleanup: CleanupManager; currentModel: AISettings; onManage: () => void;
}) {
  const id = useId();
  const { config, busy } = cleanup;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(config.prompt || CLEANUP_TIERS[config.tier].prompt);
  useEffect(() => {
    if (document.activeElement !== promptRef.current) setPrompt(config.prompt || CLEANUP_TIERS[config.tier].prompt);
  }, [config.prompt, config.tier]);
  const update = (patch: Parameters<CleanupManager['update']>[0]) => {
    void cleanup.update(patch).catch(() => {});
  };
  const supported = supportedCleanupProvider(currentModel.provider);
  const canEnable = config.mode === 'time' || supported;

  return <section aria-label="自动清理" className="rounded-md bg-[var(--surface)] border-hairline border-[var(--border-subtle)]">
    <div className="flex items-center justify-between gap-2 px-2.5 pt-2.5 pb-2">
      <div className="flex items-center gap-1.5 font-medium text-[13px]"><Archive size={14} />自动清理</div>
      <div className="flex items-center gap-2.5">
        <SelectField aria-label="清理方式" name="cleanup-mode" disabled={busy} value={config.mode}
          containerClassName="w-24 shrink-0" onChange={event => update({ mode: event.target.value as 'ai' | 'time' })}>
          <option value="ai">AI 判断</option><option value="time">按时间</option>
        </SelectField>
        <button type="button" role="switch" aria-label="自动清理" aria-checked={config.enabled}
          disabled={!cleanup.loaded || busy || !config.enabled && !canEnable}
          title={!canEnable ? '请在下方选择 AI 引擎，或切换为按时间清理' : undefined}
          onClick={() => update({ enabled: !config.enabled })}
          className={`w-9 h-5 rounded-full p-0.5 flex items-center shrink-0 disabled:opacity-50 ${config.enabled ? 'bg-[var(--accent-solid)] justify-end' : 'bg-[var(--border-interactive)] justify-start'}`}>
          <span className="w-4 h-4 rounded-full bg-white" />
        </button>
      </div>
    </div>

    <fieldset aria-label={config.mode === 'ai' ? '清理策略' : '闲置时长'} className="grid grid-cols-3 gap-1.5 px-2.5 pb-2.5">
      <legend className="sr-only">{config.mode === 'ai' ? '清理策略' : '闲置时长'}</legend>
      {(Object.entries(CLEANUP_TIERS) as Array<[CleanupTier, typeof CLEANUP_TIERS[CleanupTier]]>).map(([key, tier]) =>
        <label key={key} title={config.mode === 'ai' ? tier.prompt : `${tier.age / DAY} 天未使用后归档`} className="relative min-w-0 cursor-pointer">
          <input type="radio" name={`${id}-tier`} value={key} aria-label={config.mode === 'ai' ? tier.label : `${tier.age / DAY} 天`} checked={config.tier === key} disabled={busy}
            onChange={() => update(config.mode === 'ai' ? { tier: key, prompt: '' } : { tier: key })} className="peer sr-only" />
          <span className="flex flex-col items-center gap-0.5 py-2 rounded-md border-hairline border-[var(--border-subtle)] text-[var(--text-medium)] hover:bg-[var(--surface-hover)] peer-checked:border-[var(--accent-border)] peer-checked:bg-[var(--accent-subtle)] peer-checked:text-[var(--accent-text)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent-solid)] peer-disabled:opacity-50">
            <span className="text-[13px] font-medium">{config.mode === 'ai' ? tier.label : `${tier.age / DAY} 天`}</span>
          </span>
        </label>)}
    </fieldset>

    {config.mode === 'ai' && <div className="px-2.5 pb-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={`${id}-prompt`} className="text-[12px] text-[var(--text-medium)]">提示词</label>
        <button type="button" disabled={busy || !config.prompt} title="恢复当前策略的提示词"
          className="flex items-center gap-1 text-[12px] text-[var(--accent-text)] disabled:opacity-50"
          onClick={() => { setPrompt(CLEANUP_TIERS[config.tier].prompt); update({ prompt: '' }); }}>
          <RotateCcw size={11} />恢复预设
        </button>
      </div>
      <textarea ref={promptRef} id={`${id}-prompt`} aria-label="清理提示词" value={prompt} rows={4} maxLength={4000}
        onChange={event => { setPrompt(event.target.value); update({ prompt: event.target.value }); }}
        onBlur={() => { if (!prompt.trim()) setPrompt(CLEANUP_TIERS[config.tier].prompt); }}
        className="w-full rounded-md border-hairline border-[var(--border-subtle)] bg-[var(--app-bg)] p-2 text-[12px] leading-relaxed text-[var(--text-high)] resize-y focus-visible:outline-2 focus-visible:outline-[var(--accent-solid)]" />
    </div>}

    <button type="button" className="flex w-full items-center justify-between px-2.5 py-2 text-[12px] border-t-hairline border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]" onClick={onManage}>清理管理<ChevronRight size={12} className="text-[var(--text-medium)]" /></button>

    {cleanup.error && <p role="alert" className="px-2.5 pb-2 text-[12px] text-[var(--danger-text)] break-words">{cleanup.error}</p>}
  </section>;
}

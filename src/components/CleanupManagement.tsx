import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Archive, ChevronRight, Info, ListChecks, Shield, X } from 'lucide-react';
import { DAY, normalizeProtectedSite } from '../services/cleanup';
import type { CleanupManager } from '../hooks/useCleanup';

const button = 'px-2 py-1 rounded-md border-hairline border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] disabled:opacity-50 text-[12px]';
const row = 'grid h-10 w-full grid-cols-[16px_minmax(0,1fr)_32px_12px] items-center gap-x-2 px-2.5 text-left text-[13px] hover:bg-[var(--surface-hover)] disabled:opacity-50';
const icon = 'text-[var(--text-medium)]';
const count = 'text-right text-[12px] tabular-nums text-[var(--text-medium)]';

export function CleanupManagement({ cleanup, onBack, onPreview, onOpenArchive }: {
  cleanup: CleanupManager; onBack: () => void; onPreview: () => void; onOpenArchive: () => void;
}) {
  const id = useId();
  const back = useRef<HTMLButtonElement>(null);
  const [site, setSite] = useState('');
  const [siteError, setSiteError] = useState('');
  const { config, busy } = cleanup;
  const waiting = config.enabled && config.notBefore > Date.now();
  const paused = config.pausedUntil > Date.now();
  useEffect(() => { back.current?.focus(); }, []);
  const update = (patch: Parameters<CleanupManager['update']>[0]) => { void cleanup.update(patch).catch(() => {}); };

  return <section aria-label="清理管理">
    <button ref={back} type="button" onClick={onBack} className="mb-3 flex items-center gap-1 rounded-md px-1 py-1 text-[12px] text-[var(--accent-text)] hover:bg-[var(--surface-hover)]"><ArrowLeft size={13} />返回设置</button>
    <div className="overflow-hidden rounded-md border-hairline border-[var(--border-subtle)] bg-[var(--surface)]">
    <div className="flex h-10 items-center justify-between gap-2 px-2.5 text-[12px]">
      <span className="text-[var(--text-medium)]">{!config.enabled ? '自动清理未开启' : paused ? '已暂停' : waiting ? `${new Date(config.notBefore).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 开始` : '自动清理中'}</span>
      {config.enabled && <button type="button" disabled={busy} className="text-[var(--accent-text)] disabled:opacity-50" onClick={() => update({ pausedUntil: paused ? 0 : Date.now() + DAY })}>{paused ? '恢复' : '暂停 24 小时'}</button>}
    </div>

    <button type="button" className={`${row} border-t-hairline border-[var(--border-subtle)]`} disabled={busy || !cleanup.loaded} onClick={onPreview}>
      <ListChecks aria-hidden="true" size={16} strokeWidth={1.5} className={icon} /><span className="truncate">查看清理建议</span><span aria-hidden="true" /><ChevronRight aria-hidden="true" size={12} strokeWidth={1.5} className={icon} />
    </button>
    <details className="group">
      <summary className={`${row} border-t-hairline border-[var(--border-subtle)] cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        <Shield aria-hidden="true" size={16} strokeWidth={1.5} className={icon} /><span className="truncate">保护网站</span>
        <span className={count}>{config.protectedSites.length}</span><ChevronRight aria-hidden="true" size={12} strokeWidth={1.5} className={`${icon} group-open:rotate-90`} />
      </summary>
      <div className="px-2.5 pb-2.5 space-y-2">
        <form aria-label="添加保护网站" className="flex gap-1.5" onSubmit={event => {
          event.preventDefault(); setSiteError('');
          try { const host = normalizeProtectedSite(site); void cleanup.update({ protectedSites: [...config.protectedSites, host] }).then(() => setSite('')).catch(() => {}); }
          catch (error) { setSiteError(error instanceof Error ? error.message : '域名无效。'); document.getElementById(`${id}-site`)?.focus(); }
        }}>
          <label htmlFor={`${id}-site`} className="sr-only">网站域名（包含子域名）</label>
          <input id={`${id}-site`} name="hostname" value={site} onChange={event => { setSite(event.target.value); setSiteError(''); }} placeholder="example.com"
            autoCapitalize="none" autoCorrect="off" spellCheck={false} required aria-invalid={!!siteError} aria-describedby={siteError ? `${id}-site-error` : undefined}
            className="min-w-0 flex-1 px-2 py-1 rounded bg-[var(--app-bg)] border-hairline border-[var(--border-subtle)] text-[12px]" />
          <button type="submit" className={button} disabled={busy}>添加</button>
        </form>
        {siteError && <p id={`${id}-site-error`} role="alert" className="text-[12px] text-[var(--danger-text)]">{siteError}</p>}
        <div className="flex flex-wrap gap-1">{config.protectedSites.map(host => <span key={host} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[12px] bg-[var(--app-bg)] rounded">
          {host}<button type="button" disabled={busy} aria-label={`取消保护 ${host}`} onClick={() => update({ protectedSites: config.protectedSites.filter(site => site !== host) })}><X size={12} /></button>
        </span>)}</div>
      </div>
    </details>

    <button type="button" className={`${row} border-t-hairline border-[var(--border-subtle)]`} onClick={onOpenArchive}>
      <Archive aria-hidden="true" size={16} strokeWidth={1.5} className={icon} /><span className="truncate">归档记录</span><span className={count}>{cleanup.entries.length}</span><ChevronRight aria-hidden="true" size={12} strokeWidth={1.5} className={icon} />
    </button>
      <details className="group">
        <summary aria-label="清理说明" className={`${row} border-t-hairline border-[var(--border-subtle)] cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
          <Info aria-hidden="true" size={16} strokeWidth={1.5} className={icon} /><span className="truncate">清理说明</span><span aria-hidden="true" /><ChevronRight aria-hidden="true" size={12} strokeWidth={1.5} className={`${icon} group-open:rotate-90`} />
        </summary>
        <dl className="space-y-2.5 px-2.5 pb-2.5 text-[12px] leading-relaxed text-[var(--text-medium)]">
          <div>
            <dt className="font-medium text-[var(--text-high)]">清理规则</dt>
            <dd className="mt-0.5">固定、当前选中、正在发声和受保护的标签不会归档。{config.mode === 'ai' ? '最近 1 小时使用过的标签也会保留，其余按提示词判断。' : '其余标签达到所选闲置时长后归档。'}</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--text-high)]">网站保护</dt>
            <dd className="mt-0.5">添加域名后，该网站及其子域名均受保护。</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--text-high)]">数据使用</dt>
            <dd className="mt-0.5">AI 根据标题、网址等标签信息判断，不读取网页正文。网址会移除查询参数和片段。</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--text-high)]">归档恢复</dt>
            <dd className="mt-0.5">记录仅保存在本机，可重新打开页面；未保存的输入不保证恢复。</dd>
          </div>
        </dl>
      </details>
    </div>
    {config.enabled && !busy && !cleanup.error && cleanup.status.message && <p role="status" className="pt-2 text-[12px] text-[var(--text-medium)] break-words">{cleanup.status.message}</p>}
    {cleanup.error && <p role="alert" className="pt-2 text-[12px] text-[var(--danger-text)] break-words">{cleanup.error}</p>}
  </section>;
}

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';
import type { CleanupPlan, CleanupPreviewPage } from '../services/cleanup';
import type { CleanupManager } from '../hooks/useCleanup';

const filters = [
  { id: 'all', label: '全部' }, { id: 'archive', label: '建议归档' },
  { id: 'keep', label: '保留' }, { id: 'pending', label: '待判断' },
] as const;
const labels = { archive: '归档', keep: '保留', pending: '待判断' };
const colors = { archive: 'text-[var(--accent-text)]', keep: 'text-[var(--text-medium)]', pending: 'text-[var(--warning-text)]' };
const order = { archive: 0, keep: 1, pending: 2 };

export function CleanupPreview({ plan, cleanup, onBack, onRefresh }: {
  plan?: CleanupPlan; cleanup: CleanupManager; onBack: () => void; onRefresh: () => void;
}) {
  const id = useId();
  const back = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<'all' | CleanupPreviewPage['action']>('all');
  useEffect(() => { back.current?.focus(); }, []);
  const pages = plan?.pages ?? cleanup.previewPages ?? [];
  const hasPages = plan !== undefined || cleanup.previewPages !== undefined;
  const counts = { all: pages.length, archive: 0, keep: 0, pending: 0 };
  for (const page of pages) counts[page.action]++;
  const visible = pages.filter(page => filter === 'all' || page.action === filter).sort((a, b) => order[a.action] - order[b.action]);

  return <section aria-label="全部页面清理建议">
    <div className="sticky top-0 z-10 bg-[var(--app-bg)] pb-2">
      <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
        <button ref={back} type="button" onClick={onBack} className="flex items-center gap-1 rounded-md px-1 py-1 text-[var(--accent-text)] hover:bg-[var(--surface-hover)]"><ArrowLeft size={13} />返回清理管理</button>
        <span className="text-[var(--text-medium)]">全部窗口</span>
        <button type="button" disabled={cleanup.busy} onClick={onRefresh} className="flex items-center gap-1 rounded-md px-1 py-1 text-[var(--accent-text)] hover:bg-[var(--surface-hover)] disabled:opacity-50"><RefreshCw size={12} />重新分析</button>
      </div>
      {hasPages && <fieldset aria-label="筛选清理结果" className="grid grid-cols-4 gap-1 rounded-md bg-[var(--surface)] p-1">
        <legend className="sr-only">筛选清理结果</legend>
        {filters.map(item => <label key={item.id} className="min-w-0 cursor-pointer">
          <input type="radio" name={`${id}-filter`} value={item.id} checked={filter === item.id} onChange={() => setFilter(item.id)} className="peer sr-only" />
          <span className="flex flex-col items-center gap-0.5 rounded px-1 py-1.5 text-[var(--text-medium)] peer-checked:bg-[var(--app-bg)] peer-checked:text-[var(--accent-text)] peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent-solid)]">
            <span className="whitespace-nowrap text-[12px]">{item.label}</span><span className="text-[14px] font-medium">{counts[item.id]}</span>
          </span>
        </label>)}
      </fieldset>}
    </div>

    {cleanup.error && <p role="alert" className="mb-3 break-words text-[12px] text-[var(--danger-text)]">{cleanup.error}</p>}
    {cleanup.busy && <div role="status" className="flex items-center gap-1.5 px-1 py-2 text-[12px] text-[var(--text-medium)]">
      <LoaderCircle aria-hidden="true" size={12} className="animate-spin motion-reduce:animate-none" />{hasPages ? cleanup.status.message.startsWith('AI 判断中') ? cleanup.status.message : '正在分析…' : '正在读取页面…'}
    </div>}
    {hasPages && <ul className="divide-y-[0.5px] divide-[var(--border-subtle)]">
      {visible.map(page => <li key={page.id} data-cleanup-action={page.action}>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md px-1 py-2.5 hover:bg-[var(--surface-hover)] [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-[var(--text-high)] group-open:whitespace-normal group-open:break-words">{page.title}</span>
              <span className="mt-0.5 block truncate text-[12px] text-[var(--text-medium)] group-open:hidden">{page.reason}</span>
            </span>
            <span className={`flex shrink-0 items-center gap-1 pt-0.5 text-[12px] ${colors[page.action]}`}>{labels[page.action]}<ChevronRight aria-hidden="true" size={12} className="group-open:rotate-90" /></span>
          </summary>
          <p className="px-1 pb-2.5 text-[12px] leading-relaxed text-[var(--text-medium)] break-words">{page.reason}</p>
          <p className="select-text break-all px-1 pb-2.5 text-[12px] text-[var(--text-medium)]">{page.url}</p>
        </details>
      </li>)}
    </ul>}
    {hasPages && !visible.length && <p className="py-12 text-center text-[12px] text-[var(--text-medium)]">{pages.length ? '此分类下没有页面' : '没有打开的页面'}</p>}
  </section>;
}

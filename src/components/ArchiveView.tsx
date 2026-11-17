import { useState } from 'react';
import { ArrowLeft, Archive, Download, RotateCcw, Trash2 } from 'lucide-react';
import type { CleanupManager } from '../hooks/useCleanup';
import { CLEANUP_TIERS } from '../services/cleanup';

const button = 'px-2 py-1 text-[12px] rounded-md border-hairline border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] disabled:opacity-50';
export function ArchiveView({ cleanup, windowId, onBack, backLabel = '返回标签' }: { cleanup: CleanupManager; windowId: number | null; onBack: () => void; backLabel?: string }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const entries = cleanup.entries.filter(entry => `${entry.title} ${entry.url} ${entry.task}`.toLowerCase().includes(query.toLowerCase()));
  const ids = selected.filter(id => cleanup.entries.some(entry => entry.id === id));
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = `${new Date(entry.archivedAt).toLocaleDateString('zh-CN')} / ${entry.task}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const restore = (restoreIds: string[], newWindow = false) => { void cleanup.restore(restoreIds, windowId ?? undefined, newWindow).then(() => setSelected([])).catch(() => {}); };
  return <div className="flex flex-col h-full text-[13px]">
    <div className="flex items-center justify-between gap-2 py-2">
      <button type="button" className={`${button} flex items-center gap-1`} onClick={onBack}><ArrowLeft size={13} />{backLabel}</button>
      <span className="font-medium">归档记录 ({cleanup.entries.length})</span>
      <button type="button" className={button} disabled={!entries.length} title="导出当前搜索结果" onClick={() => {
        const blob = new Blob([entries.map(entry => `# ${entry.task}\n${entry.title.replace(/[\r\n]/g, ' ')}\n${entry.url}`).join('\n\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tabflow-archive.txt'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}><Download size={13} /></button>
    </div>
    <input aria-label="搜索归档" placeholder="搜索标题、网址或任务" value={query} onChange={event => setQuery(event.target.value)}
      className="w-full px-2.5 py-1.5 mb-2 rounded-md bg-[var(--surface)] border-hairline border-[var(--border-subtle)] outline-none text-[13px]" />
    <div className="flex flex-wrap items-center gap-1.5 mb-2">
      <button type="button" className={button} disabled={!entries.length} onClick={() => setSelected(entries.map(entry => entry.id))}>选择搜索结果</button>
      <button type="button" className={button} disabled={!ids.length || cleanup.busy || windowId === null} onClick={() => restore(ids)}>打开所选 ({ids.length})</button>
      <button type="button" className={button} disabled={!ids.length || cleanup.busy} onClick={() => restore(ids, true)}>在新窗口打开</button>
      <button type="button" className={button} disabled={!ids.length || cleanup.busy} onClick={() => setConfirmDelete(true)}><Trash2 size={12} /></button>
    </div>
    {confirmDelete && <div role="alert" className="p-2 mb-2 text-[12px] border-hairline border-[var(--border-subtle)] rounded">
      <p>删除所选 {ids.length} 条归档记录？删除后无法从 TabFlow 找回。</p>
      <button type="button" className={`${button} mt-1 mr-2 text-[var(--danger-text)]`} onClick={() => { void cleanup.remove(ids).then(() => { setSelected([]); setConfirmDelete(false); }).catch(() => {}); }}>删除记录</button>
      <button type="button" className={button} onClick={() => setConfirmDelete(false)}>取消</button>
    </div>}
    {cleanup.error && <p role="alert" className="text-[12px] text-[var(--danger-text)] mb-2">{cleanup.error}</p>}
    {cleanup.busy && <p role="status" className="text-[12px] text-[var(--text-medium)] mb-2">正在处理归档…</p>}
    {!entries.length && <div className="py-10 text-center text-[var(--text-medium)]"><Archive size={24} className="mx-auto mb-2" /><p>{query ? '未找到匹配记录' : '归档的标签会保存在这里'}</p></div>}
    {[...groups].map(([key, items]) => <section key={key} className="mb-3">
      <div className="flex items-center justify-between gap-2 py-1 border-b-hairline border-[var(--border-subtle)]">
        <span className="text-[12px] font-medium truncate">{key} ({items.length})</span>
        <button type="button" className="text-[12px] text-[var(--accent-text)] shrink-0 disabled:opacity-50" disabled={cleanup.busy || windowId === null} onClick={() => restore(items.map(entry => entry.id))}>打开这组</button>
      </div>
      {items.map(entry => <div key={entry.id} className="flex items-start gap-2 py-2">
        <input type="checkbox" aria-label={`选择 ${entry.title}`} checked={ids.includes(entry.id)} onChange={event => setSelected(event.target.checked ? [...ids, entry.id] : ids.filter(id => id !== entry.id))} className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="truncate" title={entry.url}>{entry.title}</p>
          <p className="text-[12px] text-[var(--text-medium)] truncate">{new URL(entry.url).hostname}{entry.groupTitle ? ` / ${entry.groupTitle}` : ''}</p>
          <p className="text-[12px] text-[var(--text-medium)] break-words">{entry.reason}</p>
          <p className="text-[12px] text-[var(--text-low)] truncate">{CLEANUP_TIERS[entry.tier].label} / {entry.model}{entry.state === 'pending' ? ' / 处理中断，记录已保留' : ''}</p>
        </div>
        <button type="button" className={button} title="打开标签" disabled={cleanup.busy || windowId === null} onClick={() => restore([entry.id])}><RotateCcw size={13} /></button>
      </div>)}
    </section>)}
    <p className="text-[12px] text-[var(--text-low)] py-2">记录仅保存在本机，卸载扩展会删除。恢复的标签本次会话不再自动清理。</p>
  </div>;
}

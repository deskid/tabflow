import { useEffect, useSyncExternalStore } from 'react';
import { CheckCircle2, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  cancelBuiltinModel, checkBuiltinModel, getBuiltinModelState,
  prepareBuiltinModel, subscribeBuiltinModel,
} from '../services/builtinModel';

export function BuiltinModelStatus({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(subscribeBuiltinModel, getBuiltinModelState);
  const busy = state.busy === true;

  useEffect(() => {
    if (!compact && state.status === 'unchecked') void checkBuiltinModel().catch(() => {});
  }, [compact, state.status]);

  const labels: Record<typeof state.status, string> = {
    unchecked: '等待检测', checking: '正在检测', unsupported: '浏览器不支持',
    unavailable: '模型当前不可用', downloadable: '模型待下载', downloading: '正在下载模型',
    preparing: '正在初始化模型', downloaded: '已下载，待初始化', ready: '已就绪', generating: '正在分类', error: '初始化或分类失败',
  };
  const progress = state.progress === undefined ? undefined : Math.round(state.progress * 100);
  const classifiedProgress = state.totalTabs && ['generating', 'preparing'].includes(state.status)
    ? ` ${state.completedTabs || 0}/${state.totalTabs}` : '';
  const primaryAction = state.status === 'downloadable' || state.status === 'downloaded' || (state.status === 'downloading' && !busy);

  return (
    <div className={`space-y-2 text-[12px] ${compact ? 'px-3 py-2 border-b-hairline border-[var(--border-subtle)]' : 'p-3 rounded-lg border-hairline border-[var(--border-subtle)] bg-[var(--surface)]'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[var(--text-medium)]" role="status" aria-live="polite">
          {(busy || state.status === 'checking') ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> :
            state.status === 'ready' ? <CheckCircle2 size={14} className="text-[var(--success-text)]" /> : null}
          <span>{compact ? '' : 'Gemini Nano，'}{labels[state.status]}{state.status === 'downloading' && progress !== undefined ? ` ${progress}%` : classifiedProgress}</span>
        </div>
        {busy ? (
          <button type="button" onClick={cancelBuiltinModel} className="shrink-0 text-[var(--accent-text)]">取消</button>
        ) : (
          <button type="button" disabled={state.status === 'checking'}
            onClick={() => { void (primaryAction ? prepareBuiltinModel() : checkBuiltinModel()).catch(() => {}); }}
            title={primaryAction ? '下载或重新准备模型' : '重新检测'}
            className="flex shrink-0 items-center gap-1 text-[var(--accent-text)] disabled:opacity-50">
            {primaryAction ? <Download size={13} /> : <RefreshCw size={13} />}
            {primaryAction ? (state.status === 'downloaded' ? '启用模型' : state.status === 'downloading' ? '继续下载' : '下载模型') : state.status === 'error' ? '重新检测' : '检测'}
          </button>
        )}
      </div>
      {state.status === 'downloading' && <progress aria-label="模型下载进度" max={1}
        value={state.progress} className="block w-full h-1.5 accent-[var(--accent-solid)]" />}
      {!compact && ['downloadable', 'downloaded', 'ready'].includes(state.status) && <p className="text-[var(--text-medium)]">
        {state.checkedEnglish ? '英文运行测试已通过，使用英文组名' : state.status === 'ready' ? '模型已可运行，使用英文组名' : '英文模式；下载完成后将验证模型运行'}
      </p>}
      {state.error && <p role="alert" className="break-words text-[var(--text-medium)]">{state.error}</p>}
      {!compact && state.notices?.map((notice) => <p key={notice} className="text-[var(--text-medium)]">{notice}</p>)}
      {!compact && state.diagnostic && <details className="text-[var(--text-medium)]">
        <summary className="cursor-pointer">技术详情</summary>
        <div className="mt-1 select-text break-words whitespace-pre-wrap">
          {state.diagnostic.stage} / {state.diagnostic.name}{'\n'}{state.diagnostic.message}
        </div>
      </details>}
    </div>
  );
}

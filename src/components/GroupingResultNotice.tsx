import { X } from 'lucide-react';
import type { GroupingExecutionResult } from '../hooks/useTabsManager';

interface Props {
  result: GroupingExecutionResult;
  onSettings: () => void;
  onDismiss: () => void;
}

const ENGINE_NAMES = {
  codex_native: '本机 Codex', chrome_builtin: 'Chrome 端侧模型', custom: '自定义 API',
  openai: 'OpenAI', deepseek: 'DeepSeek', heuristic: '本地规则',
};

export function GroupingResultNotice({ result, onSettings, onDismiss }: Props) {
  const fallback = result.method === 'domain';
  const partial = result.groupCount < result.proposedGroupCount;
  const method = fallback ? '域名分组' : result.method === 'local-rules' ? '本地规则' : ENGINE_NAMES[result.provider];
  const title = result.groupCount > 0
    ? `${method}：已创建 ${result.groupCount} 个组`
    : result.proposedGroupCount > 0 ? `${method}：未能创建分组` : `${method}：没有可合并的标签`;

  return (
    <div role="status" aria-live="polite" className="px-3 py-2 space-y-1 text-[12px] border-b-hairline border-[var(--border-subtle)] bg-[var(--surface)]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[var(--text-high)]">{title}</span>
        <button type="button" onClick={onDismiss} aria-label="关闭分组结果" className="shrink-0 p-1 text-[var(--text-medium)]"><X size={13} /></button>
      </div>
      {fallback && <p className="break-words text-[var(--text-medium)]">
        {ENGINE_NAMES[result.provider]}未能完成分类，已改用域名规则。{result.fallbackReason}
      </p>}
      {result.notices?.map((notice) => <p key={notice} className="break-words text-[var(--text-medium)]">{notice}</p>)}
      {partial && <p className="text-[var(--text-medium)]">计划创建 {result.proposedGroupCount} 个组，部分标签未能移动。</p>}
      {fallback && result.proposedGroupCount === 0 && <p className="text-[var(--text-medium)]">没有找到同域名标签，本次未调整分组。</p>}
      {(fallback || partial) && <button type="button" onClick={onSettings} className="text-[var(--accent-text)]">检查分类引擎</button>}
    </div>
  );
}

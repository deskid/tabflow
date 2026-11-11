import React from 'react';
import { Plus, CopyX } from 'lucide-react';

interface StatusBarProps {
  totalTabs: number;
  discardedCount: number;
  duplicateCount: number;
  onNewTab: () => void;
  onCleanDuplicates: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  totalTabs,
  discardedCount,
  duplicateCount,
  onNewTab,
  onCleanDuplicates,
}) => {
  return (
    <div className="shrink-0 h-9 px-2.5 flex items-center justify-between border-t-hairline border-[var(--border-subtle)] bg-[var(--app-bg)] text-[12px] text-[var(--text-medium)] select-none">
      <div className="flex items-center gap-2 truncate">
        <span>{totalTabs} 个标签</span>

        {discardedCount > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--text-medium)] text-[12px]">
            {discardedCount} 个休眠
          </span>
        )}

        {duplicateCount > 0 && (
          <button
            type="button"
            onClick={onCleanDuplicates}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--warning-subtle)] text-[var(--warning-text)] border-hairline border-[var(--warning-border)] hover:bg-[var(--surface-hover)] text-[12px] transition-colors duration-150 ease-out"
            title="关闭相同网址的重复标签"
          >
            <CopyX size={12} className="shrink-0" />
            <span>清理重复 ({duplicateCount})</span>
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onNewTab}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--surface)] hover:bg-[var(--surface-hover)] border-hairline border-[var(--border-subtle)] text-[var(--text-high)] font-medium text-[12px] transition-colors duration-150 ease-out"
        title="新建标签页"
      >
        <Plus size={13} className="shrink-0" />
        <span>新建</span>
      </button>
    </div>
  );
};

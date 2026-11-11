import React from 'react';
import { RotateCcw, X, CheckCircle2 } from 'lucide-react';

interface UndoToastProps {
  visible: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

export const UndoToast: React.FC<UndoToastProps> = ({ visible, onUndo, onDismiss }) => {
  if (!visible) return null;

  return (
    <div className="absolute bottom-11 left-2.5 right-2.5 z-50 animate-in slide-in-from-bottom-2 duration-200 ease-out">
      <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[var(--app-bg)] border-hairline border-[var(--border-interactive)] shadow-sm text-[12px]">
        {/* Left Status Message */}
        <div className="flex items-center gap-1.5 min-w-0">
          <CheckCircle2 size={14} className="text-[var(--accent-text)] shrink-0" />
          <span className="font-medium text-[var(--text-high)] truncate">已完成分组</span>
        </div>

        {/* Right Action Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onUndo}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--accent-subtle)] text-[var(--accent-text)] hover:bg-[var(--surface-hover)] border-hairline border-[var(--accent-border)] font-medium transition-colors duration-150 ease-out cursor-pointer"
          >
            <RotateCcw size={12} className="shrink-0" />
            <span>撤销</span>
          </button>

          {/* Generous 28x28 hit area for easy clicking */}
          <button
            type="button"
            onClick={onDismiss}
            title="关闭通知"
            className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-medium)] hover:text-[var(--text-high)] hover:bg-[var(--surface-hover)] transition-colors duration-150 ease-out cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};

import React from 'react';
import { FolderPlus, VolumeX, Pin, Trash2, X } from 'lucide-react';

interface FloatingActionBarProps {
  selectedCount: number;
  onGroupSelected: () => void;
  onCloseSelected: () => void;
  onMuteSelected: () => void;
  onPinSelected: () => void;
  onClearSelection: () => void;
}

export const FloatingActionBar: React.FC<FloatingActionBarProps> = ({
  selectedCount,
  onGroupSelected,
  onCloseSelected,
  onMuteSelected,
  onPinSelected,
  onClearSelection,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className="absolute bottom-12 left-2.5 right-2.5 z-40 animate-in slide-in-from-bottom-2 duration-200 ease-out">
      <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[var(--slate-12)] text-[var(--slate-1)] border-hairline border-[var(--slate-8)] shadow-sm">
        <div className="flex items-center gap-1.5 text-[12px] font-medium">
          <span className="w-4 h-4 rounded-full bg-[var(--accent-solid)] flex items-center justify-center text-[12px] font-semibold text-white">
            {selectedCount}
          </span>
          <span>已选</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onGroupSelected}
            title="成组"
            className="p-1 rounded-md hover:bg-[var(--slate-11)]/20 transition-colors duration-150 ease-out"
          >
            <FolderPlus size={14} />
          </button>

          <button
            type="button"
            onClick={onMuteSelected}
            title="静音"
            className="p-1 rounded-md hover:bg-[var(--slate-11)]/20 transition-colors duration-150 ease-out"
          >
            <VolumeX size={14} />
          </button>

          <button
            type="button"
            onClick={onPinSelected}
            title="固定"
            className="p-1 rounded-md hover:bg-[var(--slate-11)]/20 transition-colors duration-150 ease-out"
          >
            <Pin size={14} />
          </button>

          <button
            type="button"
            onClick={onCloseSelected}
            title="关闭"
            className="p-1 rounded-md hover:bg-[var(--danger-solid)] text-[var(--red-9)] hover:text-white transition-colors duration-150 ease-out"
          >
            <Trash2 size={14} />
          </button>

          <div className="w-hairline h-3.5 bg-[var(--slate-9)] mx-0.5" />

          <button
            type="button"
            onClick={onClearSelection}
            title="取消"
            className="p-1 rounded-md hover:bg-[var(--slate-11)]/20 text-[var(--slate-9)] hover:text-[var(--slate-1)] transition-colors duration-150 ease-out"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

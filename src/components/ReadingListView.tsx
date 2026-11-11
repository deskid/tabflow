import React from 'react';
import { CheckCircle2, Circle, Trash2, Plus } from 'lucide-react';
import { FaviconImage } from './FaviconImage';
import { ReadingEntry } from '../hooks/useReadingList';

interface ReadingListViewProps {
  entries: ReadingEntry[];
  unreadEntries: ReadingEntry[];
  readEntries: ReadingEntry[];
  isSupported: boolean;
  onAddCurrentTab: () => void;
  onToggleRead: (entry: ReadingEntry) => void;
  onRemove: (url: string) => void;
  onOpen: (url: string, newTab?: boolean) => void;
}

export const ReadingListView: React.FC<ReadingListViewProps> = ({
  unreadEntries,
  readEntries,
  isSupported,
  onAddCurrentTab,
  onToggleRead,
  onRemove,
  onOpen,
}) => {
  if (!isSupported) {
    return (
      <div className="p-6 text-center text-[12px] text-[var(--text-medium)]">
        当前环境不支持 Reading List API
      </div>
    );
  }

  return (
    <div className="p-2 space-y-3">
      {/* Quick Add Button */}
      <button
        type="button"
        onClick={onAddCurrentTab}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-md bg-[var(--surface)] hover:bg-[var(--surface-hover)] border-hairline border-[var(--border-subtle)] text-[var(--accent-text)] text-[12px] font-medium transition-colors duration-150 ease-out"
      >
        <Plus size={13} className="shrink-0" />
        <span>添加当前标签页至稍后读</span>
      </button>

      {/* Unread Section */}
      <div>
        <div className="text-[12px] font-medium text-[var(--text-medium)] mb-1.5 flex items-center justify-between">
          <span>未读 ({unreadEntries.length})</span>
        </div>

        {unreadEntries.length === 0 ? (
          <div className="p-3 text-center text-[12px] text-[var(--text-medium)] bg-[var(--surface)] rounded-md">
            暂无未读内容
          </div>
        ) : (
          <div className="space-y-0.5">
            {unreadEntries.map((item) => (
              <div
                key={item.url}
                onClick={() => {
                  onOpen(item.url);
                  onToggleRead(item);
                }}
                className="group flex items-center justify-between px-2 py-1.5 rounded-md bg-[var(--app-bg)] hover:bg-[var(--surface)] border-hairline border-[var(--border-subtle)] hover:border-[var(--accent-border)] cursor-pointer text-[13px] text-[var(--text-high)] transition-colors duration-150 ease-out"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <FaviconImage url={item.url} size={15} />
                  <div className="truncate">
                    <div className="font-normal truncate">{item.title || item.url}</div>
                    <div className="text-[12px] text-[var(--text-medium)] truncate">{item.url}</div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => onToggleRead(item)}
                    title="标记已读"
                    className="p-1 rounded text-[var(--text-medium)] hover:text-[var(--success-text)]"
                  >
                    <Circle size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(item.url)}
                    title="移除"
                    className="p-1 rounded text-[var(--text-medium)] hover:text-[var(--danger-text)] opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Read Section */}
      {readEntries.length > 0 && (
        <div>
          <div className="text-[12px] font-medium text-[var(--text-medium)] mb-1.5 flex items-center justify-between">
            <span>已读 ({readEntries.length})</span>
          </div>

          <div className="space-y-0.5">
            {readEntries.map((item) => (
              <div
                key={item.url}
                onClick={() => onOpen(item.url)}
                className="group flex items-center justify-between px-2 py-1.5 rounded-md bg-[var(--surface-subtle)] hover:bg-[var(--surface)] border-hairline border-transparent hover:border-[var(--border-subtle)] cursor-pointer text-[13px] text-[var(--text-medium)] hover:text-[var(--text-high)] transition-colors duration-150 ease-out"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <FaviconImage url={item.url} size={14} />
                  <span className="truncate">{item.title || item.url}</span>
                </div>

                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => onToggleRead(item)}
                    title="标记未读"
                    className="p-1 rounded text-[var(--success-text)] hover:text-[var(--text-medium)]"
                  >
                    <CheckCircle2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(item.url)}
                    title="移除"
                    className="p-1 rounded text-[var(--text-medium)] hover:text-[var(--danger-text)] opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

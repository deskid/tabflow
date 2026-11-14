import React, { useRef, useEffect } from 'react';
import { Search, Sparkles, ExternalLink, Settings, X } from 'lucide-react';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onTriggerAI: () => void;
  onOpenStandalone: () => void;
  onOpenSettings: () => void;
  isGrouping: boolean;
  groupingLabel?: string;
  targetAvailable?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  searchQuery,
  onSearchChange,
  onTriggerAI,
  onOpenStandalone,
  onOpenSettings,
  isGrouping,
  groupingLabel,
  targetAvailable = true,
}) => {
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global shortcut to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'p')) && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="shrink-0 p-2.5 pb-2 border-b-hairline border-[var(--border-subtle)] bg-[var(--app-bg)]">
      {/* Top Bar: Title & Primary Actions */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <img
            src={chrome.runtime.getURL ? chrome.runtime.getURL("icons/icon48.png") : "icons/icon48.png"}
            alt="TabFlow"
            className="w-5 h-5 rounded-md shrink-0 shadow-2xs"
          />
          <span className="font-semibold text-[14px] text-[var(--text-high)] tracking-tight">
            TabFlow
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={isGrouping || !targetAvailable}
            onClick={onTriggerAI}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--surface)] hover:bg-[var(--surface-hover)] border-hairline border-[var(--border-subtle)] text-[var(--accent-text)] text-[12px] font-medium transition-colors duration-200 ease-out disabled:opacity-60"
            title="使用当前分类引擎整理标签页"
            aria-busy={isGrouping}
          >
            <Sparkles size={12} className={isGrouping ? 'animate-spin' : ''} />
            <span>{isGrouping ? (groupingLabel || '整理中') : '智能分组'}</span>
          </button>

          {/* Standalone Window Detach */}
          <button
            type="button"
            onClick={onOpenStandalone}
            disabled={!targetAvailable}
            title="独立窗口打开"
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-medium)] hover:text-[var(--text-high)] transition-colors duration-150 ease-out"
          >
            <ExternalLink size={14} />
          </button>

          {/* Settings */}
          <button
            type="button"
            onClick={onOpenSettings}
            title="设置"
            className="p-1 rounded-md hover:bg-[var(--surface-hover)] text-[var(--text-medium)] hover:text-[var(--text-high)] transition-colors duration-150 ease-out"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative flex items-center">
        <Search size={14} className="absolute left-2.5 text-[var(--text-low)] pointer-events-none shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onSearchChange('');
              searchInputRef.current?.blur();
            }
          }}
          placeholder="搜索标签页、书签"
          className="w-full pl-8 pr-8 py-1 rounded-md bg-[var(--surface)] border-hairline border-transparent focus:border-[var(--accent-border)] text-[13px] text-[var(--text-high)] placeholder-[var(--text-low)] outline-none transition-colors duration-200 ease-out"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 p-0.5 rounded text-[var(--text-medium)] hover:text-[var(--text-high)]"
          >
            <X size={13} />
          </button>
        ) : (
          <span className="absolute right-2 text-[12px] font-mono px-1 py-0.2 rounded bg-[var(--surface-hover)] text-[var(--text-medium)] pointer-events-none">
            /
          </span>
        )}
      </div>
    </div>
  );
};

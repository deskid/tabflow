import React, { useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Trash2, FolderMinus, BookmarkPlus } from 'lucide-react';
import { ChromeGroupColor, CHROME_GROUP_COLORS } from '../services/aiGrouper';
import { TabGroupData } from '../hooks/useTabsManager';

interface TabGroupHeaderProps {
  group: TabGroupData;
  tabCount: number;
  onToggleCollapse: (groupId: number, currentCollapsed: boolean) => void;
  onUpdateGroup: (groupId: number, updates: { title?: string; color?: ChromeGroupColor }) => void;
  onCloseGroup: (groupId: number) => void;
  onUngroup: (groupId: number) => void;
  onAddTabInGroup: (groupId: number) => void;
  onSaveAsBookmarkFolder: (groupTitle: string, groupId: number) => void;
}

const RADIX_COLOR_MAP: Record<ChromeGroupColor, { bg: string; border: string; text: string; badge: string }> = {
  grey: { bg: 'bg-[var(--slate-3)]', border: 'border-[var(--slate-6)]', text: 'text-[var(--slate-12)]', badge: 'bg-[var(--slate-9)]' },
  blue: { bg: 'bg-[var(--blue-3)]', border: 'border-[var(--blue-6)]', text: 'text-[var(--blue-11)]', badge: 'bg-[var(--blue-9)]' },
  red: { bg: 'bg-[var(--red-3)]', border: 'border-[var(--red-6)]', text: 'text-[var(--red-11)]', badge: 'bg-[var(--red-9)]' },
  yellow: { bg: 'bg-[var(--amber-3)]', border: 'border-[var(--amber-6)]', text: 'text-[var(--amber-11)]', badge: 'bg-[var(--amber-9)]' },
  green: { bg: 'bg-[var(--green-3)]', border: 'border-[var(--green-6)]', text: 'text-[var(--green-11)]', badge: 'bg-[var(--green-9)]' },
  pink: { bg: 'bg-[var(--pink-3)]', border: 'border-[var(--pink-6)]', text: 'text-[var(--pink-11)]', badge: 'bg-[var(--pink-9)]' },
  purple: { bg: 'bg-[var(--purple-3)]', border: 'border-[var(--purple-6)]', text: 'text-[var(--purple-11)]', badge: 'bg-[var(--purple-9)]' },
  cyan: { bg: 'bg-[var(--cyan-3)]', border: 'border-[var(--cyan-6)]', text: 'text-[var(--cyan-11)]', badge: 'bg-[var(--cyan-9)]' },
};

export const TabGroupHeader: React.FC<TabGroupHeaderProps> = ({
  group,
  tabCount,
  onToggleCollapse,
  onUpdateGroup,
  onCloseGroup,
  onUngroup,
  onAddTabInGroup,
  onSaveAsBookmarkFolder,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempTitle, setTempTitle] = useState(group.title || '');
  const [showMenu, setShowMenu] = useState(false);

  const colors = RADIX_COLOR_MAP[group.color] || RADIX_COLOR_MAP.grey;

  const handleTitleSubmit = () => {
    setIsEditing(false);
    if (tempTitle.trim() !== group.title) {
      onUpdateGroup(group.id, { title: tempTitle.trim() || '未命名分组' });
    }
  };

  return (
    <div className="relative mt-2 mb-1">
      <div
        className={`group flex items-center justify-between px-2 py-1 rounded-md border-hairline cursor-pointer select-none transition-colors duration-150 ease-out ${colors.bg} ${colors.border}`}
        onClick={() => onToggleCollapse(group.id, group.collapsed)}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[var(--text-medium)] flex items-center shrink-0">
            {group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>

          <span className={`w-2 h-2 rounded-full shrink-0 ${colors.badge}`} />

          {isEditing ? (
            <input
              type="text"
              autoFocus
              value={tempTitle}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setTempTitle(e.target.value)}
              onBlur={handleTitleSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTitleSubmit();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              className="text-[12px] px-1 py-0.5 rounded bg-[var(--app-bg)] border-hairline border-[var(--accent-border)] text-[var(--text-high)] outline-none flex-1 max-w-[140px]"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              className={`text-[13px] font-medium truncate ${colors.text}`}
            >
              {group.title || '未命名分组'}
            </span>
          )}

          <span className="text-[12px] font-normal text-[var(--text-medium)] shrink-0">
            ({tabCount})
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onAddTabInGroup(group.id)}
            title="在组内新建标签"
            className="p-1 rounded text-[var(--text-medium)] hover:text-[var(--text-high)] hover:bg-[var(--surface-hover)] opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out"
          >
            <Plus size={13} />
          </button>

          <button
            type="button"
            onClick={() => setShowMenu(!showMenu)}
            title="分组选项"
            className="p-1 rounded text-[var(--text-medium)] hover:text-[var(--text-high)] hover:bg-[var(--surface-hover)] transition-colors duration-150 ease-out"
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
      </div>

      {/* Menu */}
      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg bg-[var(--app-bg)] border-hairline border-[var(--border-interactive)] p-1 text-[12px] text-[var(--text-high)] shadow-xs animate-in fade-in duration-150 ease-out">
            {/* Color Palette */}
            <div className="flex items-center justify-between p-1.5 pb-2">
              {CHROME_GROUP_COLORS.map((col) => (
                <button
                  key={col}
                  type="button"
                  onClick={() => onUpdateGroup(group.id, { color: col })}
                  className={`w-3.5 h-3.5 rounded-full transition-transform hover:scale-115 ${
                    RADIX_COLOR_MAP[col].badge
                  } ${group.color === col ? 'ring-2 ring-offset-1 ring-[var(--slate-8)]' : ''}`}
                />
              ))}
            </div>

            <div className="h-hairline bg-[var(--border-subtle)] my-1" />

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                setIsEditing(true);
                setShowMenu(false);
              }}
            >
              <span>重命名</span>
            </button>

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onSaveAsBookmarkFolder(group.title || '标签组保存', group.id);
                setShowMenu(false);
              }}
            >
              <span>存为书签文件夹</span>
              <BookmarkPlus size={13} className="text-[var(--text-medium)]" />
            </button>

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onUngroup(group.id);
                setShowMenu(false);
              }}
            >
              <span>解散分组</span>
              <FolderMinus size={13} className="text-[var(--text-medium)]" />
            </button>

            <div className="h-hairline bg-[var(--border-subtle)] my-1" />

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--danger-subtle)] text-[var(--danger-text)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onCloseGroup(group.id);
                setShowMenu(false);
              }}
            >
              <span>关闭整组</span>
              <Trash2 size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

import React, { useState } from 'react';
import { Volume2, VolumeX, Moon, Pin, X, CheckSquare, Square } from 'lucide-react';
import { FaviconImage } from './FaviconImage';

interface TabItemProps {
  tab: chrome.tabs.Tab;
  isActive: boolean;
  isSelected: boolean;
  density: 'comfortable' | 'compact';
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onToggleSelect: (tabId: number) => void;
  onToggleMute: (tabId: number, currentMuted?: boolean) => void;
  onTogglePin: (tabId: number, currentPinned?: boolean) => void;
  onDiscard: (tabId: number) => void;
  onDuplicate: (tabId: number) => void;
  onDragStart: (e: React.DragEvent, tabId: number) => void;
  onDragOver: (e: React.DragEvent, tabId: number) => void;
  onDrop: (e: React.DragEvent, tabId: number) => void;
}

export const TabItem: React.FC<TabItemProps> = ({
  tab,
  isActive,
  isSelected,
  density,
  onActivate,
  onClose,
  onToggleSelect,
  onToggleMute,
  onTogglePin,
  onDiscard,
  onDuplicate,
  onDragStart,
  onDragOver,
  onDrop,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });

  const tabId = tab.id!;
  const isMuted = tab.mutedInfo?.muted;
  const isAudible = tab.audible;
  const isDiscarded = tab.discarded;

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      onToggleSelect(tabId);
    } else {
      onActivate(tabId);
    }
  };

  const handleAuxClick = (e: React.MouseEvent) => {
    // Middle click closes tab
    if (e.button === 1) {
      e.preventDefault();
      onClose(tabId);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 190) });
    setShowMenu(true);
  };

  const isCompact = density === 'compact';

  return (
    <>
      <div
        draggable
        onDragStart={(e) => onDragStart(e, tabId)}
        onDragOver={(e) => onDragOver(e, tabId)}
        onDrop={(e) => onDrop(e, tabId)}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        title={`${tab.title || ''}\n${tab.url || ''}`}
        className={`group relative flex items-center gap-2 px-2 rounded-md select-none cursor-pointer border-hairline transition-colors duration-150 ease-out ${
          isCompact ? 'h-7 text-[12px]' : 'h-9 text-[13px]'
        } ${
          isActive
            ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent-text)] font-medium'
            : isSelected
            ? 'bg-[var(--surface-active)] border-[var(--border-interactive)] text-[var(--text-high)]'
            : 'bg-transparent hover:bg-[var(--surface)] border-transparent text-[var(--text-medium)] hover:text-[var(--text-high)]'
        } ${isDiscarded ? 'opacity-60' : 'opacity-100'}`}
      >
        {/* Checkbox for selection */}
        {isSelected ? (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(tabId);
            }}
            className="text-[var(--accent-text)] shrink-0 cursor-pointer flex items-center justify-center"
          >
            <CheckSquare size={14} />
          </div>
        ) : (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(tabId);
            }}
            className="opacity-0 group-hover:opacity-100 text-[var(--text-low)] hover:text-[var(--text-high)] shrink-0 cursor-pointer transition-opacity duration-150 ease-out flex items-center justify-center"
          >
            <Square size={14} />
          </div>
        )}

        {/* Favicon */}
        <FaviconImage url={tab.url} favIconUrl={tab.favIconUrl} size={15} />

        {/* Title */}
        <span className="truncate flex-1 text-left leading-normal">
          {tab.title || '新标签页'}
        </span>

        {/* Indicators */}
        <div className="flex items-center gap-1 shrink-0">
          {(isAudible || isMuted) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMute(tabId, isMuted);
              }}
              title={isMuted ? '取消静音' : '静音'}
              className="p-0.5 rounded text-[var(--text-medium)] hover:text-[var(--text-high)]"
            >
              {isMuted ? <VolumeX size={13} className="text-[var(--danger-text)]" /> : <Volume2 size={13} className="text-[var(--success-text)]" />}
            </button>
          )}

          {isDiscarded && (
            <span title="已休眠" className="text-[var(--text-low)] flex items-center">
              <Moon size={12} />
            </span>
          )}

          {tab.pinned && (
            <span title="已固定" className="text-[var(--warning-text)] flex items-center">
              <Pin size={12} />
            </span>
          )}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose(tabId);
            }}
            title="关闭标签页"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-medium)] hover:text-[var(--danger-text)] transition-opacity duration-150 ease-out"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {showMenu && (
        <div
          className="fixed inset-0 z-50 select-none"
          onClick={() => setShowMenu(false)}
          onContextMenu={(e) => {
            e.preventDefault();
            setShowMenu(false);
          }}
        >
          <div
            style={{ left: menuPos.x, top: menuPos.y }}
            className="fixed z-50 w-40 rounded-lg bg-[var(--app-bg)] border-hairline border-[var(--border-interactive)] shadow-xs p-1 text-[12px] text-[var(--text-high)] animate-in fade-in duration-150 ease-out"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onTogglePin(tabId, tab.pinned);
                setShowMenu(false);
              }}
            >
              <span>{tab.pinned ? '取消固定' : '固定标签'}</span>
              <Pin size={12} className="text-[var(--text-medium)]" />
            </button>

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onToggleMute(tabId, isMuted);
                setShowMenu(false);
              }}
            >
              <span>{isMuted ? '恢复声音' : '静音'}</span>
              <Volume2 size={12} className="text-[var(--text-medium)]" />
            </button>

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onDuplicate(tabId);
                setShowMenu(false);
              }}
            >
              <span>复制标签</span>
            </button>

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onDiscard(tabId);
                setShowMenu(false);
              }}
            >
              <span>挂起休眠</span>
              <Moon size={12} className="text-[var(--text-medium)]" />
            </button>

            <div className="h-hairline bg-[var(--border-subtle)] my-1" />

            <button
              type="button"
              className="w-full text-left px-2 py-1 rounded-md hover:bg-[var(--danger-subtle)] text-[var(--danger-text)] flex items-center justify-between transition-colors duration-150 ease-out"
              onClick={() => {
                onClose(tabId);
                setShowMenu(false);
              }}
            >
              <span>关闭标签</span>
              <X size={12} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

import React from 'react';
import { Pin } from 'lucide-react';
import { FaviconImage } from './FaviconImage';

interface PinnedTabsSectionProps {
  pinnedTabs: chrome.tabs.Tab[];
  activeTabId: number | null;
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
}

export const PinnedTabsSection: React.FC<PinnedTabsSectionProps> = ({
  pinnedTabs,
  activeTabId,
  onActivate,
  onClose,
}) => {
  if (pinnedTabs.length === 0) return null;

  return (
    <div className="shrink-0 px-2 py-1.5 border-b-hairline border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
      <div className="flex items-center gap-1 text-[12px] font-medium text-[var(--text-medium)] mb-1">
        <Pin size={11} className="text-[var(--warning-text)]" />
        <span>已固定 ({pinnedTabs.length})</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {pinnedTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => tab.id && onActivate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1 && tab.id) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              title={`${tab.title || ''}\n${tab.url || ''}`}
              className={`p-1.5 rounded-md flex items-center justify-center cursor-pointer border-hairline transition-colors duration-150 ease-out ${
                isActive
                  ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent-text)]'
                  : 'bg-[var(--app-bg)] hover:bg-[var(--surface)] border-[var(--border-subtle)] text-[var(--text-medium)]'
              }`}
            >
              <FaviconImage url={tab.url} favIconUrl={tab.favIconUrl} size={15} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

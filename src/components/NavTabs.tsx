import React from 'react';
import { Layers, Bookmark, BookOpen } from 'lucide-react';

export type MainTabType = 'tabs' | 'bookmarks' | 'readingList';

interface NavTabsProps {
  activeTab: MainTabType;
  onChangeTab: (tab: MainTabType) => void;
  tabsCount: number;
  readingListUnreadCount: number;
}

export const NavTabs: React.FC<NavTabsProps> = ({
  activeTab,
  onChangeTab,
  tabsCount,
  readingListUnreadCount,
}) => {
  return (
    <div className="shrink-0 px-2.5 py-1.5 border-b-hairline border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
      <div className="flex items-center gap-1 bg-[var(--surface)] p-0.5 rounded-lg">
        {/* Tabs */}
        <button
          type="button"
          onClick={() => onChangeTab('tabs')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[12px] font-medium transition-colors duration-200 ease-out ${
            activeTab === 'tabs'
              ? 'bg-[var(--app-bg)] text-[var(--accent-text)] border-hairline border-[var(--border-subtle)] shadow-2xs'
              : 'text-[var(--text-medium)] hover:text-[var(--text-high)]'
          }`}
        >
          <Layers size={13} className="shrink-0" />
          <span>标签</span>
          <span className="text-[12px] text-[var(--text-medium)]">({tabsCount})</span>
        </button>

        {/* Bookmarks */}
        <button
          type="button"
          onClick={() => onChangeTab('bookmarks')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[12px] font-medium transition-colors duration-200 ease-out ${
            activeTab === 'bookmarks'
              ? 'bg-[var(--app-bg)] text-[var(--accent-text)] border-hairline border-[var(--border-subtle)] shadow-2xs'
              : 'text-[var(--text-medium)] hover:text-[var(--text-high)]'
          }`}
        >
          <Bookmark size={13} className="shrink-0" />
          <span>书签</span>
        </button>

        {/* Reading List */}
        <button
          type="button"
          onClick={() => onChangeTab('readingList')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[12px] font-medium transition-colors duration-200 ease-out ${
            activeTab === 'readingList'
              ? 'bg-[var(--app-bg)] text-[var(--accent-text)] border-hairline border-[var(--border-subtle)] shadow-2xs'
              : 'text-[var(--text-medium)] hover:text-[var(--text-high)]'
          }`}
        >
          <BookOpen size={13} className="shrink-0" />
          <span>稍后读</span>
          {readingListUnreadCount > 0 && (
            <span className="text-[12px] px-1 rounded-full bg-[var(--accent-solid)] text-white font-medium">
              {readingListUnreadCount}
            </span>
          )}
        </button>
      </div>
    </div>
  );
};

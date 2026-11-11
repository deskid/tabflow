import React, { useState, useMemo } from 'react';
import { useTabsManager } from './hooks/useTabsManager';
import { useBookmarks } from './hooks/useBookmarks';
import { useReadingList } from './hooks/useReadingList';
import { useSettings } from './hooks/useSettings';
import { Header } from './components/Header';
import { NavTabs, MainTabType } from './components/NavTabs';
import { TabItem } from './components/TabItem';
import { TabGroupHeader } from './components/TabGroupHeader';
import { PinnedTabsSection } from './components/PinnedTabsSection';
import { BookmarksView } from './components/BookmarksView';
import { ReadingListView } from './components/ReadingListView';
import { FloatingActionBar } from './components/FloatingActionBar';
import { StatusBar } from './components/StatusBar';
import { SettingsModal } from './components/SettingsModal';
import { UndoToast } from './components/UndoToast';

export const App: React.FC = () => {
  const [currentTabType, setCurrentTabType] = useState<MainTabType>('tabs');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [draggedTabId, setDraggedTabId] = useState<number | null>(null);

  const {
    tabs,
    groups,
    activeTabId,
    selectedTabIds,
    isGrouping,
    undoToastVisible,
    dismissUndoToast,
    activateTab,
    closeTab,
    closeTabs,
    createNewTab,
    toggleMute,
    togglePin,
    discardTab,
    duplicateTab,
    moveTab,
    toggleGroupCollapse,
    updateGroup,
    closeGroup,
    ungroupGroup,
    groupSelectedTabs,
    groupByDomain,
    groupWithAI,
    undoGrouping,
    findDuplicates,
    closeDuplicateTabs,
    toggleSelectTab,
    clearSelection,
  } = useTabsManager();

  const {
    bookmarkTree,
    searchResults: bookmarkResults,
    expandedFolderIds,
    toggleFolder,
    search: searchBookmarks,
    openBookmark,
    deleteBookmark,
    saveTabsAsFolder,
  } = useBookmarks();

  const {
    entries: readingEntries,
    unreadEntries,
    readEntries,
    isSupported: readingListSupported,
    addEntry: addReadingEntry,
    toggleRead,
    removeEntry: removeReadingEntry,
    openEntry: openReadingEntry,
  } = useReadingList();

  const { settings, updateSettings, updateAISettings } = useSettings();

  // Search handler
  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    if (currentTabType === 'bookmarks') {
      searchBookmarks(q);
    }
  };

  // Drag and drop
  const handleDragStart = (e: React.DragEvent, tabId: number) => {
    setDraggedTabId(tabId);
    e.dataTransfer.setData('text/plain', tabId.toString());
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetTabId: number) => {
    e.preventDefault();
    if (draggedTabId === null || draggedTabId === targetTabId) return;

    const targetTab = tabs.find((t) => t.id === targetTabId);
    if (targetTab && targetTab.index !== undefined) {
      moveTab(draggedTabId, targetTab.index);
    }
    setDraggedTabId(null);
  };

  // Add current active tab to reading list
  const handleAddActiveTabToReadingList = () => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active?.url && active?.title) {
      addReadingEntry(active.title, active.url);
    }
  };

  // Open standalone popup window
  const handleOpenStandalone = () => {
    chrome.runtime.sendMessage({ action: 'OPEN_STANDALONE_WINDOW' });
  };

  // Filter tabs by search
  const filteredTabs = useMemo(() => {
    if (!searchQuery.trim()) return tabs;
    const lower = searchQuery.toLowerCase();
    return tabs.filter(
      (t) => (t.title && t.title.toLowerCase().includes(lower)) || (t.url && t.url.toLowerCase().includes(lower))
    );
  }, [tabs, searchQuery]);

  const pinnedTabs = useMemo(() => filteredTabs.filter((t) => t.pinned), [filteredTabs]);
  const unpinnedTabs = useMemo(() => filteredTabs.filter((t) => !t.pinned), [filteredTabs]);

  // Group tabs by Chrome Tab Groups
  const groupedStructure = useMemo(() => {
    const groupItems: Array<{
      group?: (typeof groups extends Map<number, infer V> ? V : never);
      tabs: chrome.tabs.Tab[];
    }> = [];

    const tabsByGroupId = new Map<number, chrome.tabs.Tab[]>();
    const ungrouped: chrome.tabs.Tab[] = [];

    for (const tab of unpinnedTabs) {
      if (tab.groupId && tab.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE && tab.groupId !== -1) {
        const list = tabsByGroupId.get(tab.groupId) || [];
        list.push(tab);
        tabsByGroupId.set(tab.groupId, list);
      } else {
        ungrouped.push(tab);
      }
    }

    // Add registered groups
    for (const [groupId, groupTabs] of tabsByGroupId.entries()) {
      const gData = groups.get(groupId);
      if (gData) {
        groupItems.push({ group: gData, tabs: groupTabs });
      } else {
        ungrouped.push(...groupTabs);
      }
    }

    return { groupItems, ungrouped };
  }, [unpinnedTabs, groups]);

  const duplicates = findDuplicates();
  const discardedCount = tabs.filter((t) => t.discarded).length;

  return (
    <div className="flex flex-col h-screen w-full bg-[var(--app-bg)] text-[var(--text-high)] font-sans select-none overflow-hidden">
      {/* Top Header */}
      <Header
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onTriggerAI={() => groupWithAI(settings.aiSettings)}
        onTriggerDomainGroup={groupByDomain}
        onOpenStandalone={handleOpenStandalone}
        onOpenSettings={() => setIsSettingsOpen(false ? false : true)}
        isGrouping={isGrouping}
      />

      {/* Navigation Sub-Tabs */}
      <NavTabs
        activeTab={currentTabType}
        onChangeTab={setCurrentTabType}
        tabsCount={tabs.length}
        readingListUnreadCount={unreadEntries.length}
      />

      {/* Undo Toast */}
      <UndoToast
        visible={undoToastVisible}
        onUndo={undoGrouping}
        onDismiss={dismissUndoToast}
      />

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-2 py-1 scrollbar-thin">
        {currentTabType === 'tabs' && (
          <div className="space-y-0.5">
            {/* Pinned Tabs Section */}
            <PinnedTabsSection
              pinnedTabs={pinnedTabs}
              activeTabId={activeTabId}
              onActivate={activateTab}
              onClose={closeTab}
            />

            {/* Tab Groups */}
            {groupedStructure.groupItems.map(({ group, tabs: gTabs }) => {
              if (!group) return null;
              return (
                <div key={group.id} className="mb-1">
                  <TabGroupHeader
                    group={group}
                    tabCount={gTabs.length}
                    onToggleCollapse={toggleGroupCollapse}
                    onUpdateGroup={updateGroup}
                    onCloseGroup={closeGroup}
                    onUngroup={ungroupGroup}
                    onAddTabInGroup={createNewTab}
                    onSaveAsBookmarkFolder={(title) => saveTabsAsFolder(title, gTabs)}
                  />

                  {/* Group Tabs */}
                  {!group.collapsed && (
                    <div className="pl-1.5 space-y-0.5 border-l-hairline border-[var(--border-subtle)] ml-1.5 my-0.5">
                      {gTabs.map((t) => (
                        <TabItem
                          key={t.id}
                          tab={t}
                          isActive={t.id === activeTabId}
                          isSelected={selectedTabIds.has(t.id!)}
                          density={settings.density}
                          onActivate={activateTab}
                          onClose={closeTab}
                          onToggleSelect={toggleSelectTab}
                          onToggleMute={toggleMute}
                          onTogglePin={togglePin}
                          onDiscard={discardTab}
                          onDuplicate={duplicateTab}
                          onDragStart={handleDragStart}
                          onDragOver={handleDragOver}
                          onDrop={handleDrop}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Ungrouped Tabs */}
            {groupedStructure.ungrouped.length > 0 && (
              <div className="space-y-0.5 pt-0.5">
                {groupedStructure.groupItems.length > 0 && (
                  <div className="text-[12px] font-medium text-[var(--text-medium)] px-2 py-0.5">
                    未分组标签 ({groupedStructure.ungrouped.length})
                  </div>
                )}
                {groupedStructure.ungrouped.map((t) => (
                  <TabItem
                    key={t.id}
                    tab={t}
                    isActive={t.id === activeTabId}
                    isSelected={selectedTabIds.has(t.id!)}
                    density={settings.density}
                    onActivate={activateTab}
                    onClose={closeTab}
                    onToggleSelect={toggleSelectTab}
                    onToggleMute={toggleMute}
                    onTogglePin={togglePin}
                    onDiscard={discardTab}
                    onDuplicate={duplicateTab}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                  />
                ))}
              </div>
            )}

            {filteredTabs.length === 0 && (
              <div className="p-6 text-center text-[12px] text-[var(--text-medium)]">
                未找到匹配标签页
              </div>
            )}
          </div>
        )}

        {currentTabType === 'bookmarks' && (
          <BookmarksView
            bookmarkTree={bookmarkTree}
            searchQuery={searchQuery}
            searchResults={bookmarkResults}
            expandedFolderIds={expandedFolderIds}
            onToggleFolder={toggleFolder}
            onOpenBookmark={openBookmark}
            onDeleteBookmark={deleteBookmark}
          />
        )}

        {currentTabType === 'readingList' && (
          <ReadingListView
            entries={readingEntries}
            unreadEntries={unreadEntries}
            readEntries={readEntries}
            isSupported={readingListSupported}
            onAddCurrentTab={handleAddActiveTabToReadingList}
            onToggleRead={toggleRead}
            onRemove={removeReadingEntry}
            onOpen={openReadingEntry}
          />
        )}
      </div>

      {/* Floating Action Bar */}
      <FloatingActionBar
        selectedCount={selectedTabIds.size}
        onGroupSelected={() => groupSelectedTabs('新标签组', 'blue')}
        onCloseSelected={() => closeTabs(Array.from(selectedTabIds))}
        onMuteSelected={() => {
          for (const id of selectedTabIds) toggleMute(id);
          clearSelection();
        }}
        onPinSelected={() => {
          for (const id of selectedTabIds) togglePin(id);
          clearSelection();
        }}
        onClearSelection={clearSelection}
      />

      {/* Status Bar */}
      <StatusBar
        totalTabs={tabs.length}
        discardedCount={discardedCount}
        duplicateCount={duplicates.length}
        onNewTab={createNewTab}
        onCleanDuplicates={closeDuplicateTabs}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={updateSettings}
        onUpdateAISettings={updateAISettings}
      />
    </div>
  );
};

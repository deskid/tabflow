import { useState, useEffect, useCallback } from 'react';

export function useBookmarks(targetWindowId?: number | null) {
  const [bookmarkTree, setBookmarkTree] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set(['1', '2'])); // default expand Bookmarks bar

  const refresh = useCallback(async () => {
    if (!chrome.bookmarks) return;
    try {
      const tree = await chrome.bookmarks.getTree();
      setBookmarkTree(tree);
    } catch (e) {
      console.warn('Get bookmarks tree failed:', e);
    }
  }, []);

  useEffect(() => {
    refresh();

    const handleCreated = () => refresh();
    const handleRemoved = () => refresh();
    const handleChanged = () => refresh();
    const handleMoved = () => refresh();

    chrome.bookmarks.onCreated.addListener(handleCreated);
    chrome.bookmarks.onRemoved.addListener(handleRemoved);
    chrome.bookmarks.onChanged.addListener(handleChanged);
    chrome.bookmarks.onMoved.addListener(handleMoved);

    return () => {
      chrome.bookmarks.onCreated.removeListener(handleCreated);
      chrome.bookmarks.onRemoved.removeListener(handleRemoved);
      chrome.bookmarks.onChanged.removeListener(handleChanged);
      chrome.bookmarks.onMoved.removeListener(handleMoved);
    };
  }, [refresh]);

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const search = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await chrome.bookmarks.search(query);
      setSearchResults(results.filter((item) => item.url)); // only show real links
    } catch (e) {
      console.warn('Bookmarks search error:', e);
    }
  };

  const openBookmark = async (url: string, newTab = true) => {
    if (targetWindowId === null) return;
    if (newTab) {
      await chrome.tabs.create({ url, active: true, ...(targetWindowId === undefined ? {} : { windowId: targetWindowId }) });
    } else {
      const current = await chrome.tabs.query({ active: true, ...(targetWindowId === undefined ? { currentWindow: true } : { windowId: targetWindowId }) });
      if (current[0]?.id) await chrome.tabs.update(current[0].id, { url });
    }
    if (targetWindowId !== undefined) await chrome.windows.update(targetWindowId, { focused: true });
  };

  const deleteBookmark = async (id: string) => {
    try {
      await chrome.bookmarks.remove(id);
      refresh();
    } catch (e) {
      console.warn('Delete bookmark error:', e);
    }
  };

  const saveTabsAsFolder = async (folderTitle: string, tabsToSave: Array<{ title?: string; url?: string }>) => {
    try {
      // Create folder under "Other bookmarks" (id: '2') or bookmarks bar ('1')
      const folder = await chrome.bookmarks.create({
        parentId: '1',
        title: folderTitle || 'SideTab 标签组保存',
      });

      for (const tab of tabsToSave) {
        if (tab.url && !tab.url.startsWith('chrome://')) {
          await chrome.bookmarks.create({
            parentId: folder.id,
            title: tab.title || tab.url,
            url: tab.url,
          });
        }
      }
      refresh();
    } catch (e) {
      console.warn('Save tabs to bookmarks error:', e);
    }
  };

  return {
    bookmarkTree,
    searchQuery,
    searchResults,
    expandedFolderIds,
    toggleFolder,
    search,
    openBookmark,
    deleteBookmark,
    saveTabsAsFolder,
    refresh,
  };
}

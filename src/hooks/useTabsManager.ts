import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TabData,
  ChromeGroupColor,
  GroupingUndoState,
  AISettings,
  planGroupByDomain,
  planGroupByAI,
  executeTabGrouping,
  undoTabGrouping,
} from '../services/aiGrouper';

export interface TabGroupData {
  id: number;
  title?: string;
  color: ChromeGroupColor;
  collapsed: boolean;
  windowId: number;
}

export function useTabsManager() {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [groups, setGroups] = useState<Map<number, TabGroupData>>(new Map());
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [currentWindowId, setCurrentWindowId] = useState<number | null>(null);
  const [selectedTabIds, setSelectedTabIds] = useState<Set<number>>(new Set());
  const [undoState, setUndoState] = useState<GroupingUndoState | null>(null);
  const [undoToastVisible, setUndoToastVisible] = useState(false);
  const [isGrouping, setIsGrouping] = useState(false);

  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load tabs and groups for current window
  const refresh = useCallback(async () => {
    try {
      const currentWin = await chrome.windows.getCurrent();
      if (!currentWin || !currentWin.id) return;
      setCurrentWindowId(currentWin.id);

      const winTabs = await chrome.tabs.query({ windowId: currentWin.id });
      setTabs(winTabs);

      const active = winTabs.find((t) => t.active);
      if (active && active.id) {
        setActiveTabId(active.id);
      }

      // Query groups
      if (chrome.tabGroups) {
        try {
          const winGroups = await chrome.tabGroups.query({ windowId: currentWin.id });
          const groupMap = new Map<number, TabGroupData>();
          for (const g of winGroups) {
            groupMap.set(g.id, {
              id: g.id,
              title: g.title,
              color: g.color as ChromeGroupColor,
              collapsed: g.collapsed,
              windowId: g.windowId,
            });
          }
          setGroups(groupMap);
        } catch {
          // ignore if tabGroups not supported in current window
        }
      }
    } catch (err) {
      console.warn('Failed to refresh tabs:', err);
    }
  }, []);

  // Listen to chrome events
  useEffect(() => {
    refresh();

    const handleTabUpdated = () => refresh();
    const handleTabCreated = () => refresh();
    const handleTabRemoved = () => refresh();
    const handleTabMoved = () => refresh();
    const handleTabActivated = (info: { tabId: number; windowId: number }) => {
      setActiveTabId(info.tabId);
      refresh();
    };
    const handleTabAttached = () => refresh();
    const handleTabDetached = () => refresh();

    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    chrome.tabs.onCreated.addListener(handleTabCreated);
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    chrome.tabs.onMoved.addListener(handleTabMoved);
    chrome.tabs.onActivated.addListener(handleTabActivated);
    chrome.tabs.onAttached.addListener(handleTabAttached);
    chrome.tabs.onDetached.addListener(handleTabDetached);

    let handleGroupCreated: any;
    let handleGroupUpdated: any;
    let handleGroupRemoved: any;
    let handleGroupMoved: any;

    if (chrome.tabGroups) {
      handleGroupCreated = () => refresh();
      handleGroupUpdated = () => refresh();
      handleGroupRemoved = () => refresh();
      handleGroupMoved = () => refresh();

      chrome.tabGroups.onCreated.addListener(handleGroupCreated);
      chrome.tabGroups.onUpdated.addListener(handleGroupUpdated);
      chrome.tabGroups.onRemoved.addListener(handleGroupRemoved);
      chrome.tabGroups.onMoved.addListener(handleGroupMoved);
    }

    return () => {
      chrome.tabs.onUpdated.removeListener(handleTabUpdated);
      chrome.tabs.onCreated.removeListener(handleTabCreated);
      chrome.tabs.onRemoved.removeListener(handleTabRemoved);
      chrome.tabs.onMoved.removeListener(handleTabMoved);
      chrome.tabs.onActivated.removeListener(handleTabActivated);
      chrome.tabs.onAttached.removeListener(handleTabAttached);
      chrome.tabs.onDetached.removeListener(handleTabDetached);

      if (chrome.tabGroups) {
        chrome.tabGroups.onCreated.removeListener(handleGroupCreated);
        chrome.tabGroups.onUpdated.removeListener(handleGroupUpdated);
        chrome.tabGroups.onRemoved.removeListener(handleGroupRemoved);
        chrome.tabGroups.onMoved.removeListener(handleGroupMoved);
      }
    };
  }, [refresh]);

  // Operations
  const activateTab = async (tabId: number) => {
    try {
      await chrome.tabs.update(tabId, { active: true });
      setActiveTabId(tabId);
    } catch (e) {
      console.warn('Activate tab error:', e);
    }
  };

  const closeTab = async (tabId: number) => {
    try {
      await chrome.tabs.remove(tabId);
      setSelectedTabIds((prev) => {
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    } catch (e) {
      console.warn('Close tab error:', e);
    }
  };

  const closeTabs = async (tabIds: number[]) => {
    if (tabIds.length === 0) return;
    try {
      await chrome.tabs.remove(tabIds);
      setSelectedTabIds((prev) => {
        const next = new Set(prev);
        for (const id of tabIds) next.delete(id);
        return next;
      });
    } catch (e) {
      console.warn('Close tabs error:', e);
    }
  };

  const createNewTab = async () => {
    try {
      await chrome.tabs.create({ active: true });
    } catch (e) {
      console.warn('Create tab error:', e);
    }
  };

  const toggleMute = async (tabId: number, currentMuted?: boolean) => {
    try {
      await chrome.tabs.update(tabId, { muted: !currentMuted });
    } catch (e) {
      console.warn('Toggle mute error:', e);
    }
  };

  const togglePin = async (tabId: number, currentPinned?: boolean) => {
    try {
      await chrome.tabs.update(tabId, { pinned: !currentPinned });
    } catch (e) {
      console.warn('Toggle pin error:', e);
    }
  };

  const discardTab = async (tabId: number) => {
    try {
      if (chrome.tabs.discard) {
        await chrome.tabs.discard(tabId);
        refresh();
      }
    } catch (e) {
      console.warn('Discard tab error:', e);
    }
  };

  const duplicateTab = async (tabId: number) => {
    try {
      await chrome.tabs.duplicate(tabId);
    } catch (e) {
      console.warn('Duplicate tab error:', e);
    }
  };

  const moveTab = async (tabId: number, newIndex: number) => {
    try {
      await chrome.tabs.move(tabId, { index: newIndex });
      refresh();
    } catch (e) {
      console.warn('Move tab error:', e);
    }
  };

  const toggleGroupCollapse = async (groupId: number, currentCollapsed: boolean) => {
    try {
      await chrome.tabGroups.update(groupId, { collapsed: !currentCollapsed });
      setGroups((prev) => {
        const next = new Map(prev);
        const g = next.get(groupId);
        if (g) next.set(groupId, { ...g, collapsed: !currentCollapsed });
        return next;
      });
    } catch (e) {
      console.warn('Toggle group collapse error:', e);
    }
  };

  const updateGroup = async (groupId: number, updates: { title?: string; color?: ChromeGroupColor }) => {
    try {
      await chrome.tabGroups.update(groupId, updates);
      refresh();
    } catch (e) {
      console.warn('Update group error:', e);
    }
  };

  const closeGroup = async (groupId: number) => {
    const groupTabs = tabs.filter((t) => t.groupId === groupId && t.id !== undefined);
    const ids = groupTabs.map((t) => t.id!);
    await closeTabs(ids);
  };

  const ungroupTabs = async (tabIds: number[]) => {
    if (tabIds.length === 0) return;
    try {
      await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
      refresh();
    } catch (e) {
      console.warn('Ungroup error:', e);
    }
  };

  const ungroupGroup = async (groupId: number) => {
    const groupTabs = tabs.filter((t) => t.groupId === groupId && t.id !== undefined);
    const ids = groupTabs.map((t) => t.id!);
    await ungroupTabs(ids);
  };

  const groupSelectedTabs = async (title?: string, color?: ChromeGroupColor) => {
    const ids = Array.from(selectedTabIds);
    if (ids.length === 0) return;
    try {
      const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]] });
      if (title || color) {
        await chrome.tabGroups.update(groupId, {
          title: title || '新建分组',
          color: color || 'blue',
          collapsed: false,
        });
      }
      setSelectedTabIds(new Set());
      refresh();
    } catch (e) {
      console.warn('Group selected tabs error:', e);
    }
  };

  // Group by Domain
  const groupByDomain = async () => {
    const tabData: TabData[] = tabs
      .filter((t) => t.id !== undefined && !t.pinned)
      .map((t) => ({
        id: t.id!,
        title: t.title || '',
        url: t.url || '',
        favIconUrl: t.favIconUrl,
        groupId: t.groupId,
      }));

    const plan = planGroupByDomain(tabData);
    if (plan.length === 0) return;

    setIsGrouping(true);
    try {
      const uState = await executeTabGrouping(plan, tabData);
      triggerUndoNotice(uState);
      refresh();
    } finally {
      setIsGrouping(false);
    }
  };

  // Group with AI
  const groupWithAI = async (settings?: AISettings) => {
    const tabData: TabData[] = tabs
      .filter((t) => t.id !== undefined && !t.pinned)
      .map((t) => ({
        id: t.id!,
        title: t.title || '',
        url: t.url || '',
        favIconUrl: t.favIconUrl,
        groupId: t.groupId,
      }));

    setIsGrouping(true);
    try {
      const plan = await planGroupByAI(tabData, settings);
      if (plan.length > 0) {
        const uState = await executeTabGrouping(plan, tabData);
        triggerUndoNotice(uState);
        refresh();
      }
    } finally {
      setIsGrouping(false);
    }
  };

  const triggerUndoNotice = (uState: GroupingUndoState) => {
    setUndoState(uState);
    setUndoToastVisible(true);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      setUndoToastVisible(false);
      setUndoState(null);
    }, 8000);
  };


  const dismissUndoToast = () => {
    setUndoToastVisible(false);
    setUndoState(null);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  };

  const undoGrouping = async () => {
    if (!undoState) return;
    try {
      await undoTabGrouping(undoState);
      setUndoState(null);
      setUndoToastVisible(false);
      refresh();
    } catch (e) {
      console.warn('Undo grouping failed:', e);
    }
  };

  // Close Duplicates
  const findDuplicates = (): chrome.tabs.Tab[] => {
    const urlSet = new Set<string>();
    const dupes: chrome.tabs.Tab[] = [];
    for (const t of tabs) {
      if (!t.url || t.url.startsWith('chrome://')) continue;
      if (urlSet.has(t.url)) {
        dupes.push(t);
      } else {
        urlSet.add(t.url);
      }
    }
    return dupes;
  };

  const closeDuplicateTabs = async () => {
    const dupes = findDuplicates();
    const ids = dupes.map((d) => d.id!).filter((id) => id !== undefined);
    if (ids.length > 0) {
      await closeTabs(ids);
    }
  };

  // Multi-selection helpers
  const toggleSelectTab = (tabId: number) => {
    setSelectedTabIds((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return next;
    });
  };

  const selectRange = (fromIndex: number, toIndex: number) => {
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    const slice = tabs.slice(start, end + 1);
    setSelectedTabIds((prev) => {
      const next = new Set(prev);
      for (const t of slice) {
        if (t.id) next.add(t.id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedTabIds(new Set());

  return {
    tabs,
    groups,
    activeTabId,
    currentWindowId,
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
    ungroupTabs,
    ungroupGroup,
    groupSelectedTabs,
    groupByDomain,
    groupWithAI,
    undoGrouping,
    findDuplicates,
    closeDuplicateTabs,
    toggleSelectTab,
    selectRange,
    clearSelection,
    refresh,
  };
}

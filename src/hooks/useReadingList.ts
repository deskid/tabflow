import { useState, useEffect, useCallback } from 'react';

export interface ReadingEntry {
  title: string;
  url: string;
  hasBeenRead: boolean;
  creationTime?: number;
  updateTime?: number;
}

export function useReadingList() {
  const [entries, setEntries] = useState<ReadingEntry[]>([]);
  const [unreadEntries, setUnreadEntries] = useState<ReadingEntry[]>([]);
  const [readEntries, setReadEntries] = useState<ReadingEntry[]>([]);
  const [isSupported, setIsSupported] = useState(true);

  const refresh = useCallback(async () => {
    if (!chrome.readingList || !chrome.readingList.query) {
      setIsSupported(false);
      return;
    }
    try {
      const items = (await chrome.readingList.query({})) as unknown as ReadingEntry[];
      setEntries(items);
      setUnreadEntries(items.filter((item) => !item.hasBeenRead));
      setReadEntries(items.filter((item) => item.hasBeenRead));
    } catch (e) {
      console.warn('Query reading list failed:', e);
    }
  }, []);

  useEffect(() => {
    refresh();

    let handleCreated: any;
    let handleRemoved: any;
    let handleUpdated: any;

    if (chrome.readingList?.onEntryAdded) {
      handleCreated = () => refresh();
      handleRemoved = () => refresh();
      handleUpdated = () => refresh();

      chrome.readingList.onEntryAdded.addListener(handleCreated);
      chrome.readingList.onEntryRemoved.addListener(handleRemoved);
      chrome.readingList.onEntryUpdated.addListener(handleUpdated);
    }

    return () => {
      if (chrome.readingList?.onEntryAdded) {
        chrome.readingList.onEntryAdded.removeListener(handleCreated);
        chrome.readingList.onEntryRemoved.removeListener(handleRemoved);
        chrome.readingList.onEntryUpdated.removeListener(handleUpdated);
      }
    };
  }, [refresh]);

  const addEntry = async (title: string, url: string) => {
    if (!chrome.readingList?.addEntry) return;
    try {
      await chrome.readingList.addEntry({
        title,
        url,
        hasBeenRead: false,
      });
      refresh();
    } catch (e) {
      console.warn('Add to reading list error:', e);
    }
  };

  const toggleRead = async (entry: ReadingEntry) => {
    if (!chrome.readingList?.updateEntry) return;
    try {
      await chrome.readingList.updateEntry({
        url: entry.url,
        hasBeenRead: !entry.hasBeenRead,
      });
      refresh();
    } catch (e) {
      console.warn('Update reading list error:', e);
    }
  };

  const removeEntry = async (url: string) => {
    if (!chrome.readingList?.removeEntry) return;
    try {
      await chrome.readingList.removeEntry({ url });
      refresh();
    } catch (e) {
      console.warn('Remove reading list error:', e);
    }
  };

  const openEntry = async (url: string, newTab = true) => {
    if (newTab) {
      await chrome.tabs.create({ url, active: true });
    }
  };

  return {
    entries,
    unreadEntries,
    readEntries,
    isSupported,
    addEntry,
    toggleRead,
    removeEntry,
    openEntry,
    refresh,
  };
}

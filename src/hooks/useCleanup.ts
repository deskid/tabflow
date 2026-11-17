import { useCallback, useEffect, useState } from 'react';
import { cleanupCommand, CLEANUP_ARCHIVE_KEY, CLEANUP_CONFIG_KEY, CLEANUP_SESSION_KEY, CLEANUP_STATUS_KEY, DEFAULT_CLEANUP_CONFIG } from '../services/cleanup';
import type { CleanupConfig, CleanupPlan, CleanupView } from '../services/cleanup';

const EMPTY_VIEW: CleanupView = { config: DEFAULT_CLEANUP_CONFIG, entries: [], status: { message: '' }, protectedTabIds: [], protectedGroupIds: [] };
export function useCleanup() {
  const [view, setView] = useState<CleanupView>(EMPTY_VIEW);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [previewId, setPreviewId] = useState('');
  const refresh = useCallback(async () => {
    const next = await cleanupCommand<CleanupView>('view'); setView(next); setLoaded(true);
  }, []);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const read = async () => {
      const current = ++revision;
      try { const next = await cleanupCommand<CleanupView>('view'); if (active && revision === current) { setView(next); setLoaded(true); } }
      catch (error) { if (active) setError(error instanceof Error ? error.message : '清理设置读取失败。'); }
    };
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) { setLoaded(true); return; }
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && [CLEANUP_ARCHIVE_KEY, CLEANUP_CONFIG_KEY, CLEANUP_STATUS_KEY].some(key => key in changes) ||
        area === 'session' && CLEANUP_SESSION_KEY in changes) void read();
    };
    chrome.storage.onChanged.addListener(changed); void read();
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T | undefined> {
    setBusy(true); setError('');
    try { const result = await cleanupCommand<T>(name, args); await refresh(); return result; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '清理操作失败。'); throw reason; }
    finally { setBusy(false); }
  }
  return { ...view, loaded, error, busy, clearError: () => setError(''),
    previewPages: view.preview?.id === previewId ? view.preview.pages : undefined,
    update: (patch: Partial<CleanupConfig>) => command<CleanupConfig>('update', { patch }),
    preview: () => { const id = crypto.randomUUID(); setPreviewId(id); return command<CleanupPlan>('preview', { id }); },
    protect: (kind: 'tab' | 'group', id: number, enabled: boolean) => command('protect', { kind, id, enabled }),
    restore: (ids: string[], windowId?: number, newWindow = false) => command('restore', { ids, windowId, newWindow }),
    remove: (ids: string[]) => command('delete', { ids }),
  };
}
export type CleanupManager = ReturnType<typeof useCleanup>;

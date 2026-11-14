const SOURCE_CLOSED = '来源浏览器窗口已关闭或不可用，请从浏览器窗口重新打开 TabFlow。';

function isNormalWindow(window: chrome.windows.Window | undefined): window is chrome.windows.Window & { id: number } {
  return !!window && Number.isSafeInteger(window.id) && window.id! >= 0 && window.type === 'normal';
}

/** Bind a standalone view to its explicit source, never to its own popup. */
export async function resolveTargetWindowId(search: string): Promise<number> {
  const requested = new URLSearchParams(search).get('windowId');
  if (requested !== null) {
    if (!/^\d+$/u.test(requested) || !Number.isSafeInteger(Number(requested))) throw new Error('来源窗口参数无效，请从浏览器重新打开 TabFlow。');
    try {
      const source = await chrome.windows.get(Number(requested));
      if (!isNormalWindow(source)) throw new Error(SOURCE_CLOSED);
      return source.id;
    } catch { throw new Error(SOURCE_CLOSED); }
  }
  const current = await chrome.windows.getCurrent();
  if (isNormalWindow(current)) return current.id;
  try {
    const source = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (isNormalWindow(source)) return source.id;
  } catch { /* No available normal browser window. */ }
  throw new Error(SOURCE_CLOSED);
}

/** A resolver is created once per view; focus changes cannot change its source. */
export function createTargetWindowBinding(search: string) {
  let id: number | undefined;
  let pending: Promise<number> | undefined;
  return async (): Promise<number> => {
    if (id !== undefined) return id;
    if (!pending) pending = resolveTargetWindowId(search).then((resolved) => {
      id = resolved;
      return resolved;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

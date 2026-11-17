export const NATIVE_PROTOCOL_VERSION = 1;

/** One transport for native status queries and inference; product actions stay in the extension. */
export function nativeRequest(payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendNativeMessage) {
      reject(new Error('当前环境不支持本机通信。')); return;
    }
    const timer = setTimeout(() => reject(new Error('本机 Codex 请求超时，请重试。')), 120_000);
    try {
      chrome.runtime.sendNativeMessage('com.tabflow.codex_bridge', payload, response => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError?.message;
        if (error) reject(new Error(error));
        else if (!response?.success) {
          const needsUpgrade = payload.action === 'GENERATE_JSON' && ['UNKNOWN_ACTION', 'UNSUPPORTED_PROTOCOL'].includes(response?.errorCode);
          reject(new Error(needsUpgrade ? '本机 Codex 桥接需要升级到通用推理协议，请更新桥接后重试。'
            : response?.error || '本机 Codex 桥接未返回有效结果。'));
        } else resolve(response);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

export async function requestNativeJSON(request: {
  instructions: string; input: string; outputSchema: object; model?: string;
}): Promise<unknown> {
  const response = await nativeRequest({ action: 'GENERATE_JSON', protocolVersion: NATIVE_PROTOCOL_VERSION, ...request });
  if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION || !Object.hasOwn(response, 'data')) throw new Error('本机 Codex 返回了无效的推理结果。');
  return response.data;
}

// The callback is a courier only; no tokens are received here or persisted.
const output = document.getElementById('oauth-status');
const parameters = new URLSearchParams(location.search);
const payload = {
  state: parameters.get('state') ?? '',
  code: parameters.get('code') ?? undefined,
  client_id: parameters.get('client_id') ?? undefined,
  error: parameters.get('error') ?? undefined,
};
// Remove the authorization code from the visible URL before opening the channel.
history.replaceState(null, '', location.pathname);
for (const key of [...parameters.keys()]) parameters.delete(key);
let complete = false;
let port: chrome.runtime.Port | undefined;
function show(message: string) { if (output) output.textContent = message; }
const timer = setTimeout(() => {
  if (!complete) { complete = true; show('原扩展页面未响应，请关闭本页并重新登录。'); port?.disconnect(); }
}, 180_000);
try {
  port = chrome.runtime.connect({ name: 'tabflow-chatgpt-plan-oauth-v1' });
  port.onMessage.addListener((message: unknown) => {
    if (complete) return;
    complete = true; clearTimeout(timer);
    show((message as { ok?: boolean })?.ok === true ? '授权验证完成，可以关闭本页。请回原扩展页面查看计划权限状态。' : '授权验证失败，请回原扩展页面重新登录。');
    port?.disconnect();
  });
  port.onDisconnect.addListener(() => {
    if (complete) return;
    complete = true; clearTimeout(timer);
    show('授权通道已关闭，请回原扩展页面查看状态或重新登录。');
  });
  port.postMessage(payload);
} catch {
  complete = true; clearTimeout(timer);
  show('无法连接原扩展页面，请保持该页面打开并重新登录。');
} finally {
  // Avoid retaining the courier payload after Chrome has copied the message.
  payload.code = undefined; payload.state = ''; payload.client_id = undefined; payload.error = undefined;
}
export {};

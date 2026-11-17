import type { AISettings, ChromeGroupColor } from './aiGrouper';

export const CLEANUP_CONFIG_KEY = 'tabflow_cleanup_config';
export const CLEANUP_ARCHIVE_KEY = 'tabflow_cleanup_archive';
export const CLEANUP_SESSION_KEY = 'tabflow_cleanup_session';
export const CLEANUP_STATUS_KEY = 'tabflow_cleanup_status';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const CLEANUP_TIERS = {
  conservative: { label: '保守', age: 7 * DAY, prompt: '只归档明确闲置的临时搜索结果和导航页。保留文章、资料、工作页面，以及与当前任务有关或用途不明确的标签。' },
  balanced: { label: '均衡', age: 3 * DAY, prompt: '结合闲置时间、访问次数和活跃主题，归档不再需要的临时浏览、文章和资料。保留与当前任务有关、可能继续使用或用途不明确的标签。' },
  aggressive: { label: '积极', age: DAY, prompt: '主动归档与当前任务无关的闲置页面，允许按闲置主题整组归档。参考闲置时间与访问次数，不仅凭时间长短决定；保留进行中的工作和用途不明确的标签。' },
} as const;
export type CleanupTier = keyof typeof CLEANUP_TIERS;
export interface CleanupConfig {
  enabled: boolean;
  mode: 'ai' | 'time';
  tier: CleanupTier;
  prompt: string;
  protectedSites: string[];
  notBefore: number;
  pausedUntil: number;
  revision: string;
}
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  enabled: false, mode: 'ai', tier: 'conservative', prompt: '', protectedSites: [], notBefore: 0, pausedUntil: 0, revision: '',
};
export interface CleanupCandidate {
  id: number; title: string; url: string; windowId: number; groupId: number;
  groupTitle: string; lastUsed: number; visits: number;
}
export interface CleanupDecision {
  id: number; action: 'archive' | 'keep' | 'uncertain';
  kind: 'temporary' | 'reference' | 'other'; task: string; reason: string;
}
export interface CleanupPlan {
  candidates: CleanupCandidate[]; decisions: CleanupDecision[]; fingerprint: string; configRevision: string; createdAt: number;
  pages: CleanupPreviewPage[];
  activityRevision?: number;
  modelKey?: string;
  modelLabel?: string;
}
export interface CleanupPreviewPage {
  id: number; title: string; url: string; windowId: number;
  action: 'archive' | 'keep' | 'pending'; reason: string;
}
export interface ArchiveEntry {
  id: string; batchId: string; tabId: number; sessionId: string; url: string; title: string;
  windowId: number; index: number; groupId: number; groupTitle: string; groupColor: ChromeGroupColor;
  groupCollapsed: boolean; task: string; reason: string; archivedAt: number; tier: CleanupTier;
  model: string; state: 'pending' | 'archived'; restoredTabId?: number; restoredWindowId?: number;
}
export interface CleanupStatus { message: string; lastRunAt?: number; lastBatchId?: string; archivedCount?: number }
export interface CleanupView {
  config: CleanupConfig; entries: ArchiveEntry[]; status: CleanupStatus;
  protectedTabIds: number[]; protectedGroupIds: number[];
  preview?: { id: string; pages: CleanupPreviewPage[] };
}
export const CLEANUP_DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decisions'], properties: {
    decisions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'action', 'kind', 'task', 'reason'], properties: {
        id: { type: 'integer' }, action: { type: 'string', enum: ['archive', 'keep', 'uncertain'] },
        kind: { type: 'string', enum: ['temporary', 'reference', 'other'] },
        task: { type: 'string' }, reason: { type: 'string' },
      } } },
  },
};
export function validateCleanupDecisions(value: unknown, candidates: CleanupCandidate[], tier?: CleanupTier): CleanupDecision[] {
  const decisions = (value as { decisions?: unknown })?.decisions;
  if (!Array.isArray(decisions) || decisions.length !== candidates.length) throw new Error('清理模型遗漏标签或返回了无效结果，本次未执行。');
  const ids = new Set(candidates.map(tab => tab.id));
  return decisions.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || !ids.delete(item.id) ||
      !['archive', 'keep', 'uncertain'].includes(item.action) || !['temporary', 'reference', 'other'].includes(item.kind) ||
      typeof item.task !== 'string' || !item.task.trim() || item.task.length > 80 ||
      typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 300) {
      throw new Error('清理模型返回了未知 ID、重复 ID 或无效决定，本次未执行。');
    }
    const restricted = tier === 'conservative' && item.kind !== 'temporary' && item.action === 'archive';
    return { id: item.id, action: restricted ? 'keep' : item.action,
      kind: item.kind, task: item.task.trim(), reason: restricted ? '保守策略仅归档临时搜索和导航页。' : item.reason.trim() };
  });
}
export function normalizeProtectedSite(value: string): string {
  const input = value.trim().toLowerCase();
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
    url.pathname !== '/' || url.search || url.hash || !url.hostname || /[*\s]/.test(url.hostname)) throw new Error('请输入网站域名，例如 docs.google.com。');
  return url.hostname;
}
export function protectedSite(url: string, sites: string[]): boolean {
  try { const host = new URL(url).hostname; return sites.some(site => host === site || host.endsWith(`.${site}`)); }
  catch { return true; }
}
export function cleanupURL(value: string): string {
  const url = new URL(value); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.href.slice(0, 1500);
}
export function supportedCleanupProvider(provider: AISettings['provider']): boolean {
  return ['openai', 'deepseek', 'custom', 'codex_native', 'chatgpt_plan'].includes(provider);
}

export async function cleanupCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ action: 'CLEANUP', command, ...args });
  if (!reply?.success) throw new Error(reply?.error || '自动清理后台未响应。');
  return reply.value as T;
}

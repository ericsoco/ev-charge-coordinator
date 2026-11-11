/** Top-level destinations (requirements 2a–2c): labels and icons are product copy. */
export interface Tab {
  id: 'now' | 'then' | 'messages';
  label: string;
  /** Emoji per requirements (⚡️ 🔄 💬) — zero font payload (page-load priority). */
  icon: string;
}

export const TABS: readonly Tab[] = [
  { id: 'now', label: 'Now', icon: '⚡️' },
  { id: 'then', label: 'Then', icon: '🔄' },
  { id: 'messages', label: 'Messages', icon: '💬' },
] as const;

export type TabId = Tab['id'];

export const DEFAULT_TAB: TabId = 'now';

export function isTabId(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}
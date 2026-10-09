import type { FloatPos, FloatSize } from '../content/shell/float-drag';
export type WorkspaceState = {
  mode: 'home' | 'inbox' | 'ask' | 'memory';
  splitCategory: string;
  inboxSection: 'mail' | 'sent' | 'waiting';
  cloudSection: string;
  display: 'float' | 'dock';
  open: boolean;
  position?: FloatPos;
  size?: FloatSize;
};
export const DEFAULT_WORKSPACE: WorkspaceState = { mode: 'home', splitCategory: 'RESPOND', inboxSection: 'mail', cloudSection: 'overview', display: 'float', open: true };
export function workspaceState(value: unknown, legacy?: unknown): WorkspaceState {
  const row = (value || legacy || {}) as Partial<WorkspaceState> & { mode?: string };
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return {
    ...DEFAULT_WORKSPACE,
    mode: row.mode === 'ask' || row.mode === 'inbox' || row.mode === 'memory' ? row.mode : 'home',
    splitCategory: ['PRIORITY', 'RESPOND', 'WAITING', 'FYI', 'NOTIFICATIONS', 'PROMOTIONS', 'NEWS', 'FOLLOW_UPS'].includes(row.splitCategory || '') ? row.splitCategory! : 'RESPOND',
    inboxSection: row.inboxSection === 'sent' || row.inboxSection === 'waiting' ? row.inboxSection : row.splitCategory === 'WAITING' ? 'waiting' : 'mail',
    cloudSection: typeof row.cloudSection === 'string' && /^[a-z_]{1,40}$/.test(row.cloudSection) ? row.cloudSection : 'overview',
    display: row.display === 'dock' ? 'dock' : 'float', open: row.open !== false,
    position: finite(row.position?.right) && finite(row.position?.top) ? { right: row.position.right, top: row.position.top } : undefined,
    size: finite(row.size?.width) && finite(row.size?.height) ? { width: row.size.width, height: row.size.height } : undefined,
  };
}

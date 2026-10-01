import type { PigeonBoxCapability } from '@pigeonbox/api-contract';

/** The web control plane's real sections, shared by discovery, settings and commands. */
export const CLOUD_FEATURES = [
  { id: 'briefings', title: 'Briefings', detail: 'A sourced view of replies, deadlines and meetings.', capability: 'cloud_automations' },
  { id: 'views', title: 'Smart Views', detail: 'Find conversations by intent. Review changes in Shadow Mode.', capability: 'cloud_automations' },
  { id: 'automations', title: 'Automations', detail: 'Prepare work with rules you control.', capability: 'cloud_automations' },
  { id: 'connections', title: 'Calendar', detail: 'Real availability and meeting context with calendar access.', capability: 'cloud_calendar' },
  { id: 'contacts', title: 'Contacts', detail: 'Recent conversations and open commitments.', capability: 'cloud_relationships' },
  { id: 'documents', title: 'Documents', detail: 'Share PDFs and see observed viewing activity.', capability: 'cloud_documents' },
  { id: 'sequences', title: 'Sequences', detail: 'Follow-up sequences with sending approvals.', capability: 'cloud_sequences' },
  { id: 'team', title: 'Team', detail: 'Shared threads, assignments and comments.', capability: 'cloud_team' },
  { id: 'developers', title: 'API / MCP', detail: 'Scoped access for your tools.', capability: 'cloud_mcp' },
] as const satisfies ReadonlyArray<{ id: string; title: string; detail: string; capability: PigeonBoxCapability }>;

export const CLOUD_SECTIONS: ReadonlySet<string> = new Set(['overview', 'approvals', 'activity', 'preferences', 'privacy', 'connections', ...CLOUD_FEATURES.map((feature) => feature.id)]);
export function cloudSection(value: unknown): string { return typeof value === 'string' && CLOUD_SECTIONS.has(value) ? value : 'overview'; }
export function availableCloudFeatures(capabilities: readonly string[]) { return CLOUD_FEATURES.filter((feature) => capabilities.includes(feature.capability)); }
export function openCloud(section: string) { chrome.runtime.sendMessage({ type: 'CLOUD_OPEN', section: cloudSection(section) }); }

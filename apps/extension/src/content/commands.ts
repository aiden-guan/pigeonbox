export const VISIBLE_COMMANDS = [
  { id: 'ask', label: 'Ask Pigeon' },
  { id: 'summarize', label: 'Summarize Thread' },
  { id: 'draft', label: 'Draft Reply' },
  { id: 'remind', label: 'Remind Me' },
  { id: 'archive', label: 'Archive' },
  { id: 'settings', label: 'Settings' },
  { id: 'mark_respond', label: 'Mark Respond' },
  { id: 'mark_waiting', label: 'Mark Waiting' },
  { id: 'mark_fyi', label: 'Mark FYI' },
  { id: 'cloud', label: 'PigeonBox Home' },
  { id: 'cloud_approvals', label: 'Open approvals' },
  { id: 'cloud_activity', label: 'Open Activity' },
  { id: 'cloud_briefings', label: 'Open briefing' },
  { id: 'cloud_views', label: 'Create Smart View' },
  { id: 'cloud_automations', label: 'Create automation' },
  { id: 'cloud_contacts', label: 'Search contacts' },
  { id: 'cloud_documents', label: 'Tracked documents' },
] as const;

export type CommandId = (typeof VISIBLE_COMMANDS)[number]['id'];

const IDS = new Set<string>(VISIBLE_COMMANDS.map((command) => command.id));

export function isVisibleCommand(id: string): id is CommandId {
  return IDS.has(id);
}

/** Commands that exist only with PigeonBox Cloud's always-on features; hidden otherwise. */
export const CLOUD_ONLY_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(VISIBLE_COMMANDS.filter((item) => item.id.startsWith('cloud')).map((item) => item.id));

const FEATURE: Record<string, string> = { cloud_briefings: 'cloud_automations', cloud_views: 'cloud_automations', cloud_automations: 'cloud_automations', cloud_contacts: 'cloud_relationships', cloud_documents: 'cloud_documents' };
export function paletteCommands(filter: string, cloudAvailable: boolean, context: { thread: boolean; capabilities: readonly string[] } = { thread: true, capabilities: [] }) {
  const needle = filter.toLowerCase();
  const threadCommands = new Set(['summarize', 'draft', 'remind', 'archive', 'mark_respond', 'mark_waiting', 'mark_fyi']);
  return VISIBLE_COMMANDS.filter((command) => command.label.toLowerCase().includes(needle)
    && (cloudAvailable || !CLOUD_ONLY_COMMANDS.has(command.id))
    && (context.thread || !threadCommands.has(command.id))
    && (!FEATURE[command.id] || context.capabilities.includes(FEATURE[command.id])))
    .sort((a, b) => Number(threadCommands.has(b.id)) - Number(threadCommands.has(a.id)));
}

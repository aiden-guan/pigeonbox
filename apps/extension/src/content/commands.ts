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
  { id: 'cloud', label: 'Approvals & Ask Pigeon' },
] as const;

export type CommandId = (typeof VISIBLE_COMMANDS)[number]['id'];

const IDS = new Set<string>(VISIBLE_COMMANDS.map((command) => command.id));

export function isVisibleCommand(id: string): id is CommandId {
  return IDS.has(id);
}

/** Commands that exist only with PigeonBox Cloud's always-on features; hidden otherwise. */
export const CLOUD_ONLY_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['cloud']);

export function paletteCommands(filter: string, cloudAvailable: boolean) {
  const needle = filter.toLowerCase();
  return VISIBLE_COMMANDS.filter((command) => command.label.toLowerCase().includes(needle) && (cloudAvailable || !CLOUD_ONLY_COMMANDS.has(command.id)));
}

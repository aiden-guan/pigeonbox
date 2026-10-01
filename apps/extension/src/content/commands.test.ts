import { describe, expect, it } from 'vitest';
import { isVisibleCommand, paletteCommands, VISIBLE_COMMANDS } from './commands';

describe('commands', () => {
  it('only exposes commands that have real handlers', () => {
    expect(VISIBLE_COMMANDS.map((command) => command.id)).toEqual([
      'ask',
      'summarize',
      'draft',
      'remind',
      'archive',
      'settings',
      'mark_respond',
      'mark_waiting',
      'mark_fyi',
      'cloud', 'cloud_approvals', 'cloud_activity', 'cloud_briefings', 'cloud_views', 'cloud_automations', 'cloud_contacts', 'cloud_documents',
    ]);
    for (const command of VISIBLE_COMMANDS) expect(isVisibleCommand(command.id)).toBe(true);
    expect(isVisibleCommand('index')).toBe(false);
    expect(isVisibleCommand('always_archive')).toBe(false);
  });

  it('shows Cloud commands only when Cloud’s always-on features are on', () => {
    expect(paletteCommands('', false).map((command) => command.id)).not.toContain('cloud');
    expect(paletteCommands('', true).map((command) => command.id)).toContain('cloud');
    expect(paletteCommands('approv', true).map((command) => command.id)).toEqual(['cloud_approvals']);
  });
});

it('filters thread-only and ungranted commands, with context first', () => {
  expect(paletteCommands('', true, { thread: false, capabilities: [] }).map((item) => item.id)).not.toContain('summarize');
  expect(paletteCommands('', true, { thread: false, capabilities: [] }).map((item) => item.id)).not.toContain('cloud_documents');
  expect(paletteCommands('', true, { thread: true, capabilities: ['cloud_documents'] })[0].id).toBe('summarize');
});

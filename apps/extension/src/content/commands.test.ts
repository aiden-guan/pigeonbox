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
      'cloud',
    ]);
    for (const command of VISIBLE_COMMANDS) expect(isVisibleCommand(command.id)).toBe(true);
    expect(isVisibleCommand('index')).toBe(false);
    expect(isVisibleCommand('always_archive')).toBe(false);
  });

  it('shows Cloud commands only when Cloud’s always-on features are on', () => {
    expect(paletteCommands('', false).map((command) => command.id)).not.toContain('cloud');
    expect(paletteCommands('', true).map((command) => command.id)).toContain('cloud');
    expect(paletteCommands('approv', true).map((command) => command.id)).toEqual(['cloud']);
  });
});

import { describe, expect, it } from 'vitest';
import { SEQUENCE_MS, SHORTCUTS, chordOf, createKeyboardLayer, displayKeys } from './keyboard';

const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
const idle = { typing: false, inCompose: false };

describe('chordOf', () => {
  it('names letters, Shift chords and symbols', () => {
    expect(chordOf(key('e'))).toBe('e');
    expect(chordOf(key('U', { shiftKey: true }))).toBe('shift+u');
    expect(chordOf(key('#', { shiftKey: true }))).toBe('#');
    expect(chordOf(key('?', { shiftKey: true }))).toBe('?');
    expect(chordOf(key('L', { metaKey: true, shiftKey: true }))).toBe('mod+shift+l');
    expect(chordOf(key('Enter'))).toBe('enter');
    expect(chordOf(key('e', { altKey: true }))).toBeNull();
    expect(chordOf(key('Shift', { shiftKey: true }))).toBeNull();
  });
});

describe('keyboard layer', () => {
  it('maps single keys to triage commands', () => {
    const layer = createKeyboardLayer();
    expect(layer.resolve(key('e'), idle)).toBe('archive');
    expect(layer.resolve(key('j'), idle)).toBe('next');
    expect(layer.resolve(key('H', { shiftKey: true }), idle)).toBe('remind');
    expect(layer.resolve(key('1'), idle)).toBe('mark_respond');
    expect(layer.resolve(key('?', { shiftKey: true }), idle)).toBe('help');
  });

  it('completes "g" sequences within the window and drops them after it', () => {
    const layer = createKeyboardLayer();
    expect(layer.resolve(key('g'), idle, 1000)).toBeNull();
    expect(layer.pending(1000)).toBe(true);
    expect(layer.resolve(key('i'), idle, 1500)).toBe('go_inbox');
    expect(layer.resolve(key('g'), idle, 2000)).toBeNull();
    // Too late: "s" is star on its own.
    expect(layer.resolve(key('s'), idle, 2000 + SEQUENCE_MS + 1)).toBe('star');
  });

  it('ignores plain keys while typing but lets compose chords through', () => {
    const layer = createKeyboardLayer();
    expect(layer.resolve(key('e'), { typing: true, inCompose: true })).toBeNull();
    expect(layer.resolve(key('L', { metaKey: true, shiftKey: true }), { typing: true, inCompose: true })).toBe('send_later');
    expect(layer.resolve(key(';', { ctrlKey: true }), { typing: true, inCompose: true })).toBe('snippets');
    // Compose chords do nothing outside a compose.
    expect(layer.resolve(key('L', { metaKey: true, shiftKey: true }), idle)).toBeNull();
    expect(layer.resolve(key('L', { metaKey: true, shiftKey: true }), { typing: true, inCompose: false })).toBeNull();
  });

  it('has no two shortcuts on the same keys', () => {
    const keys = SHORTCUTS.map((item) => item.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('displayKeys', () => {
  it('uses platform modifiers', () => {
    expect(displayKeys('mod+shift+l', true)).toBe('⌘ ⇧ L');
    expect(displayKeys('mod+shift+l', false)).toBe('Ctrl ⇧ L');
    expect(displayKeys('g i', true)).toBe('G then I');
  });
});

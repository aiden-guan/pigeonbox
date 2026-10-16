import { describe, expect, it } from 'vitest';
import { cleanSnippets } from './snippets';

describe('cleanSnippets', () => {
  it('keeps valid snippets, normalizes names and drops duplicates and junk', () => {
    const out = cleanSnippets([
      { id: 'a', name: ';Intro', body: 'Hi {first_name}' },
      { id: 'b', name: 'intro', body: 'duplicate' },
      { name: 'bad name', body: 'x' },
      { name: 'empty', body: '   ' },
      'nope',
      { name: 'thanks', body: 'Thanks!' },
    ]);
    expect(out.map((item) => item.name)).toEqual(['intro', 'thanks']);
    expect(out[0]!.id).toBe('a');
    expect(out[1]!.id).toMatch(/^[\w-]+$/);
  });

  it('accepts nothing that is not a list', () => {
    expect(cleanSnippets({ name: 'x' })).toEqual([]);
  });
});

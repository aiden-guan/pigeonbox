// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fillSnippet, searchSnippets, triggerBefore, variablesFor, type Snippet } from './snippets';

const snippets: Snippet[] = [
  { id: '1', name: 'intro', body: 'Hi {first_name}, great to meet you. — {my_name}' },
  { id: '2', name: 'thanks', body: 'Thanks so much!' },
  { id: '3', name: 'calendly', body: 'Grab a time that works: https://cal.example/me' },
];

describe('snippet variables', () => {
  it('uses the display name, then the address', () => {
    expect(variablesFor({ name: 'Ada Lovelace', emailAddress: 'ada@example.com' }, 'Aiden')).toEqual({ firstName: 'Ada', lastName: 'Lovelace', name: 'Ada Lovelace', email: 'ada@example.com', myName: 'Aiden' });
    expect(variablesFor({ name: '', emailAddress: 'grace.hopper@example.com' }, '').firstName).toBe('Grace');
    expect(variablesFor(null, 'Aiden').firstName).toBe('');
  });

  it('fills known variables and leaves other braces alone', () => {
    const vars = variablesFor({ name: 'Ada Lovelace', emailAddress: 'ada@example.com' }, 'Aiden');
    expect(fillSnippet(snippets[0]!.body, vars)).toBe('Hi Ada, great to meet you. — Aiden');
    expect(fillSnippet('{unknown} {email}', vars)).toBe('{unknown} ada@example.com');
    expect(fillSnippet('{date}', vars, new Date(2026, 9, 15))).toMatch(/15/);
  });
});

describe('snippet triggers', () => {
  it('finds ;name at the caret only at a word start', () => {
    expect(triggerBefore('Sure! ;intro', snippets)).toEqual({ snippet: snippets[0], length: 6 });
    expect(triggerBefore(';thanks', snippets)?.snippet.name).toBe('thanks');
    expect(triggerBefore('a;intro', snippets)).toBeNull();
    expect(triggerBefore(';nope', snippets)).toBeNull();
  });

  it('ranks name prefixes first in the picker', () => {
    expect(searchSnippets(snippets, 'ca').map((item) => item.name)).toEqual(['calendly']);
    expect(searchSnippets(snippets, ';th').map((item) => item.name)).toEqual(['thanks', 'calendly']);
    expect(searchSnippets(snippets, 'time').map((item) => item.name)).toEqual(['calendly']);
    expect(searchSnippets(snippets, '')).toHaveLength(3);
  });
});

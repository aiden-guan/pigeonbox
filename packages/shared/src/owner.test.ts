import { describe, expect, it } from 'vitest';
import { createOwnerMatcher, ownerPerspectiveKey, summaryPerspectiveIssue, tagAuthors } from './owner';
const owner = { email: 'aiden.guan@gmail.com', name: 'Aiden Guan', aliases: ['aiden@school.test'] };
const mine = { sender: 'Aiden Guan <aiden.guan@gmail.com>', bodyText: 'I sent the revised scope.' };
const other = { sender: 'Maya Chen <maya@work.test>', bodyText: 'Please send pricing.' };
describe('deterministic mailbox perspective', () => {
  it.each([[mine, other], [other, mine]])('tags earlier and newest owner messages before inference', (a, b) => {
    const tagged = tagAuthors([a, b], owner);
    expect(tagged.find((message) => message.sender === mine.sender)?.authorRole).toBe('owner');
    expect(tagged.find((message) => message.sender === other.sender)?.authorRole).toBe('other');
  });
  it('recognizes explicit aliases, Gmail dots/plus/googlemail and me labels', () => {
    const match = createOwnerMatcher({ owner, contacts: [{ name: 'me', email: 'aiden@alias.test' }] });
    for (const sender of ['aiden@school.test', 'aidenguan+project@googlemail.com', 'me <aiden@alias.test>', 'you']) expect(match(sender)).toBe(true);
    expect(match('Maya <maya@work.test>')).toBe(false);
  });
  it('does not infer an alias from a same-name contact with another real address', () => {
    const same = { sender: 'Aiden Guan <aiden@unrelated.test>' };
    expect(tagAuthors([mine, same], owner).map((message) => message.authorRole)).toEqual(['owner', 'other']);
    expect(summaryPerspectiveIssue({ oneLine: 'Aiden sent the contract.' }, { owner, messages: [mine, same] })).toBe(false);
  });
  it('recomputes stale author roles when the account changes', () => {
    expect(tagAuthors([{ ...mine, authorRole: 'owner' as const }], { email: 'maya@work.test' })[0]?.authorRole).toBe('other');
  });
  it('keys unresolved, discovered, changed owners and alias sets independently', () => {
    expect(ownerPerspectiveKey(undefined)).not.toBe(ownerPerspectiveKey(owner));
    expect(ownerPerspectiveKey(owner)).not.toBe(ownerPerspectiveKey({ email: 'maya@work.test' }));
    expect(ownerPerspectiveKey(owner)).toBe(ownerPerspectiveKey({ ...owner, aliases: ['aiden@school.test', 'aiden@school.test'] }));
    expect(ownerPerspectiveKey(owner)).not.toBe(ownerPerspectiveKey({ ...owner, aliases: [] }));
  });
  it('rejects third-person actors while preserving quoted text and third-party mentions', () => {
    const input = { owner, messages: [mine, other] };
    expect(summaryPerspectiveIssue({ oneLine: 'Aiden sent the revised scope.' }, input)).toBe(true);
    expect(summaryPerspectiveIssue({ keyPoints: ['Aiden Guan confirmed annual billing.'] }, input)).toBe(true);
    expect(summaryPerspectiveIssue({ oneLine: 'You sent the revised scope.' }, input)).toBe(false);
    expect(summaryPerspectiveIssue({ oneLine: 'Maya asked about Aiden’s work.' }, input)).toBe(false);
    expect(summaryPerspectiveIssue({ oneLine: 'Maya quoted “Aiden sent the scope.”' }, input)).toBe(false);
  });
  it('uses the owner-authored source name when Gmail has no display name yet', () => {
    expect(summaryPerspectiveIssue({ oneLine: 'Aiden sent the revised scope.' }, { owner: { email: owner.email }, messages: [mine] })).toBe(true);
    expect(summaryPerspectiveIssue({ oneLine: 'Aiden sent the scope.' }, { owner, messages: [other] })).toBe(false);
  });
});

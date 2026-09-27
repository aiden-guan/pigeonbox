import { describe, expect, it } from 'vitest';
import { inAskWindow, LexicalSearchIndex, parseAskQuery, parseComposeRequest } from '@pigeonbox/search';

// Friday, Sep 26 2026, 10:00 local time.
const NOW = new Date(2026, 8, 26, 10, 0, 0);

describe('parseAskQuery', () => {
  it('reads "what emails have i sent recently" as a list of sent mail with nothing to search for', () => {
    const q = parseAskQuery('what emails have i sent recently', NOW);
    expect(q).toMatchObject({ intent: 'list', direction: 'sent', recent: true, keywords: [] });
  });

  it.each([
    ['What did I send to Sarah last week?', 'sent'],
    ['did i email the landlord', 'sent'],
    ['show my sent mail', 'sent'],
    ['emails from me about the lease', 'sent'],
    ['what did John send me yesterday', 'received'],
    ['emails I got today', 'received'],
    ['who emailed me this week', 'received'],
    ['Find upcoming deadlines', null],
  ])('%s → direction %s', (query, direction) => {
    expect(parseAskQuery(query, NOW).direction).toBe(direction);
  });

  it('keeps only the words worth searching for', () => {
    expect(parseAskQuery('What did I email Sarah about the lease?', NOW).keywords).toEqual(['sarah', 'lease']);
    expect(parseAskQuery('Find upcoming deadlines', NOW).keywords).toEqual(['upcoming', 'deadlines']);
  });

  it('recognises reply and waiting questions', () => {
    expect(parseAskQuery('What needs a reply?', NOW).intent).toBe('needs_reply');
    expect(parseAskQuery('who hasnt replied to me', NOW).intent).toBe('waiting');
    expect(parseAskQuery('did Sam open my email', NOW)).toMatchObject({ intent: 'waiting', direction: 'sent', keywords: ['sam'] });
  });

  it('turns time phrases into windows', () => {
    const today = parseAskQuery('what did I send today', NOW);
    expect(new Date(today.since!).getDate()).toBe(26);
    expect(today.until).toBeNull();

    const yesterday = parseAskQuery('emails from yesterday', NOW);
    expect(new Date(yesterday.since!).getDate()).toBe(25);
    expect(new Date(yesterday.until!).getDate()).toBe(26);

    // Monday Sep 14 to Monday Sep 21.
    const lastWeek = parseAskQuery('what did I send last week', NOW);
    expect(new Date(lastWeek.since!).getDate()).toBe(14);
    expect(new Date(lastWeek.until!).getDate()).toBe(21);

    const rolling = parseAskQuery('emails in the last week', NOW);
    expect(new Date(rolling.since!).getDate()).toBe(19);

    const days = parseAskQuery('mail from the past 3 days', NOW);
    expect(Date.parse(days.since!)).toBe(NOW.getTime() - 3 * 86_400_000);
  });

  it('reads counts', () => {
    expect(parseAskQuery('my last 5 sent emails', NOW)).toMatchObject({ intent: 'list', limit: 5, direction: 'sent' });
  });

  it('filters timestamps by window', () => {
    const q = parseAskQuery('what did I send yesterday', NOW);
    expect(inAskWindow(new Date(2026, 8, 25, 15).toISOString(), q)).toBe(true);
    expect(inAskWindow(new Date(2026, 8, 26, 9).toISOString(), q)).toBe(false);
    expect(inAskWindow('', q)).toBe(false);
    expect(inAskWindow('', parseAskQuery('anything', NOW))).toBe(true);
  });
});

describe('lexical search ignores filler words', () => {
  it('does not match every thread on "i" or "have"', () => {
    const idx = new LexicalSearchIndex();
    const doc = (id: string, subject: string, text: string) => ({
      id,
      threadId: id,
      subject,
      text,
      senders: '',
      recipients: '',
      labels: '',
      timestamp: '2026-09-01T00:00:00Z',
      fingerprint: id,
    });
    idx.upsert(doc('math', '[SLC Math 52] Integration strategies', 'I have included the integration worksheet'));
    idx.upsert(doc('lease', 'Lease renewal', 'Is the lease ready to sign?'));
    expect(idx.search('what emails have i sent recently')).toEqual([]);
    expect(idx.search('lease').map((hit) => hit.threadId)).toEqual(['lease']);
    expect(idx.search('integration').map((hit) => hit.threadId)).toEqual(['math']);
  });
});

describe('parseComposeRequest', () => {
  it.each([
    ['draft an email to Dylan Nguyen saying hi?', 'Dylan Nguyen'],
    ['Could you draft an email to this person about the meeting', null],
    ['can you write a quick note to sam@example.com about the lease', 'sam@example.com'],
    ['Please write an email for Priya thanking her for the intro', 'Priya'],
    ['write an email for the team offsite', null],
    ['email Sarah saying I will be ten minutes late', 'Sarah'],
    ['compose a message to the landlord asking about the deposit', 'landlord'],
    ['Draft a reply to George, tell him Tuesday works', 'George'],
  ])('%s → recipient %s', (query, recipient) => {
    expect(parseComposeRequest(query)).toEqual({ recipient });
  });

  it.each([
    'What did I write to Sarah last week?',
    'did i email the landlord',
    'email from Dylan about the meeting',
    'Find the draft agreement',
    'What needs a reply?',
  ])('does not treat "%s" as a request to write', (query) => {
    expect(parseComposeRequest(query)).toBeNull();
  });

  it('sets the compose intent and drops drafting words from the keywords', () => {
    expect(parseAskQuery('draft an email to Dylan saying thanks for the budget review', NOW)).toMatchObject({
      intent: 'compose',
      keywords: ['dylan', 'thanks', 'budget', 'review'],
    });
  });
});


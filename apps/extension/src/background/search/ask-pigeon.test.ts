import { describe, expect, it, vi } from 'vitest';
import type { IndexCoverage, MessageRow, SearchDocumentRow, ThreadRow } from '@pigeonbox/mailbox';
import { LexicalSearchIndex } from '@pigeonbox/search';
import type { TrackedEmailSummary } from '@pigeonbox/tracking';
import { answerAskPigeon, splitDraft, type AskPigeonInput } from './ask-pigeon';

const NOW = new Date('2026-09-26T17:00:00Z');
const OWNER = { email: 'aiden@example.com', name: 'Aiden' };

function thread(id: string, patch: Partial<ThreadRow> = {}): ThreadRow {
  return {
    threadId: id,
    accountId: 'default',
    subject: id,
    participants: [],
    latestTimestamp: '2026-09-20T12:00:00Z',
    messageCount: 1,
    snippet: '',
    route: 'inbox',
    lastIndexedAt: 0,
    contentFingerprint: id,
    archivedLocally: false,
    requiresResponse: false,
    awaitingResponse: false,
    virtualLabels: [],
    ...patch,
  };
}

function message(threadId: string, from: string, to: string, timestamp: string, bodyText = 'Hello'): MessageRow {
  return {
    messageId: `${threadId}-${timestamp}`,
    threadId,
    accountId: 'default',
    sender: { email: from },
    recipients: [{ email: to }],
    cc: [],
    timestamp,
    bodyText,
    attachmentsMetadata: [],
    fingerprint: `${threadId}-${timestamp}`,
  };
}

function tracked(id: string, patch: Partial<TrackedEmailSummary> = {}): TrackedEmailSummary {
  return {
    trackingId: id,
    status: 'SENT',
    subject: `Tracked ${id}`,
    sender: OWNER.email,
    recipients: ['sam@example.com'],
    gmailThreadId: null,
    gmailMessageId: null,
    sentAt: '2026-09-25T10:00:00Z',
    firstOpenedAt: null,
    lastOpenedAt: null,
    openCount: 0,
    clickCount: 0,
    notifyIfNoReply: false,
    ...patch,
  };
}

const coverage: IndexCoverage = {
  inboxCoverage: 'partial',
  recentMailCoverage: 'partial',
  sentMailCoverage: 'none',
  totalIndexedThreads: 4,
  oldestIndexedDate: '2026-09-01T00:00:00Z',
  newestIndexedDate: '2026-09-25T00:00:00Z',
  lastSuccessfulScan: null,
  state: 'idle',
};

function input(patch: Partial<AskPigeonInput>): AskPigeonInput {
  const threads = patch.threads ?? [];
  const lexical = new LexicalSearchIndex();
  const docs: SearchDocumentRow[] = threads.map((row) => ({
    id: row.threadId,
    threadId: row.threadId,
    subject: row.subject,
    text: `${row.subject}\n${row.snippet}`,
    senders: row.participants.map((p) => p.email).join(' '),
    recipients: '',
    labels: '',
    timestamp: row.latestTimestamp,
    fingerprint: row.contentFingerprint,
  }));
  for (const doc of docs) lexical.upsert(doc);
  return {
    query: '',
    now: NOW,
    threads,
    messages: [],
    searchDocuments: docs,
    lexical,
    owner: OWNER,
    tracked: [],
    coverage,
    answerWithModel: null,
    ...patch,
  };
}

describe('answerAskPigeon', () => {
  const mathThreads = ['[SLC Math 52] Topic reviews', '[SLC Math 52] Exam reviews', 'Thanks for filling out this form'].map((subject, i) =>
    thread(`math${i}`, { subject, latestSender: { email: 'math52@berkeley.edu', name: 'SLC Math 52' }, latestTimestamp: `2026-09-2${i}T09:00:00Z` }),
  );

  it('lists sent mail for "what emails have i sent recently" without calling the model', async () => {
    const model = vi.fn();
    const result = await answerAskPigeon(
      input({
        query: 'what emails have i sent recently',
        threads: [
          ...mathThreads,
          thread('lease', { subject: 'Lease renewal', latestTimestamp: '2026-09-24T09:00:00Z' }),
          thread('rowSent', { subject: 'Seen in Sent', seenInSent: true, latestSender: { email: 'kim@example.com', name: 'Kim' }, latestTimestamp: '2026-09-23T09:00:00Z' }),
        ],
        messages: [message('lease', OWNER.email, 'landlord@example.com', '2026-09-24T09:00:00Z')],
        tracked: [tracked('t1', { subject: 'Coffee next week?', openCount: 2, lastOpenedAt: '2026-09-25T12:00:00Z' })],
        answerWithModel: model,
      }),
    );
    expect(model).not.toHaveBeenCalled();
    expect(result.answer).toMatch(/most recent sent emails/);
    expect(result.items?.map((item) => item.subject)).toEqual(['Coffee next week?', 'Lease renewal', 'Seen in Sent']);
    expect(result.items?.[0]).toMatchObject({ who: 'to sam@example.com', status: 'Opened 2×', opened: true });
    expect(result.items?.[1]?.who).toBe('to landlord@example.com');
    expect(result.coverageNote).toMatch(/Sent folder/);
  });

  it('lists threads that need a reply', async () => {
    const result = await answerAskPigeon(
      input({
        query: 'What needs a reply?',
        threads: [...mathThreads, thread('ask', { subject: 'Can you review?', classification: 'RESPOND', latestSender: { email: 'dana@example.com', name: 'Dana' } })],
      }),
    );
    expect(result.items?.map((item) => item.threadId)).toEqual(['ask']);
    expect(result.answer).toBe('1 thread still needs a reply from you.');
  });

  it('leaves out threads where you already had the last word, automated mail and list mail', async () => {
    const q = (id: string, patch: Partial<ThreadRow> = {}) => thread(id, { classification: 'RESPOND', requiresResponse: true, ...patch });
    const signedInAs = { email: 'aiden@example.com', name: 'Aiden Guan' };
    const fromSchool = (threadId: string, timestamp: string, body = 'thanks!') => ({
      ...message(threadId, 'aidenguan@berkeley.edu', 'arlan@example.com', timestamp, body),
      sender: { email: 'aidenguan@berkeley.edu', name: 'Aiden Haoyu Guan' },
    });
    const result = await answerAskPigeon(
      input({
        query: 'What are some emails that I need to respond to?',
        owner: signedInAs,
        threads: [
          // You replied last, from your school address.
          q('founders', { subject: 'founders seeking advice', latestSender: { email: 'dylan@example.com', name: 'Dylan' } }),
          // Gmail's row says "me".
          q('rowMe', { subject: 'quick question (not selling anything)', latestSender: { email: 'aiden@example.com', name: 'me' } }),
          // Nothing readable about who wrote it.
          q('unknown', { subject: 'quick question (not selling anything)' }),
          // Your own calendar invite, and one from someone else.
          q('invite', { subject: 'Invitation: George and Aiden Guan + Dylan', latestSender: { email: 'to dylan@example.com', name: 'To: dylan@example.com' } }),
          q('theirInvite', { subject: 'Updated invitation: Standup', latestSender: { email: 'calendar-notification@google.com', name: 'Google Calendar' } }),
          q('list', { subject: '[Tokens&] Help us run our upcoming hackathons?', latestSender: { email: 'fatima@example.com', name: 'Fatima' } }),
          q('real', { subject: 'Final RSVP', latestSender: { email: 'aj@example.com', name: 'AJ Green' } }),
          q('replied', { subject: 'Lunch?', latestSender: { email: 'sam@example.com', name: 'Sam' } }),
        ],
        messages: [
          message('founders', 'dylan@example.com', 'arlan@example.com', '2026-09-19T17:10:00Z', 'any advice?'),
          message('founders', 'arlan@example.com', 'dylan@example.com', '2026-09-19T17:12:00Z', 'what made you pivot?'),
          fromSchool('founders', '2026-09-20T17:47:00Z', 'what made you decide to pivot?'),
          { ...message('unknown', 'unknown@local', 'basu@example.com', '2026-09-20T10:00:00Z', 'quick question?') },
          message('list', 'fatima@example.com', 'tokens@googlegroups.com', '2026-09-22T10:00:00Z', 'Can you help?'),
          message('real', 'aj@example.com', 'aiden@example.com', '2026-09-23T10:00:00Z', 'Are you coming?'),
          message('replied', 'sam@example.com', 'aiden@example.com', '2026-09-21T10:00:00Z', 'Lunch Friday?'),
        ],
        // You answered Sam from a tracked send that was never indexed.
        tracked: [tracked('lunch', { gmailThreadId: 'replied', sentAt: '2026-09-21T12:00:00Z' })],
      }),
    );
    expect(result.items?.map((item) => item.threadId)).toEqual(['real']);
    expect(result.items?.[0]?.who).toBe('aj@example.com');
  });

  it('trusts every address the user has been signed in as', async () => {
    const result = await answerAskPigeon(
      input({
        query: 'what do I need to reply to',
        ownerAliases: ['aidenguan@berkeley.edu'],
        threads: [thread('a', { classification: 'RESPOND', subject: 'Question' })],
        messages: [
          message('a', 'kim@example.com', 'aidenguan@berkeley.edu', '2026-09-20T10:00:00Z', 'Can you?'),
          message('a', 'aidenguan@berkeley.edu', 'kim@example.com', '2026-09-20T11:00:00Z', 'Yes.'),
        ],
      }),
    );
    expect(result.items).toEqual([]);
  });

  it('reports open status for tracked mail when asked who has not replied', async () => {
    const result = await answerAskPigeon(
      input({
        query: 'who hasnt replied to me',
        tracked: [tracked('a'), tracked('b', { openCount: 1, sentAt: '2026-09-24T10:00:00Z' }), tracked('c', { status: 'CANCELLED' })],
      }),
    );
    expect(result.items?.map((item) => item.status)).toEqual(['Not opened', 'Opened']);
    expect(result.answer).toBe('2 emails waiting on a reply. 1 not opened yet.');
  });

  it('gives the model sender, recipient and date for each thread', async () => {
    const model = vi.fn(async () => ({ answer: 'You asked about the lease.', citations: [{ threadId: 'lease', subject: 'Lease renewal' }, { threadId: 'nope', subject: 'x' }], incompleteIndex: false }));
    const result = await answerAskPigeon(
      input({
        query: 'what did I tell the landlord about the lease',
        threads: [...mathThreads, thread('lease', { subject: 'Lease renewal', snippet: 'lease' })],
        messages: [message('lease', OWNER.email, 'landlord@example.com', '2026-09-24T09:00:00Z', 'I will sign the lease on Monday.')],
        answerWithModel: model,
      }),
    );
    const call = model.mock.calls[0]![0] as { contextChunks: Array<{ threadId: string; text: string }>; coverageNote: string };
    expect(call.contextChunks[0]?.threadId).toBe('lease');
    expect(call.contextChunks[0]?.text).toMatch(/^Status: only you have written/);
    expect(call.contextChunks[0]?.text).toContain('From: you');
    expect(call.contextChunks[0]?.text).toContain('To: landlord@example.com');
    expect(call.contextChunks[0]?.text).toMatch(/Date: .*Sep 24/);
    expect(call.contextChunks.some((chunk) => chunk.threadId.startsWith('math'))).toBe(false);
    expect(call.coverageNote).toContain('Aiden <aiden@example.com>');
    expect(result.citations).toEqual([{ threadId: 'lease', subject: 'Lease renewal' }]);
  });

  it('says so when nothing matches', async () => {
    const result = await answerAskPigeon(input({ query: 'quarterly tax invoice', threads: mathThreads }));
    expect(result.answer).toMatch(/No matching threads/);
    expect(result.citations).toEqual([]);
  });
});

describe('drafting from Ask', () => {
  const dylan = { email: 'dylan@example.com', name: 'Dylan Do Nguyen' };
  const threads = [
    thread('meet', { subject: 'AI Solutions @ Berkeley', participants: [dylan], latestSender: dylan, latestTimestamp: '2026-09-22T09:00:00Z' }),
    thread('other', { subject: 'Weekly digest', participants: [{ email: 'news@example.com', name: 'Dylan Weekly' }] }),
  ];

  it('finds the recipient, gives the model their threads, and returns a draft', async () => {
    const model = vi.fn(async () => ({
      answer: 'Subject: Hi Dylan!\n\nHi Dylan,\n\nJust wanted to say hi.\n\nBest,\n[Your Name]',
      citations: [],
      incompleteIndex: false,
    }));
    const result = await answerAskPigeon(input({ query: 'draft an email to Dylan Nguyen saying hi', threads, answerWithModel: model }));
    const call = model.mock.calls[0]![0] as { query: string; contextChunks: Array<{ threadId: string }> };
    expect(call.query).toContain('Recipient: Dylan Do Nguyen <dylan@example.com>');
    expect(call.contextChunks.map((chunk) => chunk.threadId)).toEqual(['meet']);
    expect(result.draft).toEqual({
      to: [dylan],
      subject: 'Hi Dylan!',
      body: 'Hi Dylan,\n\nJust wanted to say hi.\n\nBest,\nAiden',
    });
    expect(result.answer).toBe("Here's a draft to Dylan Do Nguyen.");
  });

  it('still drafts when the recipient is not in the index, and says to add them', async () => {
    const model = vi.fn(async () => ({ answer: 'Subject: Hello\n\nHi Morgan!', citations: [], incompleteIndex: false }));
    const result = await answerAskPigeon(input({ query: 'write an email to Morgan saying hello', threads, answerWithModel: model }));
    expect(result.draft).toEqual({ to: [], subject: 'Hello', body: 'Hi Morgan!' });
    expect(result.answer).toMatch(/couldn't find Morgan's address/);
  });

  it('asks for AI instead of guessing when AI is off', async () => {
    const result = await answerAskPigeon(input({ query: 'draft an email to Dylan saying hi', threads }));
    expect(result.draft).toBeUndefined();
    expect(result.answer).toMatch(/Turn on AI/);
  });

  it('splits subject and body out of loosely formatted model output', () => {
    expect(splitDraft('```\n**Subject:** Lunch?\nTo: sam@example.com\n\nHey Sam,\nLunch Friday?\n[Signature]\n```', 'Aiden')).toEqual({
      subject: 'Lunch?',
      body: 'Hey Sam,\nLunch Friday?',
    });
    expect(splitDraft('Hey Sam, lunch Friday?', '')).toEqual({ subject: '', body: 'Hey Sam, lunch Friday?' });
  });
});


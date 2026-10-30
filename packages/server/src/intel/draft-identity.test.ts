import { describe, expect, it } from 'vitest';
import { ensureRecipientGreeting, ensureSignature, signerName } from './draft-identity.js';
import { replyRecipients, threadPeople, type ReadMessage, type ReadThread } from './thread-reader.js';

describe('draft identity and punctuation', () => {
  it.each(['Best\nAiden', 'Best,\nAiden', 'Best\nAlex', 'Best, Alex', 'Best', 'Best!\n[Your Name]', 'Best\n\nAiden'])('normalizes the terminal signature %j', (tail) => {
    const body = ensureSignature(`Sounds good.\n\n${tail}`, 'Aiden');
    expect(body).toBe('Sounds good.\n\nBest,\nAiden');
    expect(ensureSignature(body, 'Aiden')).toBe(body);
  });

  it('omits a model-invented signer when the owner name is unknown', () => {
    expect(ensureSignature('Yes.\n\nBest\nAlex', '')).toBe('Yes.\n\nBest,');
    expect(ensureSignature('Yes.', '')).toBe('Yes.');
  });

  it('preserves substantive sentences after a thank-you line', () => {
    expect(ensureSignature('Thanks,\nPlease send the proposal tomorrow.', 'Aiden')).toBe('Thanks,\nPlease send the proposal tomorrow.\n\nBest,\nAiden');
    expect(ensureSignature('Thanks, I will send it tomorrow.', 'Aiden')).toBe('Thanks, I will send it tomorrow.\n\nBest,\nAiden');
  });

  it('uses saved identity and sign-off without mistaking an owner mention for a signature', () => {
    expect(ensureSignature('I will ask Aiden about that.', 'Aiden', 'Cheers,')).toBe('I will ask Aiden about that.\n\nCheers,\nAiden');
    expect(ensureSignature('Yes.\n\nThanks,\nMaya', 'Aiden Guan', 'Best')).toBe('Yes.\n\nBest,\nAiden Guan');
    expect(ensureSignature('Thanks for organizing.', 'Aiden')).toBe('Thanks for organizing.\n\nBest,\nAiden');
    expect(ensureSignature('Aiden can help.\n\nAiden', 'Aiden')).toBe('Aiden can help.\n\nBest,\nAiden');
    expect(ensureSignature('Friday works. Aiden', 'Aiden')).toBe('Friday works.\n\nBest,\nAiden');
    expect(ensureSignature('Friday works. Best regards, Maya Chen', 'Aiden', 'Best')).toBe('Friday works.\n\nBest,\nAiden');
  });

  it('does not infer an owner name from an address or a reversed display name', () => {
    expect(signerName('', 'Guan, Aiden')).toBe('Aiden');
    expect(signerName('', 'Dr. Wei Chen')).toBe('Wei');
    expect(signerName('', 'Dr. Aiden Guan, Ph.D.')).toBe('Aiden');
    expect(signerName('', 'Guan, Aiden Jr.')).toBe('Aiden');
    expect(signerName('Aiden Guan', 'Different Account')).toBe('Aiden Guan');
    expect(signerName('[Your Name]', 'aiden@example.com')).toBe('');
  });

  it.each(['Hi Aiden,', 'Hello Alex,', 'Dear [Name],'])('removes an unsupported greeting %j', (greeting) => {
    expect(ensureRecipientGreeting(`${greeting}\n\nYes, Thursday works.`, [{ email: 'maya@test.com', name: 'Maya Chen' }]))
      .toBe('Hello,\n\nYes, Thursday works.');
  });

  it.each([
    ['Hi Maya,', 'Maya Chen'], ['Dear Dr. Chen,', 'Chen, Wei'], ['Hi José,', 'José García'],
    ["Hi Anne-Marie,", "Anne-Marie O’Neil"], ['Hi Aiden,', 'Aiden Smith'], ['Hi all,', ''],
  ])('preserves a supported or neutral greeting %j', (greeting, name) => {
    const body = `${greeting}\n\nYes.`;
    expect(ensureRecipientGreeting(body, [{ email: 'other@test.com', name }])).toBe(body);
  });

  it('keeps a name the person typed for a recipient with no header name', () => {
    expect(ensureRecipientGreeting('Hi Maya,\n\nYes.', [{ email: 'maya42@test.com' }], ['Email Maya at maya42@test.com'])).toBe('Hi Maya,\n\nYes.');
    expect(ensureRecipientGreeting('Hi Aiden,\n\nYes.', [{ email: 'maya42@test.com' }], ['Email Maya at maya42@test.com'])).toBe('Hello,\n\nYes.');
  });

  it('does not guess names from addresses, or treat ordinary prose as a salutation', () => {
    expect(ensureRecipientGreeting('Hi maya42,\n\nYes.', [{ email: 'maya42@test.com' }])).toBe('Hello,\n\nYes.');
    expect(ensureRecipientGreeting('Thank you for the update, Maya.', [])).toBe('Thank you for the update, Maya.');
  });
});

const message = (patch: Partial<ReadMessage>): ReadMessage => ({
  gmailMessageId: 'm1', rfc822MessageId: null, references: null, subject: 'Proposal', from: 'maya@test.com', fromName: 'Maya Chen',
  to: ['aiden@test.com'], cc: [], date: '2026-10-15T12:00:00Z', direction: 'inbound', isAuto: false, listUnsubscribe: false,
  text: 'Hi Aiden,\n\nPlease ask Alex to review this.\n\nMaya', attachments: [], ...patch,
});
const thread = (...messages: ReadMessage[]): ReadThread => ({ gmailThreadId: 'thread1', subject: 'Proposal', labels: [], messages });

describe('header-backed reply identities', () => {
  it('uses the latest incoming author even after an outgoing reply, never a name mentioned in prose', () => {
    const read = thread(message({}), message({ from: 'aiden@test.com', fromName: 'Aiden Guan', to: ['maya@test.com'], direction: 'outbound' }));
    expect(replyRecipients(read, 'aiden@test.com')).toEqual({ to: [{ email: 'maya@test.com', name: 'Maya Chen' }], cc: [] });
    expect(threadPeople(read.messages).some((person) => person.name === 'Alex')).toBe(false);
  });

  it('honors Reply-To and removes duplicate/self recipients', () => {
    const read = thread(message({ from: 'service@test.com', fromName: 'Support', replyTo: [{ email: 'agent@test.com', name: 'Priya Shah' }],
      to: ['aiden@test.com', 'agent@test.com', 'lee@test.com'], cc: ['lee@test.com', 'AIDEN@test.com'] }));
    expect(replyRecipients(read, 'aiden@test.com')).toEqual({ to: [{ email: 'agent@test.com', name: 'Priya Shah' }], cc: ['lee@test.com'] });
  });

  it('retains To names for follow-ups without any incoming message', () => {
    const read = thread(message({ from: 'aiden@test.com', fromName: 'Aiden Guan', direction: 'outbound',
      to: ['maya@test.com'], toPeople: [{ email: 'maya@test.com', name: 'Maya Chen' }] }));
    expect(replyRecipients(read, 'aiden@test.com', 'follow_up').to).toEqual([{ email: 'maya@test.com', name: 'Maya Chen' }]);
  });
});

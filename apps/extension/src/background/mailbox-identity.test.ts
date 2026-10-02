import { describe, expect, it } from 'vitest';
import { gmailAccountKey, MailboxIdentities, visibleSummaryForOwner, withSelfAliases } from './mailbox-identity';
import { ownerPerspectiveKey } from '@pigeonbox/shared';
describe('account-scoped Gmail identity', () => {
  it('keeps multiple tabs and signed-in slots independent, including persisted aliases', async () => {
    const store: Record<string, unknown> = {};
    const identities = new MailboxIdentities({ get: async (key: string) => ({ [key]: store[key] }), set: async (row: Record<string, unknown>) => { Object.assign(store, row); } } as never);
    const first = { email: 'first@gmail.com', aliases: ['first@school.test'] }; const second = { email: 'second@gmail.com' };
    await Promise.all([identities.remember(1, 'https://mail.google.com/mail/u/0/', first), identities.remember(2, 'https://mail.google.com/mail/u/1/', second)]);
    expect(await identities.resolve(1, 'https://mail.google.com/mail/u/0/')).toEqual(first);
    expect(await identities.resolve(2, 'https://mail.google.com/mail/u/1/')).toEqual(second);
    identities.forgetTab(1); expect(await identities.forEmail(first.email)).toEqual(first);
    expect(await identities.resolve(1, 'https://mail.google.com/mail/u/1/')).toEqual(second);
    expect(await identities.resolve(1, 'https://example.com/')).toBeUndefined();
  });
  it('honors an explicit identity once Gmail discovers it instead of the old slot owner', async () => {
    const identities = new MailboxIdentities({ get: async () => ({ mailboxIdentities: { '0': { email: 'old@fixture.test' } } }), set: async () => undefined } as never);
    expect(await identities.resolve(1, 'https://mail.google.com/mail/u/0/', { email: 'new@fixture.test' })).toEqual({ email: 'new@fixture.test' });
    expect(gmailAccountKey('https://mail.google.com/mail/?authuser=second%40gmail.com')).toBe('second@gmail.com');
  });
  it('retains explicit self aliases across account refreshes without carrying them to a different owner', async () => {
    const store: Record<string, unknown> = {};
    const identities = new MailboxIdentities({ get: async (key: string) => ({ [key]: store[key] }), set: async (row: Record<string, unknown>) => { Object.assign(store, row); } } as never);
    const url = 'https://mail.google.com/mail/u/0/';
    await identities.remember(1, url, { email: 'owner@gmail.com', name: 'Owner Name', aliases: ['owner@school.test'] });
    const refreshed = await identities.resolve(1, url, { email: 'owner@gmail.com' });
    expect(refreshed).toMatchObject({ name: 'Owner Name', aliases: ['owner@school.test'] });
    expect(await identities.resolve(undefined, undefined, { email: 'owner@gmail.com' })).toEqual(refreshed);
    expect(await identities.resolve(1, url, { email: 'other@gmail.com' })).toEqual({ email: 'other@gmail.com' });
  });
  it('hides summaries made without the current account perspective in every presentation', () => {
    const owner = { email: 'owner@fixture.test' };
    const current = { ownerPerspective: ownerPerspectiveKey(owner), summary: 'You sent the pricing.' };
    expect(visibleSummaryForOwner(current, owner)).toBe(current);
    expect(visibleSummaryForOwner({ ownerPerspective: undefined, summary: 'Owner sent the pricing.' }, owner)).toBeUndefined();
    expect(visibleSummaryForOwner(current)).toBeUndefined();
    expect(visibleSummaryForOwner(current, { email: 'other@fixture.test' })).toBeUndefined();
  });
  it('learns send-as addresses only from explicit Gmail self labels', () => {
    expect(withSelfAliases({ email: 'owner@gmail.com', name: 'Owner Name' }, [
      { email: 'owner@school.test', name: 'me' }, { email: 'someone@other.test', name: 'Owner Name' }, { email: 'unknown@local', name: 'you' },
    ]).aliases).toEqual(['owner@school.test']);
  });
});

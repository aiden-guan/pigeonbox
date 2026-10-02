/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailboxOwner, observeMailboxOwner } from './gmail-owner';
afterEach(() => { document.head.removeAttribute('data-inboxsdk-user-email-address'); document.title = ''; document.body.innerHTML = ''; });
describe('Gmail identity discovery', () => {
  it('waits for identity after thread markup and notifies when the account appears', async () => {
    document.body.innerHTML = '<main data-thread-perm-id="abc">Thread</main>';
    expect(mailboxOwner()).toBeUndefined();
    const changed = vi.fn(); const stop = observeMailboxOwner(changed);
    document.head.setAttribute('data-inboxsdk-user-email-address', 'owner@fixture.test');
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith({ email: 'owner@fixture.test', name: undefined }));
    stop();
  });
  it('uses the account label or final Gmail title address instead of a subject recipient', () => {
    document.title = 'Recipient person@other.test - owner@fixture.test - Gmail';
    expect(mailboxOwner()?.email).toBe('owner@fixture.test');
    document.body.innerHTML = '<a href="https://accounts.google.com/" aria-label="Google Account: Aiden Guan (aiden@gmail.com)"></a>';
    expect(mailboxOwner()).toEqual({ email: 'aiden@gmail.com', name: 'Aiden Guan' });
    document.head.setAttribute('data-inboxsdk-user-email-address', 'second@gmail.com');
    expect(mailboxOwner()).toEqual({ email: 'second@gmail.com', name: undefined });
  });
});

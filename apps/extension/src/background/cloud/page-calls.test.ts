import type { PigeonBoxCloudClient } from '@pigeonbox/cloud-client';
import { CloudApiError } from '@pigeonbox/cloud-client';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_ROUTES, pageCall } from './page-calls';

function fakeClient(handler: (route: string, body: unknown) => unknown) {
  const call = vi.fn(async (route: string, body: unknown) => handler(route, body));
  return { client: { call } as unknown as PigeonBoxCloudClient, call };
}

describe('extension page Cloud calls', () => {
  it('never lets extension pages reach billing, account deletion, tokens or webhooks', async () => {
    for (const route of ['billingCheckout', 'billingPortal', 'accountDelete', 'authToken', 'connectionDisconnect']) expect(PAGE_ROUTES.has(route as never)).toBe(false);
    const { client, call } = fakeClient(() => ({}));
    expect(await pageCall(client, 'accountDelete', { confirm: 'delete my account' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await pageCall(client, 'controlTokenCreate', {})).toMatchObject({ ok: false, code: 'forbidden' });
    expect(call).not.toHaveBeenCalled();
  });

  it('turns contract errors into plain reasons', async () => {
    const { client } = fakeClient(() => {
      throw new CloudApiError({ code: 'conflict', status: 409, message: 'Fill in [DATE NEEDED] before approving. Nothing was sent.' });
    });
    expect(await pageCall(client, 'approvalDecide', { id: 'x' })).toEqual({ ok: false, code: 'conflict', reason: 'Fill in [DATE NEEDED] before approving. Nothing was sent.' });
  });
});

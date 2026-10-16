import { expect, it, vi } from 'vitest';
import { TrackingReceipts } from './receipts';
import { mergeTrackerReceipt } from './tracker-receipts';

function fixture() {
  const data: Record<string, unknown> = {};
  const storage = { get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })), set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(data, structuredClone(next)); }) };
  return { data, storage, queue: () => new TrackingReceipts<Record<string, unknown>>('receipts', () => storage as never) };
}

it('persists before sending, survives restart, and isolates accounts', async () => {
  const f = fixture(); const queue = f.queue(); const send = vi.fn().mockRejectedValue(new Error('offline'));
  await queue.save('account-a', 'trk_a', { status: 'SENT', sent_at: 'receipt-time' });
  await queue.save('account-b', 'trk_b', { status: 'SENT' });
  expect(await queue.flush('account-a', send)).toBe(false);
  expect(send).toHaveBeenCalledExactlyOnceWith('trk_a', { status: 'SENT', sent_at: 'receipt-time' });
  const resumed = f.queue(); send.mockReset().mockResolvedValue(undefined);
  expect(await resumed.flush('account-a', send)).toBe(true);
  expect(f.data.receipts).toMatchObject([{ scope: 'account-b', key: 'trk_b' }]);
});

it('does not acknowledge a newer receipt when an older in-flight write succeeds', async () => {
  const f = fixture(); const queue = f.queue(); let acknowledge!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  await queue.save('account', 'trk', { status: 'PENDING' });
  const first = queue.flush('account', send);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  await queue.save('account', 'trk', { status: 'SENT' });
  acknowledge(); await first;
  expect(f.data.receipts).toMatchObject([{ payload: { status: 'SENT' } }]);
  await queue.flush('account', async () => {});
  expect(f.data.receipts).toEqual([]);
});

it('serializes delivery and continues past a failing receipt in bounded batches', async () => {
  const f = fixture(); const queue = f.queue();
  for (let i = 0; i < 6; i++) await queue.save('account', `trk_${i}`, { i });
  const send = vi.fn(async (key: string) => { if (key === 'trk_0') throw new Error('gone'); });
  await queue.flush('account', send);
  expect(send).toHaveBeenCalledTimes(4);
  expect(f.data.receipts).toHaveLength(3);
  expect(f.data.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'trk_0' }), expect.objectContaining({ key: 'trk_4' }), expect.objectContaining({ key: 'trk_5' })]));
});

it('does not starve later receipts behind four permanently unavailable records', async () => {
  const f = fixture(); const queue = f.queue();
  for (let i = 0; i < 5; i++) await queue.save('account', `trk_${i}`, { i });
  const send = vi.fn(async (key: string) => { if (key !== 'trk_4') throw new Error('deleted'); });
  await queue.flush('account', send); await queue.flush('account', send);
  expect(send).toHaveBeenCalledWith('trk_4', { i: 4 });
  expect((f.data.receipts as unknown[])).toHaveLength(4);
});

it('fails visibly on storage errors and retains receipts after an acknowledgement write fails', async () => {
  const f = fixture(); const queue = f.queue();
  f.storage.set.mockRejectedValueOnce(new Error('quota'));
  await expect(queue.save('account', 'trk', { status: 'SENT' })).rejects.toThrow('quota');
  await queue.save('account', 'trk', { status: 'SENT' });
  f.storage.set.mockRejectedValueOnce(new Error('quota'));
  expect(await queue.flush('account', async () => {})).toBe(false);
  expect(f.data.receipts).toHaveLength(1);
});

it('merges IDs and links without allowing a late discard to erase the Gmail send', () => {
  expect(mergeTrackerReceipt({ status: 'SENT', sent_at: 'sent', subject: 'Final', gmail_thread_id: 'abc', links: [{ click_id: 'clk_a', url: 'https://a.test' }] },
    { status: 'CANCELLED', sent_at: null, subject: 'Earlier', gmail_thread_id: null, gmail_message_id: 'def', links: [{ click_id: 'clk_b', url: 'https://b.test' }] }))
    .toMatchObject({ status: 'SENT', sent_at: 'sent', subject: 'Final', gmail_thread_id: 'abc', gmail_message_id: 'def', links: [{ click_id: 'clk_a' }, { click_id: 'clk_b' }] });
});

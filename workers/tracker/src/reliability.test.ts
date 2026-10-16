import { describe, expect, it, vi } from 'vitest';
import { consumeTrackingBatch, createMemoryState, createMemoryStore, handleTrackerRequest, processTrackingEvent, type QueuedTrackingEvent } from './index';

const UA = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Safari/537.36';
async function fixture() {
  const state = createMemoryState(); const store = createMemoryStore(state);
  const now = new Date(Date.now() - 600_000).toISOString();
  await store.insertEmail({ tracking_id: 'trk_test', status: 'SENT', subject: 'Plan', sender: 'owner@test.example', recipients: ['r@test.example'],
    created_at: now, sent_at: now, gmail_message_id: null, gmail_thread_id: null,
    open_count: 0, click_count: 0, first_opened_at: null, last_opened_at: null, first_clicked_at: null, last_clicked_at: null });
  await store.insertLink({ click_id: 'clk_test', tracking_id: 'trk_test', destination: 'https://example.com/plan' });
  return { state, store };
}
const event = (id = 'evt_test'): QueuedTrackingEvent => ({ version: 1, id, trackingId: 'trk_test', kind: 'CLICK', clickId: 'clk_test',
  observedAt: new Date().toISOString(), userAgent: UA, ipHash: null });

describe('durable tracking ingestion', () => {
  it('awaits durable acceptance before redirecting, independently of a failing event database', async () => {
    const f = await fixture(); const queued: QueuedTrackingEvent[] = []; let accept!: () => void;
    const enqueueEvent = vi.fn(async (value: QueuedTrackingEvent) => { await new Promise<void>(r => { accept = r; }); queued.push(value); });
    const failing = { ...f.store, insertEvent: vi.fn(async () => { throw new Error('database unavailable'); }) };
    let finished = false;
    const request = handleTrackerRequest(new Request('https://t.test/c/clk_test', { headers: { 'User-Agent': UA, 'CF-Connecting-IP': '203.0.113.9' } }),
      { publicStore: failing, authorize: async () => ({ store: failing }), ipSalt: 'secret', enqueueEvent }).then(r => { finished = true; return r; });
    await vi.waitFor(() => expect(enqueueEvent).toHaveBeenCalledOnce()); expect(finished).toBe(false);
    accept(); expect((await request).status).toBe(302); expect(failing.insertEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(queued)).not.toContain('203.0.113.9'); expect(queued[0]!.ipHash).toMatch(/^[a-f0-9]{64}$/);
    await processTrackingEvent(queued[0], f.store); expect((await f.store.getEmail('trk_test'))?.click_count).toBe(1);
  });
  it('repairs a failed summary write on replay without adding another event', async () => {
    const f = await fixture(); const body = event();
    const broken = { ...f.store, recomputeStats: vi.fn().mockRejectedValueOnce(new Error('write failed')).mockImplementation(f.store.recomputeStats) };
    await expect(processTrackingEvent(body, broken)).rejects.toThrow('write failed');
    expect(f.state.events).toHaveLength(1);
    await processTrackingEvent(body, broken); await processTrackingEvent(body, broken);
    expect(f.state.events).toHaveLength(1); expect((await f.store.getEmail('trk_test'))?.click_count).toBe(1);
  });
  it('acknowledges successful records only and retries faults with a bounded delay', async () => {
    const f = await fixture(); const good = { body: event(), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const bad = { body: { ...event('evt_bad'), ipHash: 'raw-address' }, attempts: 8, ack: vi.fn(), retry: vi.fn() };
    const report = vi.fn(); await consumeTrackingBatch({ messages: [good,bad] },f.store,report);
    expect(good.ack).toHaveBeenCalledOnce(); expect(bad.ack).not.toHaveBeenCalled();
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(report).toHaveBeenCalledWith('error',expect.objectContaining({ code: 'tracking_dead_letter_pending' }));
  });
  it('does not apply a later sender claim to an older queued recipient observation', async () => {
    const f=await fixture();const observed=Date.now()-60_000;const future=new Date(observed+3600_000).toISOString();
    await f.store.insertClaim({id:'clm_future',tracking_id:'trk_test',gmail_message_id:null,gmail_thread_id:null,
      first_observed_at:future,last_observed_at:future,expires_at:new Date(observed+3625_000).toISOString(),source:'MESSAGE_EXPANDED',
      consumed_by_event_id:null,created_at:future});
    await processTrackingEvent({...event(),kind:'OPEN',observedAt:new Date(observed).toISOString(),userAgent:'GoogleImageProxy'},f.store);
    expect(f.state.events[0]?.classification).toBe('PROXY_LIKELY');expect((await f.store.getEmail('trk_test'))?.open_count).toBe(1);
  });
  it('repairs an interrupted sender claim on replay without extending its time window or changing its fingerprint', async () => {
    const f=await fixture();const headers={'User-Agent':UA,'CF-Connecting-IP':'203.0.113.9'};
    const deps={publicStore:f.store,authorize:async()=>({store:f.store}),ipSalt:'salt'};
    await handleTrackerRequest(new Request('https://t.test/open/trk_test',{headers}),deps);
    expect((await f.store.getEmail('trk_test'))?.open_count).toBe(1);
    let fail=true;
    const interrupted={...f.store,listEvents:async(id:string)=>{if(fail&&f.state.events.some(event=>event.type==='SELF_VIEW')){fail=false;throw new Error('interrupted');}return f.store.listEvents(id);}};
    const request=(different=false)=>new Request('https://t.test/api/emails/trk_test/self-view',{method:'POST',headers:{...headers,...(different?{'CF-Connecting-IP':'203.0.113.99','User-Agent':'Changed browser'}:{}),'Content-Type':'application/json'},body:JSON.stringify({selfViewEventId:'sv_retry'})});
    const d={...deps,authorize:async()=>({store:interrupted})};
    expect((await handleTrackerRequest(request(),d)).status).toBe(500);
    const original=(await f.store.listClaims('trk_test'))[0]!;
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+3600_000);
    try {
      const response=await handleTrackerRequest(request(true),d);expect(response.status).toBe(200);
      const data=await response.json() as {open_count:number;reclassifiedEventIds:string[]};
      expect(data.open_count).toBe(0);expect(data.reclassifiedEventIds).toEqual([f.state.events[0]!.id]);
      expect((await f.store.listClaims('trk_test'))[0]).toMatchObject({expires_at:original.expires_at,sender_ip_hash:original.sender_ip_hash,sender_ua_family:original.sender_ua_family});
      expect(f.state.events.filter(event=>event.type==='SELF_VIEW')).toHaveLength(1);
    } finally {clock.mockRestore();}
  });
  it('keeps complete lifetime totals above 5000 events', async () => {
    const f = await fixture();
    const template = { id: '', tracking_id: 'trk_test', type: 'CLICK' as const, timestamp: new Date().toISOString(), user_agent: UA, ip_hash: null, suspected_self_open: false, confidence: 0, classification: 'RECIPIENT_LIKELY' as const };
    for (let i=0;i<5002;i++) f.state.events.push({ ...template,id:`evt_${i}` });
    expect((await f.store.recomputeStats('trk_test')).clickCount).toBe(5002);
    expect((await f.store.getEmail('trk_test'))?.click_count).toBe(5002);
  });
});

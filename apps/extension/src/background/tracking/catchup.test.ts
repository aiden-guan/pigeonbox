import { describe, expect, it, vi } from 'vitest';
import { TrackingCatchup } from './catchup';
import { TrackingHttpError, type TrackingEvent } from '@pigeonbox/tracking';

function fixture() {
  let data: Record<string, unknown> = {};
  const storage = { get: vi.fn(async () => ({ ...data })), set: vi.fn(async (next: Record<string, unknown>) => { data={ ...data,...next }; }) };
  return { storage, reader: new TrackingCatchup(storage) };
}
describe('tracking catch-up', () => {
  it('baselines a fresh installation, catches a burst over 50 events, and survives restart before acknowledgement', async () => {
    const f=fixture(); const events: TrackingEvent[] = Array.from({length:650},(_,i)=>({ id:`event-${i+1}`,tracking_id:'trk_test',type:'CLICK',timestamp:new Date().toISOString() }));
    const client={ getRecentEvents:vi.fn(async()=>[]), getEventPage:vi.fn(async(after:string|null)=> {
      if(after===null) return { events:[],cursor:'0',hasMore:false };
      const start=Number(after);const page=events.slice(start,start+100);
      return {events:page,cursor:String(start+page.length),hasMore:start+page.length<events.length};
    }) };
    const baseline=await f.reader.read('account',client);expect(baseline.events).toEqual([]);await baseline.acknowledge();
    const first=await f.reader.read('account',client);expect(first.events).toHaveLength(400);
    const restarted=await new TrackingCatchup(f.storage).read('account',client);expect(restarted.events).toEqual(first.events);
    await restarted.acknowledge();const rest=await f.reader.read('account',client);expect(rest.events).toHaveLength(250);await rest.acknowledge();
    expect((await f.reader.read('account',client)).events).toEqual([]);
    expect(new Set([...first.events,...rest.events].map(e=>e.id)).size).toBe(650);
  });
  it('does not commit a partial page traversal and keeps accounts separate', async () => {
    const f=fixture();const client={getRecentEvents:vi.fn(async()=>[]),getEventPage:vi.fn(async()=>({events:[],cursor:'10',hasMore:false}))};
    await (await f.reader.read('one',client)).acknowledge();
    client.getEventPage.mockRejectedValueOnce(new Error('offline'));
    await expect(f.reader.read('one',client)).rejects.toThrow('offline');
    await f.reader.read('two',client);expect(client.getEventPage).toHaveBeenLastCalledWith(null);
  });
  it('uses bounded snapshots only for older trackers without the catch-up endpoint', async () => {
    const f=fixture();const client={getRecentEvents:vi.fn(async()=>[]),getEventPage:vi.fn(async()=>{throw new TrackingHttpError(404,'catchup');})};
    expect((await f.reader.read('old',client)).cursorBacked).toBe(false);expect(client.getRecentEvents).toHaveBeenCalledOnce();
  });
});

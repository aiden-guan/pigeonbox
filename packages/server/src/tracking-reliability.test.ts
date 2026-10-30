import { afterEach, describe, expect, it } from 'vitest';
import { deriveTrackingStats, type EventRow } from '@pigeonbox/tracker';
import { SupabaseCloudStore } from './store/supabase.js';
import { postgrestFetch } from './testing/postgrest.js';
import { connectedUser, createIntelHarness, type IntelHarness } from './testing/intel-harness.js';

const harnesses: IntelHarness[]=[];
afterEach(async()=>{ await Promise.all(harnesses.splice(0).map(h=>h.pg.close())); });
const UA='Mozilla/5.0 AppleWebKit/537.36 Chrome/130 Safari/537.36';
async function setup() {
  const h=await createIntelHarness();harnesses.push(h);
  const user=await connectedUser(h,'owner@work.test');
  const cloud=new SupabaseCloudStore('https://db.test','test-service-role',postgrestFetch(h.pg));
  const store=cloud.trackerStoreFor(user.userId);
  const now=new Date(Date.now()-600_000).toISOString();
  await store.insertEmail({ tracking_id:'trk_reliable',status:'SENT',subject:'Plan',sender:'owner@work.test',recipients:['r@work.test'],
    created_at:now,sent_at:now,gmail_message_id:null,gmail_thread_id:null,
    open_count:0,click_count:0,first_opened_at:null,last_opened_at:null,first_clicked_at:null,last_clicked_at:null });
  return {h,user,cloud,store};
}
describe('production tracking SQL',()=>{
  it('aggregates all 6002 events without a PostgREST row cap and repairs old summaries',async()=>{
    const f=await setup();
    await f.h.sql(`insert into public.tracking_events(id,tracking_id,type,timestamp,user_agent,classification)
      select 'event-'||n,'trk_reliable','CLICK',now()+n*interval '1 second',$1,'RECIPIENT_LIKELY' from generate_series(1,6002) n`,[UA]);
    expect((await f.store.recomputeStats('trk_reliable')).clickCount).toBe(6002);
    expect((await f.store.getEmail('trk_reliable'))?.click_count).toBe(6002);
    await f.h.sql(`update public.tracking_events set suspected_self_open=true where id='event-6002'`);
    expect((await f.store.recomputeStats('trk_reliable')).clickCount).toBe(6001);
    const other=crypto.randomUUID();await expect(f.cloud.trackerStoreFor(other).recomputeStats('trk_reliable')).rejects.toThrow();
  });
  it('matches shared classification and 800ms open deduplication across the complete history',async()=>{
    const f=await setup(); const base=Date.now()-100_000;
    const inputs:Array<Partial<EventRow>>=[
      {type:'OPEN',classification:'RECIPIENT_LIKELY'}, {type:'OPEN',classification:'RECIPIENT_LIKELY'},
      {type:'OPEN',classification:'PROXY_LIKELY',user_agent:'GoogleImageProxy'},
      {type:'OPEN',classification:'RECIPIENT_LIKELY',user_agent:'Barracuda scanner'},
      {type:'OPEN',classification:'SELF_LIKELY'}, {type:'OPEN',classification:null},
      {type:'CLICK',classification:'RECIPIENT_LIKELY',suspected_self_open:true},
      {type:'CLICK',classification:'RECIPIENT_LIKELY',user_agent:'HeadlessChrome'},
      {type:'CLICK',classification:'RECIPIENT_LIKELY'}, {type:'SELF_VIEW',classification:'SELF_LIKELY'},
      {type:'OPEN',classification:'UNKNOWN',user_agent:null}, {type:'CLICK',classification:null},
    ];
    const events=inputs.map((input,i):EventRow=>({id:`event-${i}`,tracking_id:'trk_reliable',type:'OPEN',timestamp:new Date(base+i*400).toISOString(),user_agent:UA,ip_hash:null,suspected_self_open:false,confidence:0,...input}));
    for(const event of events) await f.store.insertEvent(event);
    const actual=await f.store.recomputeStats('trk_reliable');const expected=deriveTrackingStats(events);
    for(const key of ['openCount','clickCount','possibleOpenCount','pixelLoadCount'] as const) expect(actual[key]).toBe(expected[key]);
    expect(Date.parse(actual.firstOpenedAt!)).toBe(Date.parse(expected.firstOpenedAt!));
    expect(Date.parse(actual.lastOpenedAt!)).toBe(Date.parse(expected.lastOpenedAt!));
  });
  it('pages a burst and later-ingested old observations without crossing owners',async()=>{
    const f=await setup(); const baseline=await f.store.eventPage(null,100);
    expect(baseline).toEqual({events:[],cursor:'0',hasMore:false});
    await f.h.sql(`insert into public.tracking_events(id,tracking_id,type,user_agent,classification)
      select 'event-'||n,'trk_reliable','CLICK',$1,'RECIPIENT_LIKELY' from generate_series(1,255) n`,[UA]);
    const first=await f.store.eventPage(baseline.cursor,100);expect(first.events).toHaveLength(100);expect(first.hasMore).toBe(true);
    const second=await f.store.eventPage(first.cursor,100);const third=await f.store.eventPage(second.cursor,100);
    expect(second.events).toHaveLength(100);expect(third.events).toHaveLength(55);expect(third.hasMore).toBe(false);
    const late:EventRow={id:'event-late',tracking_id:'trk_reliable',type:'CLICK',timestamp:'2020-01-01T00:00:00.000Z',user_agent:UA,ip_hash:null,suspected_self_open:false,confidence:0,classification:'RECIPIENT_LIKELY'};
    await f.store.insertEvent(late);await f.store.insertEvent(late);
    expect((await f.store.eventPage(third.cursor,100)).events.map(e=>e.id)).toEqual(['event-late']);
    const other=crypto.randomUUID();expect((await f.cloud.trackerStoreFor(other).eventPage('0',100)).events).toEqual([]);
    const privileges=await f.h.sql<{allowed:boolean}>(`select has_function_privilege('authenticated','public.tracking_event_page(text,integer,uuid)','execute') as allowed`);
    expect(privileges[0]?.allowed).toBe(false);
  });
});

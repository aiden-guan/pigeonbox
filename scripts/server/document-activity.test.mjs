import { describe, expect, it, vi } from 'vitest';
import { DocumentActivity, DocumentActivityJournal } from '../../apps/web/public/viewer/activity.js';

function fixture(send = vi.fn(async () => {})) {
  let time = 0; let focused = true;
  const reporter = new DocumentActivity({ session: { sessionId: 'session', sessionToken: 'token' }, send, attentive: () => focused, now: () => time });
  return { reporter, send, advance: ms => { time += ms; }, focus: value => { focused = value; } };
}
describe('Document activity delivery and timing', () => {
  it('retains unacknowledged observations across a closed offline tab and replays their original session and IDs', async () => {
    const values = new Map();
    const storage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) };
    const session = { sessionId: 'saved-session', sessionToken: 'a'.repeat(32), expiresAt: new Date(Date.now()+3600_000).toISOString(), preview: false };
    const journal = new DocumentActivityJournal({ storage, scope: '/d/opaque-link' });
    const offline = vi.fn(async () => { throw new Error('offline'); });
    const first = new DocumentActivity({ session, journal, send: offline, attentive: () => true, now: () => 0 });
    first.page(1); await first.inFlight;
    const original = structuredClone(first.queue); expect(original).toHaveLength(2);
    expect(journal.latest().session).toEqual(session);
    const send = vi.fn(async () => {});
    const reopened = new DocumentActivity({ session: journal.latest().session, journal, send, attentive: () => true, now: () => 0 });
    await reopened.flush(); expect(send.mock.calls[0][0]).toEqual({ sessionId: session.sessionId,sessionToken:session.sessionToken,events:original });
    expect(journal.latest().queue).toEqual([]); reopened.page(1); await reopened.flush(); expect(send).toHaveBeenCalledOnce();
    reopened.stop(); expect(journal.latest()).toBeNull();
  });
  it('isolates share links and removes expired journals without replaying expired credentials', async () => {
    const values = new Map();const storage = { get length() { return values.size; },key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key) };
    let time=Date.now();const first=new DocumentActivityJournal({storage,scope:'first',wallNow:()=>time});
    const session={sessionId:'old',sessionToken:'a'.repeat(32),expiresAt:new Date(time+1000).toISOString(),preview:true};
    first.write(session,{queue:[],seen:[],started:false});
    expect(new DocumentActivityJournal({storage,scope:'second',wallNow:()=>time}).latest()).toBeNull();
    time+=1001;expect(first.latest()).toBeNull();expect(values.size).toBe(0);
  });
  it('acknowledges only the replayed IDs when another tab has appended a newer observation', async () => {
    const values=new Map();const storage={get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
    const journal=new DocumentActivityJournal({storage,scope:'same-link'});
    const session={sessionId:'session',sessionToken:'a'.repeat(32),expiresAt:new Date(Date.now()+3600_000).toISOString(),preview:false};
    const first={id:'first',kind:'view_start'};const newer={id:'newer',kind:'page_view',page:1};
    journal.write(session,{queue:[first],seen:[],started:true});
    let release;const replay=new DocumentActivity({session,journal,send:()=>new Promise(resolve=>{release=resolve;}),attentive:()=>false,now:()=>0});
    const pending=replay.flush();journal.write(session,{queue:[first,newer],seen:[1],started:true});
    release();await pending;expect(journal.latest().queue).toEqual([newer]);expect(journal.latest().seen).toEqual([1]);
  });
  it('keeps tracking in memory when local persistence is unavailable and reports that limitation', async () => {
    const onFailure=vi.fn();const journal={read:()=>null,write:()=>{throw new Error('storage denied');}};
    const send=vi.fn(async()=>{});const reporter=new DocumentActivity({session:{sessionId:'x',sessionToken:'t'},journal,send,attentive:()=>true,onFailure,now:()=>0});
    reporter.page(1);await reporter.inFlight;expect(onFailure).toHaveBeenCalled();expect(send).toHaveBeenCalledOnce();expect(reporter.queue).toEqual([]);
  });
  it('only starts on a rendered page while attentive; assigns intervals to the page actually shown', async () => {
    const f = fixture();
    f.focus(false); f.reporter.page(1); expect(f.send).not.toHaveBeenCalled();
    f.focus(true); f.reporter.page(1); await f.reporter.inFlight;
    for (let i = 0; i < 5; i++) { f.advance(1000); f.reporter.tick(); }
    f.reporter.page(2); await f.reporter.inFlight;
    f.advance(1000); f.reporter.tick(); f.reporter.pause(); await f.reporter.flush();
    const events = f.send.mock.calls.flatMap(([p]) => p.events);
    expect(events.filter(e => e.kind === 'view_start')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'heartbeat')).toMatchObject([{ page: 1, visibleMs: 5000 }, { page: 2, visibleMs: 1000 }]);
  });
  it('discards sleep and background gaps, and resumes the same page without double counting', async () => {
    const f = fixture(); f.reporter.page(1); await f.reporter.inFlight;
    f.advance(60_000); f.reporter.tick(); f.reporter.settle();
    f.focus(false); f.reporter.pause(); f.advance(30_000); f.reporter.tick();
    f.focus(true); f.reporter.page(1); f.advance(1000); f.reporter.settle(); await f.reporter.flush();
    const events = f.send.mock.calls.flatMap(([p]) => p.events);
    expect(events.filter(e => e.kind === 'page_view')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'heartbeat')).toMatchObject([{ visibleMs: 1000 }]);
  });
  it('keeps IDs and payloads after delivery failure so acknowledgement loss is retry safe', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const f = fixture(send); f.reporter.page(1); await f.reporter.inFlight;
    const first = send.mock.calls[0][0]; expect(f.reporter.queue).toHaveLength(2);
    await f.reporter.flush(); expect(send.mock.calls[1][0]).toEqual(first); expect(f.reporter.queue).toEqual([]);
  });
  it('drains more than one batch after reconnecting instead of stranding queued observations', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const f = fixture(send); f.reporter.page(1); await f.reporter.inFlight;
    for (let index = 0; index < 123; index++) f.reporter.record('heartbeat', { page: 1, visibleMs: 0 });
    expect(f.reporter.queue).toHaveLength(125);
    await f.reporter.flush();
    expect(send.mock.calls.slice(1).map(([payload]) => payload.events.length)).toEqual([50, 50, 25]);
    expect(f.reporter.queue).toEqual([]);
  });
  it('recovers from a full offline queue without claiming an undelivered page was observed', async () => {
    const send=vi.fn(async()=>{throw new Error('offline');});const f=fixture(send);
    f.reporter.page(1);await f.reporter.inFlight;
    for(let i=0;i<498;i++) f.reporter.record('heartbeat',{page:1,visibleMs:0});
    f.reporter.page(2);await f.reporter.inFlight;expect(f.reporter.seen.has(2)).toBe(false);
    send.mockResolvedValue(undefined);await f.reporter.flush();f.reporter.page(2);await f.reporter.inFlight;
    expect(send.mock.calls.flatMap(([payload])=>payload.events).filter(event=>event.kind==='page_view'&&event.page===2)).toHaveLength(1);
    expect(f.reporter.queue).toEqual([]);
  });
  it('uses different event IDs after a reload resumes the same server session', async () => {
    const first = fixture(); const refreshed = fixture();
    first.reporter.page(1); refreshed.reporter.page(2);
    await Promise.all([first.reporter.inFlight, refreshed.reporter.inFlight]);
    const ids = [...first.send.mock.calls[0][0].events, ...refreshed.send.mock.calls[0][0].events].map(event => event.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('sends an idempotent keepalive copy during unload without removing unacknowledged events', async () => {
    let ack; const send = vi.fn(() => new Promise(resolve => { ack = resolve; }));
    const f = fixture(send); f.reporter.page(1);
    const first = send.mock.calls[0][0];
    const final = f.reporter.flush(true);
    expect(send.mock.calls[1][0]).toEqual(first); expect(f.reporter.queue).toHaveLength(2);
    ack(); await final; expect(f.reporter.queue).toEqual([]);
  });
});

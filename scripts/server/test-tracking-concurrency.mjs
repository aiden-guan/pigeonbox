/** Run only against a disposable local Postgres, never a hosted project. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

const target = new URL(process.env.PIGEONBOX_TRACKING_TEST_DATABASE_URL ?? '');
assert.ok(['127.0.0.1','localhost'].includes(target.hostname));
assert.equal(target.pathname, '/pigeonbox_tracking_test');
const a=postgres(target.href,{max:1,prepare:false});
const b=postgres(target.href,{max:1,prepare:false});
const c=postgres(target.href,{max:1,prepare:false});
const owner='11111111-1111-4111-8111-111111111111';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let release;const promise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Concurrency test gate timed out')),10000);timer.unref();release=()=>{clearTimeout(timer);resolve();};});return {promise,release};};
try {
  await a.unsafe(`create role anon; create role authenticated; create role service_role;
    create schema auth; create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.profiles(id uuid primary key); insert into public.profiles values ('${owner}');`);
  await a.unsafe(readFileSync(new URL('../../supabase/migrations/20260926000100_hosted_tracking.sql',import.meta.url),'utf8'));
  const migration=readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(n=>n.endsWith('_tracking_reliable_stats_and_cursor.sql'));
  await a.unsafe(readFileSync(new URL(`../../supabase/migrations/${migration}`,import.meta.url),'utf8'));
  await a.unsafe(`insert into public.tracked_emails(tracking_id,user_id,subject,sender) values ('trk_test',$1,'Test','owner@test.example')`,[owner]);
  const insert=(db,id)=>db.unsafe(`insert into public.tracking_events(id,tracking_id,type,classification,user_agent) values ($1,'trk_test','CLICK','RECIPIENT_LIKELY','Mozilla/5.0 Chrome/130 Safari/537.36')`,[id]);
  const recompute=db=>db.unsafe(`select public.recompute_tracking_stats('trk_test') as stats`);
  await insert(a,'event-1');
  const locked=gate(); const release=gate();
  const first=a.begin(async tx=>{assert.equal((await recompute(tx))[0].stats.clickCount,1);locked.release();await release.promise;});
  await locked.promise;
  let secondFinished=false;
  const second=(async()=>{await insert(b,'event-2');await recompute(b);secondFinished=true;})();
  const competing=recompute(c);
  await wait(100);assert.equal(secondFinished,false,'concurrent insert must not overtake the held parent transaction');
  release.release();await Promise.all([first,second,competing]);
  assert.equal((await a.unsafe(`select click_count from public.tracked_emails where tracking_id='trk_test'`))[0].click_count,2);
  console.log('PASS competing event inserts and recomputations retain both clicks');

  const correction=a.begin(async tx=>{await tx.unsafe(`update public.tracking_events set suspected_self_open=true where id='event-1'`);await recompute(tx);});
  const arriving=(async()=>{await insert(b,'event-3');await recompute(b);})();
  await Promise.all([correction,arriving]);
  assert.equal((await a.unsafe(`select click_count from public.tracked_emails where tracking_id='trk_test'`))[0].click_count,2);
  console.log('PASS self-view correction racing with a new click retains the correct total');

  const baseline=(await a.unsafe(`select public.tracking_event_page(null,100,$1) as page`,[owner]))[0].page.cursor;
  const inserted=gate();const commit=gate();
  const pending=a.begin(async tx=>{await insert(tx,'event-pending');inserted.release();await commit.promise;});
  await inserted.promise;let laterFinished=false;
  const later=(async()=>{await insert(b,'event-later');laterFinished=true;})();
  await wait(100);assert.equal(laterFinished,false,'cursor allocation is serialized until earlier account inserts commit');
  const invisible=(await c.unsafe(`select public.tracking_event_page($1,100,$2) as page`,[baseline,owner]))[0].page;
  assert.equal(invisible.events.length,0);
  commit.release();await Promise.all([pending,later]);
  const caught=(await c.unsafe(`select public.tracking_event_page($1,100,$2) as page`,[baseline,owner]))[0].page;
  assert.deepEqual(caught.events.map(e=>e.id),['event-pending','event-later']);
  console.log('PASS catch-up cursors cannot skip an uncommitted earlier event');
} finally { await Promise.all([a.end({timeout:1}),b.end({timeout:1}),c.end({timeout:1})]); }

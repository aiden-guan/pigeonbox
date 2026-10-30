import { afterEach, describe, expect, it } from 'vitest';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '@pigeonbox/shared';
import { connectedUser, createIntelHarness, type IntelHarness } from '../testing/intel-harness.js';
import { createIntelDeps, type IntelDeps } from './context.js';
import { runSequenceSend, scheduleApprovedBatch } from './sequences.js';
import type { SqlDatabase, SqlExecutor } from '../db/sql.js';
import type { JobRecord } from '../jobs/queue.js';
import { parseRawMessage } from '../google/mime.js';
import { sha256Hex } from '../platform/crypto.js';

const opened: IntelHarness[]=[];
afterEach(async()=>{await Promise.all(opened.splice(0).map(h=>h.pg.close()));});
async function setup() {
  const h=await createIntelHarness({env:{TRACKER_BASE_URL:'https://t.test'}});opened.push(h);
  const user=await connectedUser(h,'owner@work.test',['mail_read','send']);
  const {id}=await h.route<{id:string}>('controlSequenceSave',user.token,{name:'Retry',accountId:user.accountId,trackOpens:true,window:{start:'09:00',end:'17:00'},
    steps:[{delayBusinessDays:0,subject:'Plan',body:'Please see the plan.'},{delayBusinessDays:2,subject:'Plan',body:'Following up.'}]});
  await h.route('controlSequenceEnroll',user.token,{sequenceId:id,recipients:[{email:'recipient@work.test',fields:{}}]});
  const {approvalId}=await h.route<{approvalId:string}>('controlSequenceStatus',user.token,{sequenceId:id,status:'active'});
  await h.route('approvalDecide',user.token,{id:approvalId,decision:'approve',idempotencyKey:'approve-recovery-001'});
  const deps=createIntelDeps({config:h.config,db:h.db,box:h.box,google:h.deps.intel!.google,inference:h.deps.inference,store:h.store,log:h.deps.log,now:h.now,fetch:h.deps.intel!.fetch,storage:h.storage});
  await scheduleApprovedBatch(deps,user.userId,approvalId,id);
  const p=zonedParts(h.now(),'America/New_York');let day={year:p.year,month:p.month,day:p.day};
  for(let n=0;n<8;n++){day=addCalendarDays(day,1);const at=zonedTimeToUtc({...day,hour:10,minute:0},'America/New_York');if(zonedParts(at,'America/New_York').weekday<6&&zonedParts(at,'America/New_York').weekday>0){await h.advance(at.getTime()-h.now().getTime());break;}}
  const row=(await h.sql<{id:string}>(`select id from public.sequence_sends where approval_id=$1`,[approvalId]))[0]!;
  const job={id:crypto.randomUUID(),kind:'sequence.step',userId:user.userId,accountId:user.accountId,idempotencyKey:`sequence-send:${row.id}`,payload:{sendId:row.id},status:'running',attempts:1,maxAttempts:4,runAt:h.now().toISOString(),createdAt:h.now().toISOString(),startedAt:null,completedAt:null,lastErrorCode:null} satisfies JobRecord;
  return {h,user,deps,job,sequenceId:id,sendId:row.id};
}

describe('sequence accepted-send recovery',()=>{
  it.each(['tracker_before','tracker_after','sequence_transaction'] as const)('repairs %s without changing MIME, unsubscribe identity or sending twice',async phase=>{
    const f=await setup();let armed=true;
    const original=f.h.store.trackerStoreFor.bind(f.h.store);
    const store=Object.assign(Object.create(f.h.store) as typeof f.h.store,{trackerStoreFor:(userId:string)=>{const inner=original(userId);return {...inner,updateEmail:async(id:string,patch:Parameters<typeof inner.updateEmail>[1])=>{
      if(armed&&patch.status==='SENT'&&phase!=='sequence_transaction') {armed=false;if(phase==='tracker_after')await inner.updateEmail(id,patch);throw new Error('injected tracker failure');}
      return inner.updateEmail(id,patch);
    }};}});
    const db:SqlDatabase={kind:f.h.db.kind,close:()=>f.h.db.close(),system:fn=>f.h.db.system(fn),asUser:<T>(userId:string,fn:(tx:SqlExecutor)=>Promise<T>)=>f.h.db.asUser(userId,tx=>fn({query:async<T>(sql:string,params?:readonly unknown[])=>{
      const rows=await tx.query<T>(sql,params);
      if(armed&&phase==='sequence_transaction'&&sql.includes("update public.sequence_sends set status = 'sent'")){armed=false;throw new Error('injected transaction failure');}
      return rows;
    }}))};
    const deps={...f.deps,store,db} as IntelDeps;
    await expect(runSequenceSend(deps,f.job)).rejects.toThrow('injected');
    expect(f.h.google.account('owner@work.test').sent).toHaveLength(1);
    const first=(await f.h.sql<{tracking_id:string;unsubscribe_token_hash:string;status:string}>(`select tracking_id,unsubscribe_token_hash,status from public.sequence_sends where id=$1`,[f.sendId]))[0]!;
    expect(first.status).toBe('approved');expect(first.tracking_id).toBe(`trk_${f.sendId.replace(/-/g,'')}`);
    const sent=parseRawMessage(f.h.google.account('owner@work.test').sent[0]!);
    const unsubscribe=sent.headers['list-unsubscribe']!.slice(1,-1);expect(first.unsubscribe_token_hash).toBe(await sha256Hex(new URL(unsubscribe).pathname.split('/').pop()!));
    // Recovery of accepted mail still runs after the user pauses the sequence.
    await f.h.sql(`update public.sequences set status='paused' where id=$1`,[f.sequenceId]);
    await runSequenceSend(deps,f.job);
    const after=(await f.h.sql<{tracking_id:string;unsubscribe_token_hash:string;status:string;gmail_message_id:string;gmail_thread_id:string}>(`select tracking_id,unsubscribe_token_hash,status,gmail_message_id,gmail_thread_id from public.sequence_sends where id=$1`,[f.sendId]))[0]!;
    expect(after).toMatchObject({tracking_id:first.tracking_id,unsubscribe_token_hash:first.unsubscribe_token_hash,status:'sent'});
    expect(after.gmail_message_id).toBeTruthy();expect(after.gmail_thread_id).toBeTruthy();
    expect(await original(f.user.userId).getEmail(first.tracking_id)).toMatchObject({status:'SENT',gmail_message_id:after.gmail_message_id,gmail_thread_id:after.gmail_thread_id});
    expect(f.h.google.account('owner@work.test').sent).toHaveLength(1);
    expect((await f.h.sql<{current_step:number}>(`select current_step from public.sequence_enrollments where sequence_id=$1`,[f.sequenceId]))[0]!.current_step).toBe(1);
  });
});

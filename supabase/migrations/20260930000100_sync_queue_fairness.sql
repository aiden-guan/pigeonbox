-- Reserve one slot per claimed batch for Gmail ingestion, so a large analysis
-- backlog cannot postpone history sync or recovery continuations indefinitely.
-- The remaining slots stay FIFO. Use the installed pgmq conditional read API;
-- pgmq still owns locking, read counters and visibility-timeout semantics.
create function app.label_sync_queue_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update pgmq.q_pigeonbox_jobs set message = message || '{"mail_sync":true}'::jsonb
  where msg_id = new.queue_msg_id;
  return new;
end;
$$;
revoke all on function app.label_sync_queue_message() from public, anon, authenticated;
create trigger label_sync_queue_message after update of queue_msg_id on public.jobs
for each row when (new.queue_msg_id is not null and old.queue_msg_id is distinct from new.queue_msg_id
  and new.kind in ('gmail.sync','gmail.recover','gmail.watch'))
execute function app.label_sync_queue_message();

update pgmq.q_pigeonbox_jobs q set message = q.message || '{"mail_sync":true}'::jsonb
from public.jobs j where j.queue_msg_id = q.msg_id
and j.kind in ('gmail.sync','gmail.recover','gmail.watch');

create or replace function app.claim_jobs(p_limit integer, p_lease_seconds integer) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
declare r record; v_job public.jobs;
begin
  if p_limit < 1 then return; end if;
  for r in
    with priority as materialized (
      select * from pgmq.read('pigeonbox_jobs', p_lease_seconds, 1, '{"mail_sync":true}'::jsonb)
    ), remainder as materialized (
      select * from pgmq.read('pigeonbox_jobs', p_lease_seconds,
        greatest(0, p_limit - (select count(*)::integer from priority)))
    ) select * from priority union all select * from remainder
  loop
    v_job := null;
    update public.jobs j set status = 'running', attempts = j.attempts + 1,
      started_at = coalesce(j.started_at, now()),
      locked_until = now() + make_interval(secs => p_lease_seconds),
      queue_msg_id = r.msg_id, updated_at = now()
    where j.id = (r.message ->> 'job_id')::uuid and j.status in ('queued','running','retrying')
    returning j.* into v_job;
    if v_job.id is null then
      perform pgmq.delete('pigeonbox_jobs', r.msg_id); continue;
    end if;
    if v_job.attempts > v_job.max_attempts then
      update public.jobs set status = 'dead', last_error_code = coalesce(last_error_code,'lease_expired'),
        last_error_at = now(), completed_at = now(), updated_at = now() where id = v_job.id;
      perform pgmq.archive('pigeonbox_jobs', r.msg_id); continue;
    end if;
    return next v_job;
  end loop;
end;
$$;

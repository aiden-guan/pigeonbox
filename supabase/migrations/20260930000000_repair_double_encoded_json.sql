-- postgres.js previously serialized the already-encoded JSON from toSqlParam
-- again. Restore only valid object/array containers; leave actual scalar JSON
-- and malformed values unchanged. No role, RLS, credential or mail-body changes.
create function pg_temp.restore_container(value jsonb) returns jsonb
language plpgsql as $$
declare decoded jsonb;
begin
  if jsonb_typeof(value) <> 'string' then return value; end if;
  begin decoded := (value #>> '{}')::jsonb;
  exception when invalid_text_representation then return value;
  end;
  if jsonb_typeof(decoded) in ('object', 'array') then return decoded; end if;
  return value;
end;
$$;

-- Remember skipped analysis jobs before changing their representation.
create temporary table repaired_analysis_jobs on commit drop as
select id from public.jobs
where kind = 'thread.analyze' and status = 'succeeded'
  and jsonb_typeof(payload) = 'string'
  and jsonb_typeof(pg_temp.restore_container(payload)) = 'object';

do $$
declare item record;
begin
  for item in select * from (values
    ('approvals','action'), ('approvals','preview_meta'), ('approvals','sources'),
    ('audit_events','undo'), ('automation_rules','actions'), ('automation_rules','conditions'),
    ('automation_rules','trigger_params'), ('automation_runs','outcomes'),
    ('automation_templates','definition'), ('idempotency_keys','result'), ('jobs','payload'),
    ('rule_versions','actions'), ('rule_versions','filter'), ('shadow_decisions','actions'),
    ('smart_views','actions'), ('smart_views','filter'), ('thread_states','meeting_request'),
    ('threads','participants'), ('tracked_emails','recipients'), ('user_preferences','settings')
  ) as columns(table_name, column_name) loop
    execute format('update public.%I set %I = pg_temp.restore_container(%I) where jsonb_typeof(%I) = ''string'' and %I is distinct from pg_temp.restore_container(%I)',
      item.table_name, item.column_name, item.column_name, item.column_name, item.column_name, item.column_name);
  end loop;
end;
$$;

-- Replay only analysis falsely marked successful by the missing_ids guard.
-- Queue payload construction is server-side SQL, so it is already structured.
do $$
declare job record;
begin
  for job in select j.* from public.jobs j join repaired_analysis_jobs r on r.id = j.id loop
    perform app.enqueue_job('thread.analyze', job.user_id, job.mail_account_id,
      'repair-json:' || job.id::text, job.payload, now(), job.max_attempts);
  end loop;
end;
$$;

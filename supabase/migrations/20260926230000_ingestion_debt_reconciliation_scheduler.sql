-- TodayAction reliability closure R02 / issue #156.
-- Add a worker-authenticated target list and an hourly bounded reconciliation pass.
-- This migration does not rewrite ingestion history and grants no new mailbox permission.

create or replace function public.pjsdas_claim_ingestion_reconciliation_users(worker_token text)
returns table(user_id uuid)
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  if worker_token is null or not exists(
    select 1
    from vault.decrypted_secrets
    where name='pjsdas_gmail_automation_worker_token'
      and decrypted_secret=worker_token
  ) then
    raise exception 'Invalid PJSDAS automation worker token.' using errcode='42501';
  end if;

  return query
  select w.user_id
  from public.pjsdas_workspaces w
  order by w.updated_at asc, w.user_id asc;
end
$$;

revoke all on function public.pjsdas_claim_ingestion_reconciliation_users(text)
  from public, authenticated;
grant execute on function public.pjsdas_claim_ingestion_reconciliation_users(text)
  to anon;

do $migration$
declare
  job_count integer;
  existing cron.job%rowtype;
  command_text text;
  reconciliation_job_id bigint;
begin
  command_text := $cron$
  select net.http_post(
    url := rtrim(
      (select decrypted_secret
       from vault.decrypted_secrets
       where name='pjsdas_automation_backend_origin'),
      '/'
    ) || '/api/automation-ingestion-reconciliation',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name='pjsdas_gmail_automation_worker_token'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) as request_id
  where exists(select 1 from public.pjsdas_workspaces);
  $cron$;

  select count(*) into job_count
  from cron.job
  where jobname='todayaction-ingestion-debt-reconciliation-hourly';

  if job_count > 1 then
    raise exception 'Duplicate TodayAction ingestion debt reconciliation jobs exist.';
  elsif job_count = 0 then
    reconciliation_job_id := cron.schedule(
      'todayaction-ingestion-debt-reconciliation-hourly',
      '42 * * * *',
      command_text
    );
  else
    select * into strict existing
    from cron.job
    where jobname='todayaction-ingestion-debt-reconciliation-hourly';
    perform cron.alter_job(
      existing.jobid,
      schedule := '42 * * * *',
      command := command_text
    );
    reconciliation_job_id := existing.jobid;
  end if;
  -- Provision only. Production activation and private workspace writes require
  -- a separate explicit owner authorization, including on migration replay.
  perform cron.alter_job(reconciliation_job_id, active := false);
end
$migration$;

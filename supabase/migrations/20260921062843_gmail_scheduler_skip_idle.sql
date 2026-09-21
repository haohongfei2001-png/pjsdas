-- UU06: skip backend wakeups when no Gmail binding is eligible.
-- Change only the existing Gmail job command; keep its ID, schedule, active state,
-- database/user, endpoint, Vault identity, body and timeout. Discovery is untouched.
-- No opt-in, consent expansion, controls activation or live SLO claim.
do $migration$
declare
  gmail_job cron.job%rowtype;
begin
  select * into strict gmail_job
  from cron.job
  where jobname = 'pjsdas-gmail-automation-hourly'
  for update;

  if gmail_job.schedule is distinct from '5 * * * *' then
    raise exception 'Unexpected Gmail scheduler cadence; refusing to overwrite it.';
  end if;

  perform cron.alter_job(gmail_job.jobid, command := $cron$
  select net.http_post(
    url := rtrim(
      (select decrypted_secret
       from vault.decrypted_secrets
       where name = 'pjsdas_automation_backend_origin'),
      '/'
    ) || '/api/automation-gmail',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'pjsdas_gmail_automation_worker_token'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) as request_id
  where exists (
    select 1
    from public.google_drive_connections
    where gmail_automation_enabled = true
      and revoked_at is null
  );
  $cron$);
end
$migration$;

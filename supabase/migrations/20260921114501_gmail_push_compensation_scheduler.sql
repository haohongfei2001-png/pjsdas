-- UU06: turn the existing Gmail poller into a <=15 minute compensation
-- path and renew Gmail users.watch daily. This migration must be applied only
-- after the matching backend endpoints are deployed and verified.
--
-- No mailbox is enabled, no OAuth scope changes, no Discovery changes, and no
-- paid resource is created by this SQL.

do $migration$
declare
  gmail_job cron.job%rowtype;
  watch_job cron.job%rowtype;
  watch_job_count integer;
begin
  select * into strict gmail_job
  from cron.job
  where jobname = 'pjsdas-gmail-automation-hourly';

  if gmail_job.schedule not in ('5 * * * *', '*/10 * * * *') then
    raise exception 'Unexpected Gmail scheduler cadence; refusing to overwrite it.';
  end if;

  -- Preserve the existing command, endpoint, Vault identity, active state,
  -- database and owner. Only change cadence to a 10-minute compensation path.
  if gmail_job.schedule <> '*/10 * * * *' then
    perform cron.alter_job(gmail_job.jobid, schedule := '*/10 * * * *');
  end if;

  select count(*) into watch_job_count
  from cron.job
  where jobname = 'pjsdas-gmail-watch-renewal-daily';

  if watch_job_count > 1 then
    raise exception 'Duplicate Gmail watch renewal jobs; refusing to continue.';
  end if;

  if watch_job_count = 0 then
    perform cron.schedule(
      'pjsdas-gmail-watch-renewal-daily',
      '17 3 * * *',
      $cron$
      select net.http_post(
        url := rtrim(
          (select decrypted_secret
           from vault.decrypted_secrets
           where name = 'pjsdas_automation_backend_origin'),
          '/'
        ) || '/api/automation-gmail-watch',
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
          and gmail_intake_consent_version = 'uu06-v1'
      );
      $cron$
    );
  else
    select * into strict watch_job
    from cron.job
    where jobname = 'pjsdas-gmail-watch-renewal-daily';

    if watch_job.schedule <> '17 3 * * *' then
      perform cron.alter_job(watch_job.jobid, schedule := '17 3 * * *');
    end if;
  end if;
end
$migration$;

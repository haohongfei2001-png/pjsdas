-- UU06 owner deployment: use bounded polling as the production Gmail delivery mode.
-- This changes only the existing Gmail scheduler cadence from hourly to every 10 minutes.
-- Push/PubSub/watch remain dormant optional infrastructure. Discovery is untouched.
do $migration$
declare
  gmail_job cron.job%rowtype;
  gmail_count integer;
  watch_count integer;
begin
  select count(*) into gmail_count
  from cron.job
  where jobname = 'pjsdas-gmail-automation-hourly';

  if gmail_count <> 1 then
    raise exception 'Expected exactly one PJSDAS Gmail scheduler job; found %.', gmail_count;
  end if;

  select * into strict gmail_job
  from cron.job
  where jobname = 'pjsdas-gmail-automation-hourly';

  if gmail_job.schedule not in ('5 * * * *', '*/10 * * * *') then
    raise exception 'Unexpected Gmail scheduler cadence; refusing to overwrite it.';
  end if;

  select count(*) into watch_count
  from cron.job
  where jobname = 'pjsdas-gmail-watch-renewal-daily';

  if watch_count <> 0 then
    raise exception 'Gmail watch-renewal job exists; polling-only owner mode requires Push to remain dormant.';
  end if;

  if gmail_job.schedule <> '*/10 * * * *' then
    perform cron.alter_job(gmail_job.jobid, schedule := '*/10 * * * *');
  end if;
end
$migration$;

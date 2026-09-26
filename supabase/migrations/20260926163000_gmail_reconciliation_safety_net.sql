-- TodayAction reliability closure R01 / issue #125.
-- Schedule an independent Gmail reconciliation safety net at 08:30 and 17:30 Asia/Shanghai
-- (00:30 and 09:30 UTC) by deriving the exact authenticated command from the existing
-- Gmail scheduler. No new permission, token, endpoint identity, or primary cursor state.

do $migration$
declare
  primary_job cron.job%rowtype;
  reconcile_command text;
  morning_count integer;
  evening_count integer;
begin
  select * into strict primary_job
  from cron.job
  where jobname='pjsdas-gmail-automation-hourly';

  reconcile_command := replace(
    primary_job.command,
    '/api/automation-gmail',
    '/api/automation-gmail?mode=reconcile'
  );
  if reconcile_command = primary_job.command then
    raise exception 'Existing Gmail scheduler command does not contain the expected automation route.';
  end if;

  select count(*) into morning_count
  from cron.job where jobname='todayaction-gmail-reconciliation-0830';
  select count(*) into evening_count
  from cron.job where jobname='todayaction-gmail-reconciliation-1730';

  if morning_count > 1 or evening_count > 1 then
    raise exception 'Duplicate TodayAction Gmail reconciliation jobs exist.';
  end if;

  if morning_count = 0 then
    perform cron.schedule(
      'todayaction-gmail-reconciliation-0830',
      '30 0 * * *',
      reconcile_command
    );
  end if;

  if evening_count = 0 then
    perform cron.schedule(
      'todayaction-gmail-reconciliation-1730',
      '30 9 * * *',
      reconcile_command
    );
  end if;
end
$migration$;

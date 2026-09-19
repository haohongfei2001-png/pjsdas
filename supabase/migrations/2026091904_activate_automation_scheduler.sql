-- Round 5: activate production Gmail/Discovery automation truthfully.
--
-- The worker endpoints and independent Vault bearer tokens already exist.
-- The scheduler remains harmless with zero opt-in users: worker claim RPCs
-- return no bindings and do not mutate PJSDAS business state.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'pjsdas_automation_backend_origin'
      and decrypted_secret ~ '^https://'
  ) then
    raise exception 'PJSDAS automation backend origin is missing or not HTTPS.';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'pjsdas_gmail_automation_worker_token'
      and length(decrypted_secret) >= 32
  ) then
    raise exception 'PJSDAS Gmail automation worker token is missing.';
  end if;

  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'pjsdas_discovery_automation_worker_token'
      and length(decrypted_secret) >= 32
  ) then
    raise exception 'PJSDAS Discovery automation worker token is missing.';
  end if;
end
$$;

-- Gmail v1 scheduler RPCs are obsolete after complete-consumption v2.
revoke execute on function public.pjsdas_claim_gmail_automation_bindings(text)
  from anon, authenticated;
revoke execute on function public.pjsdas_update_gmail_automation_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean
) from anon, authenticated;

-- Gmail v2 remains scheduler-facing only through anon PostgREST carrying the
-- independent Vault worker token. Signed-in sessions do not need EXECUTE.
revoke execute on function public.pjsdas_claim_gmail_automation_bindings_v2(text)
  from authenticated;
revoke execute on function public.pjsdas_update_gmail_automation_state_v2(
  text, uuid, text, text, text, text, text[], timestamptz, timestamptz, text,
  boolean, boolean, boolean, boolean
) from authenticated;

do $$
declare
  existing_job bigint;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname in (
      'pjsdas-gmail-automation-hourly',
      'pjsdas-discovery-automation-hourly'
    )
  loop
    perform cron.unschedule(existing_job);
  end loop;
end
$$;

select cron.schedule(
  'pjsdas-gmail-automation-hourly',
  '5 * * * *',
  $cron$
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
  ) as request_id;
  $cron$
);

select cron.schedule(
  'pjsdas-discovery-automation-hourly',
  '15 * * * *',
  $cron$
  select net.http_post(
    url := rtrim(
      (select decrypted_secret
       from vault.decrypted_secrets
       where name = 'pjsdas_automation_backend_origin'),
      '/'
    ) || '/api/automation-discovery',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'pjsdas_discovery_automation_worker_token'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  ) as request_id;
  $cron$
);

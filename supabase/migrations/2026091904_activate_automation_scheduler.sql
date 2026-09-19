-- Round 5: activate the production automation scheduler truthfully.
--
-- The workers themselves remain explicit opt-in. At migration time the current
-- production project has zero Gmail/Discovery-enabled bindings, so creating
-- these cron jobs does not authorize or create job-search data.
--
-- Worker bearer tokens already live in Vault. The backend origin is also kept
-- in Vault so a future canonical API cutover does not require rewriting cron
-- commands or exposing secrets in cron.job.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'pjsdas_automation_backend_origin'
  ) then
    perform vault.create_secret(
      'https://pjsdas-remote-alpha.vercel.app',
      'pjsdas_automation_backend_origin',
      'Backend origin used by Supabase cron to invoke PJSDAS automation workers. Update this Vault secret during canonical API cutover.'
    );
  end if;
end
$$;

-- Gmail v1 scheduler RPCs are obsolete after complete-consumption v2.
revoke execute on function public.pjsdas_claim_gmail_automation_bindings(text) from anon;
revoke execute on function public.pjsdas_claim_gmail_automation_bindings(text) from authenticated;
revoke execute on function public.pjsdas_update_gmail_automation_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean
) from anon;
revoke execute on function public.pjsdas_update_gmail_automation_state(
  text, uuid, text, timestamptz, timestamptz, text, boolean, boolean
) from authenticated;

-- v2 remains scheduler-facing through anon PostgREST + independent Vault token.
revoke execute on function public.pjsdas_claim_gmail_automation_bindings_v2(text) from authenticated;
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
      url := rtrim((
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'pjsdas_automation_backend_origin'
      ), '/') || '/api/automation-gmail',
      body := '{}'::jsonb,
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'pjsdas_gmail_automation_worker_token'
        )
      ),
      timeout_milliseconds := 10000
    );
  $cron$
);

select cron.schedule(
  'pjsdas-discovery-automation-hourly',
  '20 * * * *',
  $cron$
    select net.http_post(
      url := rtrim((
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'pjsdas_automation_backend_origin'
      ), '/') || '/api/automation-discovery',
      body := '{}'::jsonb,
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'pjsdas_discovery_automation_worker_token'
        )
      ),
      timeout_milliseconds := 10000
    );
  $cron$
);

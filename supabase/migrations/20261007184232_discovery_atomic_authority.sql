-- B2: bind the existing Discovery consent/grant to its original admission.
-- No new capability, opt-in, user grant, table ACL, RLS policy or credential.
-- Old clients retain their existing columns and RPCs. New Discovery commits
-- fail closed unless this service-only guard is installed.
alter table public.pjsdas_authorization_grants
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists revision bigint not null default 1 check (revision > 0);
create unique index if not exists pjsdas_authorization_grants_identity_idx
  on public.pjsdas_authorization_grants(id);

create or replace function public.pjsdas_bump_ingestion_grant_revision()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    new.revision := 1;
    return new;
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
    or new.client_id is distinct from old.client_id or new.source_id is distinct from old.source_id
    or new.capability is distinct from old.capability then
    raise exception 'Ingestion grant identity is immutable.' using errcode = '22023';
  end if;
  new.revision := old.revision + 1;
  return new;
end
$$;
revoke all on function public.pjsdas_bump_ingestion_grant_revision() from public, anon, authenticated;
drop trigger if exists pjsdas_ingestion_grant_revision on public.pjsdas_authorization_grants;
create trigger pjsdas_ingestion_grant_revision before insert or update on public.pjsdas_authorization_grants
for each row execute function public.pjsdas_bump_ingestion_grant_revision();

alter table public.google_drive_connections
  add column if not exists discovery_consent_generation uuid not null default gen_random_uuid();
create or replace function public.pjsdas_rotate_discovery_consent_generation()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.discovery_consent_generation := gen_random_uuid();
    return new;
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'Discovery connection owner is immutable.' using errcode = '22023';
  end if;
  if new.discovery_automation_enabled is distinct from old.discovery_automation_enabled
    or new.revoked_at is distinct from old.revoked_at or new.google_subject is distinct from old.google_subject then
    new.discovery_consent_generation := gen_random_uuid();
  else
    -- Telemetry and ordinary same-subject token rotation do not renew consent.
    new.discovery_consent_generation := old.discovery_consent_generation;
  end if;
  return new;
end
$$;
revoke all on function public.pjsdas_rotate_discovery_consent_generation() from public, anon, authenticated;
drop trigger if exists pjsdas_discovery_consent_generation on public.google_drive_connections;
create trigger pjsdas_discovery_consent_generation before insert or update on public.google_drive_connections
for each row execute function public.pjsdas_rotate_discovery_consent_generation();

-- Reuse the existing worker-token verifier and opt-in selection. This newer
-- projection is restricted to the already trusted backend role; it does not
-- create another anonymous token endpoint or expose another account's rows.
create or replace function public.pjsdas_claim_enabled_discovery_automation_bindings_v2(worker_token text)
returns table (user_id uuid, google_subject text, google_email text, refresh_token_ciphertext text,
  granted_scopes text[], discovery_last_checked_at timestamptz, discovery_consent_generation uuid)
language sql security definer set search_path = public, pg_temp as $$
  select claimed.user_id, claimed.google_subject, claimed.google_email, claimed.refresh_token_ciphertext,
    claimed.granted_scopes, claimed.discovery_last_checked_at, connection.discovery_consent_generation
  from public.pjsdas_claim_enabled_discovery_automation_bindings(worker_token) claimed
  join public.google_drive_connections connection on connection.user_id = claimed.user_id
  where connection.revoked_at is null and connection.discovery_automation_enabled is true
    and connection.google_subject = claimed.google_subject
    and coalesce(connection.discovery_last_error, '') !~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])';
$$;
revoke all on function public.pjsdas_claim_enabled_discovery_automation_bindings_v2(text) from public, anon, authenticated;
grant execute on function public.pjsdas_claim_enabled_discovery_automation_bindings_v2(text) to service_role;

create or replace function public.pjsdas_commit_discovery_workspace_v1(
  target_user_id uuid, target_command_id text, target_operation text, target_payload_hash text,
  target_expected_revision bigint, target_snapshot jsonb, target_schema_version integer,
  target_principal_kind text, target_client_id text, target_provenance jsonb,
  target_compensation jsonb, target_effective_time timestamptz, target_receipt_context jsonb,
  target_discovery_authorization jsonb
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_authorization_grants%rowtype;
  active_connection public.google_drive_connections%rowtype;
  proof jsonb := target_discovery_authorization;
  trusted_proof jsonb;
  requested_source_id text := target_provenance ->> 'sourceId';
begin
  if target_operation is distinct from 'ingest_verified_discovery'
    or jsonb_typeof(proof) is distinct from 'object'
    or proof ->> 'userId' is distinct from target_user_id::text
    or nullif(trim(requested_source_id), '') is null then
    raise exception 'Discovery admission proof is required.' using errcode = '42501';
  end if;
  if target_principal_kind = 'automation' and proof ->> 'kind' = 'automation' and target_client_id is null then
    -- Consistent lock order: authority row, then the existing workspace CAS.
    select c.* into active_connection from public.google_drive_connections c
      where c.user_id = target_user_id for share;
    if not found or active_connection.revoked_at is not null
      or active_connection.discovery_automation_enabled is not true
      or active_connection.google_subject is distinct from proof ->> 'googleSubject'
      or active_connection.discovery_consent_generation::text is distinct from proof ->> 'consentGeneration'
      or coalesce(active_connection.discovery_last_error, '') ~ '^GOOGLE_AUTH_EXPIRED($|[:[:space:]\[])' then
      raise exception 'Discovery consent is absent, revoked, replaced or stale.' using errcode = '42501';
    end if;
    trusted_proof := jsonb_build_object('kind', 'automation', 'userId', active_connection.user_id,
      'consentGeneration', active_connection.discovery_consent_generation);
  elsif target_principal_kind = 'delegated_mcp' and proof ->> 'kind' = 'delegated_mcp'
    and nullif(trim(target_client_id), '') is not null
    and proof ->> 'clientId' = target_client_id and proof ->> 'sourceId' = requested_source_id then
    select g.* into active_grant from public.pjsdas_authorization_grants g
      where g.id::text = proof ->> 'grantId' and g.user_id = target_user_id
        and g.client_id = target_client_id and g.source_id = requested_source_id
        and g.capability = 'ingest_discovery_run' for share;
    if not found or active_grant.revoked_at is not null or active_grant.granted_at > now()
      or active_grant.revision::text is distinct from proof ->> 'grantRevision' then
      raise exception 'Discovery grant is absent, revoked, replaced or stale.' using errcode = '42501';
    end if;
    trusted_proof := jsonb_build_object('kind', 'delegated_mcp', 'userId', active_grant.user_id,
      'clientId', active_grant.client_id, 'sourceId', active_grant.source_id,
      'grantId', active_grant.id, 'grantRevision', active_grant.revision);
  else
    raise exception 'Unsupported Discovery admission authority.' using errcode = '42501';
  end if;
  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version, target_principal_kind,
    target_client_id, target_provenance, target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object('discoveryAuthorization', trusted_proof)
  );
end
$$;
revoke all on function public.pjsdas_commit_discovery_workspace_v1(
  uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_discovery_workspace_v1(
  uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb,jsonb
) to service_role;

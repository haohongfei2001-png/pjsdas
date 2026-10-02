-- Source-only consumer management foundation. Applying this migration does not
-- issue a grant or activate the plugin. Explicit consent wiring is separate.
create table if not exists public.pjsdas_business_management_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  capability text not null check (capability = 'workspace.manage'),
  consent_version integer not null check (consent_version = 2),
  consent_text_hash text not null check (consent_text_hash ~ '^[0-9a-f]{64}$'),
  revision bigint not null default 1 check (revision > 0),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, client_id, capability)
);
alter table public.pjsdas_business_management_grants enable row level security;
revoke all on table public.pjsdas_business_management_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.pjsdas_business_management_grants to service_role;

-- Revisions change on every update, including revoke/regrant. A replacement row
-- receives a different UUID so an old request cannot pass an ABA grant check.
create or replace function public.pjsdas_bump_management_grant_revision()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.client_id <> old.client_id or new.capability <> old.capability then
    raise exception 'Management grant identity is immutable.' using errcode = '22023';
  end if;
  new.revision := old.revision + 1;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
revoke all on function public.pjsdas_bump_management_grant_revision() from public, anon, authenticated;
drop trigger if exists pjsdas_management_grant_revision on public.pjsdas_business_management_grants;
create trigger pjsdas_management_grant_revision before update on public.pjsdas_business_management_grants
for each row execute function public.pjsdas_bump_management_grant_revision();

create or replace function public.pjsdas_commit_management_workspace_v1(
  target_user_id uuid,
  target_command_id text,
  target_operation text,
  target_payload_hash text,
  target_expected_revision bigint,
  target_snapshot jsonb,
  target_schema_version integer,
  target_principal_kind text,
  target_client_id text,
  target_provenance jsonb,
  target_compensation jsonb,
  target_effective_time timestamptz,
  target_receipt_context jsonb,
  target_grant_id uuid,
  target_grant_revision bigint
)
returns table (outcome text, workspace_id uuid, revision bigint, snapshot jsonb, receipt jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  active_grant public.pjsdas_business_management_grants%rowtype;
begin
  if target_principal_kind <> 'delegated_mcp' or target_principal_kind is null
    or nullif(trim(target_client_id), '') is null
    or target_grant_id is null or target_grant_revision is null then
    raise exception 'Management authorization is required.' using errcode = '42501';
  end if;

  -- This lock and the workspace/ledger mutation share ONE database transaction.
  -- A concurrent UPDATE/DELETE that revokes this row must serialize with commit.
  select g.* into active_grant
    from public.pjsdas_business_management_grants g
    where g.id = target_grant_id
      and g.user_id = target_user_id
      and g.client_id::text = target_client_id
      and g.capability = 'workspace.manage'
      and g.consent_version = 2
      and g.revision = target_grant_revision
      and g.revoked_at is null
      and g.granted_at <= now()
    for share;
  if not found then
    raise exception 'Management grant is absent, revoked, replaced or stale.' using errcode = '42501';
  end if;

  if target_operation = 'undo_command' then
    perform 1 from public.pjsdas_command_ledger
      where user_id = target_user_id
        and command_id = target_provenance ->> 'undoOf'
        and operation = 'business_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'business_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version,
    target_principal_kind, target_client_id, target_provenance,
    target_compensation, target_effective_time,
    coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'managementAuthorization', jsonb_build_object(
        'grantId', active_grant.id, 'grantRevision', active_grant.revision,
        'consentVersion', active_grant.consent_version
      )
    )
  );
end
$$;
revoke all on function public.pjsdas_commit_management_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_management_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) to service_role;

-- SOURCE ONLY: no live migration, grant issuance, consent upgrade or tool activation.
-- Keep all v2/v3/v4 scopes frozen. v5 profile permission does not approve a paid search.
-- Dependency: 20261002195807_planning_management_v4.sql. No live activation.
alter table public.pjsdas_business_management_grants
  drop constraint pjsdas_management_capability_version_check;
alter table public.pjsdas_business_management_grants add constraint pjsdas_management_capability_version_check
  check ((capability = 'workspace.manage' and consent_version = 2)
    or (capability = 'workspace.opportunity.manage' and consent_version = 3)
    or (capability = 'workspace.planning.manage' and consent_version = 4)
    or (capability = 'workspace.discovery-profile.manage' and consent_version = 5));

create or replace function public.pjsdas_commit_discovery_profile_workspace_v1(
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
  stored_workspace public.pjsdas_workspaces%rowtype;
  stored_timeline jsonb;
  proposed_timeline jsonb;
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
      and g.capability = 'workspace.discovery-profile.manage'
      and g.consent_version = 5
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
        and operation = 'discovery_profile_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'discovery_profile_management' then
    raise exception 'Unsupported management operation.' using errcode = '42501';
  end if;

  -- Whole-row profile writes may not persist normalization side effects from
  -- read/upgrade paths. Compare the protected stored data under the same CAS
  -- transaction before delegating. A stale CAS is handled by the base RPC.
  select * into stored_workspace from public.pjsdas_workspaces
    where user_id = target_user_id for update;
  if found and stored_workspace.revision = target_expected_revision then
    if ((target_snapshot -> 'data') - array['discoveryProfile','timeline'])
      is distinct from ((stored_workspace.snapshot -> 'data') - array['discoveryProfile','timeline']) then
      raise exception 'Discovery-profile management cannot rewrite other business data.' using errcode = '42501';
    end if;
    stored_timeline := coalesce(stored_workspace.snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    proposed_timeline := coalesce(target_snapshot -> 'data' -> 'timeline', '[]'::jsonb);
    if jsonb_typeof(proposed_timeline) is distinct from 'array'
      or jsonb_array_length(proposed_timeline) < jsonb_array_length(stored_timeline)
      or exists (select 1 from jsonb_array_elements(stored_timeline) with ordinality old_event(value, position)
        where proposed_timeline -> ((old_event.position - 1)::int) is distinct from old_event.value) then
      raise exception 'Discovery-profile management cannot rewrite existing audit history.' using errcode = '42501';
    end if;
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
revoke all on function public.pjsdas_commit_discovery_profile_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_discovery_profile_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) to service_role;

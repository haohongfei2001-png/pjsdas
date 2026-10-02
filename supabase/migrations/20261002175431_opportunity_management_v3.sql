-- SOURCE ONLY: no live migration, grant issuance, consent upgrade or tool activation.
-- Keep v2 workspace.manage meaning frozen. v3 is a different named capability;
-- its proof cannot enter the old RPC, nor can v2 enter the opportunity RPC.
alter table public.pjsdas_business_management_grants
  drop constraint pjsdas_business_management_grants_capability_check,
  drop constraint pjsdas_business_management_grants_consent_version_check;
alter table public.pjsdas_business_management_grants add constraint pjsdas_management_capability_version_check
  check ((capability = 'workspace.manage' and consent_version = 2)
    or (capability = 'workspace.opportunity.manage' and consent_version = 3));

create or replace function public.pjsdas_commit_opportunity_workspace_v1(
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
      and g.capability = 'workspace.opportunity.manage'
      and g.consent_version = 3
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
        and operation = 'opportunity_management'
        and status = 'COMMITTED';
    if not found then
      raise exception 'Management undo target was not found.' using errcode = '42501';
    end if;
  elsif target_operation is distinct from 'opportunity_management' then
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
revoke all on function public.pjsdas_commit_opportunity_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.pjsdas_commit_opportunity_workspace_v1(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb, uuid, bigint
) to service_role;

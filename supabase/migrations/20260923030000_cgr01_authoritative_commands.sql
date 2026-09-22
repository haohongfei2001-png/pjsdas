-- CGR-01 Authoritative Command Foundation.
--
-- Additive only: preserve the existing JSONB transactional workspace and v1 RPC.
-- The v2 RPC enriches durable receipts with object/dependency metadata while
-- retaining service-role-only mutation authority and global CAS serialization.

create index if not exists pjsdas_command_ledger_user_revision_idx
  on public.pjsdas_command_ledger (user_id, resulting_revision)
  where status = 'COMMITTED';

create or replace function public.pjsdas_commit_workspace_v2(
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
  target_receipt_context jsonb
)
returns table (
  outcome text,
  workspace_id uuid,
  revision bigint,
  snapshot jsonb,
  receipt jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_workspace public.pjsdas_workspaces%rowtype;
  existing_command public.pjsdas_command_ledger%rowtype;
  next_revision bigint;
  next_receipt jsonb;
begin
  if target_user_id is null
    or nullif(trim(target_command_id), '') is null
    or nullif(trim(target_operation), '') is null
    or nullif(trim(target_payload_hash), '') is null
    or target_snapshot is null
    or nullif(trim(target_principal_kind), '') is null then
    raise exception 'PJSDAS v2 commit arguments are incomplete.' using errcode = '22023';
  end if;

  select * into current_workspace
  from public.pjsdas_workspaces
  where user_id = target_user_id
  for update;

  if not found then
    raise exception 'PJSDAS connected workspace does not exist.' using errcode = 'P0001';
  end if;

  select * into existing_command
  from public.pjsdas_command_ledger
  where user_id = target_user_id
    and command_id = target_command_id;

  if found then
    if existing_command.payload_hash <> target_payload_hash then
      raise exception 'PJSDAS command id was reused with a different payload.' using errcode = '23505';
    end if;

    outcome := 'ALREADY_APPLIED';
    workspace_id := existing_command.workspace_id;
    revision := current_workspace.revision;
    snapshot := current_workspace.snapshot;
    receipt := existing_command.receipt;
    return next;
    return;
  end if;

  if target_expected_revision is null or current_workspace.revision <> target_expected_revision then
    outcome := 'CONFLICT';
    workspace_id := current_workspace.id;
    revision := current_workspace.revision;
    snapshot := current_workspace.snapshot;
    receipt := coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
      'commandId', target_command_id,
      'receiptId', 'command-receipt:' || target_command_id,
      'status', 'CONFLICT',
      'expectedRevision', target_expected_revision,
      'actualRevision', current_workspace.revision
    );
    return next;
    return;
  end if;

  next_revision := current_workspace.revision + 1;
  next_receipt := coalesce(target_receipt_context, '{}'::jsonb) || jsonb_build_object(
    'commandId', target_command_id,
    'receiptId', 'command-receipt:' || target_command_id,
    'status', 'COMMITTED',
    'operation', target_operation,
    'revision', next_revision,
    'committedAt', now(),
    'undoAvailable', target_compensation is not null
  );

  update public.pjsdas_workspaces
  set
    snapshot = target_snapshot,
    revision = next_revision,
    schema_version = target_schema_version,
    updated_at = now()
  where id = current_workspace.id;

  insert into public.pjsdas_command_ledger (
    workspace_id,
    user_id,
    command_id,
    operation,
    payload_hash,
    expected_revision,
    principal_kind,
    client_id,
    provenance,
    compensation,
    effective_time,
    status,
    resulting_revision,
    receipt,
    updated_at
  )
  values (
    current_workspace.id,
    target_user_id,
    target_command_id,
    target_operation,
    target_payload_hash,
    target_expected_revision,
    target_principal_kind,
    target_client_id,
    coalesce(target_provenance, '{}'::jsonb),
    target_compensation,
    target_effective_time,
    'COMMITTED',
    next_revision,
    next_receipt,
    now()
  );

  outcome := 'COMMITTED';
  workspace_id := current_workspace.id;
  revision := next_revision;
  snapshot := target_snapshot;
  receipt := next_receipt;
  return next;
end
$$;

revoke all on function public.pjsdas_commit_workspace_v2(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb
) from public, anon, authenticated;

grant execute on function public.pjsdas_commit_workspace_v2(
  uuid, text, text, text, bigint, jsonb, integer, text, text, jsonb, jsonb, timestamptz, jsonb
) to service_role;

-- B2 runtime wiring candidate: no deployment is authorized by this file.
-- Replaces only the body of the already service-only Discovery RPC. Its owner,
-- signature, invoker security, ACLs, table grants and RLS policies are retained.
-- A budget hold is allocated with the original claim under the existing locks.
-- It is a conservative planning envelope, not a vendor billing guarantee.
-- Unknown/unused holds are deliberately retained; this migration creates no
-- release/refund path and cannot change an approval's original terms.
do $$ begin
  if to_regprocedure('public.pjsdas_commit_discovery_workspace_v1(uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb,jsonb)') is null then
    raise exception 'The existing Discovery authority guard must be installed first.';
  end if;
end $$;

-- The partial index contains only this new bookkeeping metadata. It adds no
-- table, credential, role, grant or user-visible editing surface.
create index if not exists pjsdas_discovery_budget_approval_idx
  on public.pjsdas_command_ledger (user_id, (provenance #>> '{discoveryBudgetHold,policy,approvalId}'))
  where status = 'COMMITTED' and operation = 'checkpoint_discovery_search' and principal_kind = 'automation'
    and provenance ->> 'searchPhase' = 'claimed' and provenance ? 'discoveryBudgetHold';

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
  checkpoint_workspace public.pjsdas_workspaces%rowtype;
  original_claim public.pjsdas_command_ledger%rowtype;
  proof jsonb := target_discovery_authorization;
  trusted_proof jsonb;
  budget_hold jsonb;
  budget_policy jsonb;
  prior_budget_policy jsonb;
  trusted_budget jsonb;
  budget_amount bigint;
  budget_cap bigint;
  held_total numeric;
  budget_admitted boolean;
  budget_starts_at timestamptz;
  budget_expires_at timestamptz;
  requested_source_id text := target_provenance ->> 'sourceId';
begin
  if target_operation not in ('ingest_verified_discovery', 'checkpoint_discovery_search') or target_operation is null
    or jsonb_typeof(proof) is distinct from 'object'
    or proof ->> 'userId' is distinct from target_user_id::text
    or nullif(trim(requested_source_id), '') is null then
    raise exception 'Discovery admission proof is required.' using errcode = '42501';
  end if;
  if target_provenance ? 'discoveryBudgetHold' and (
    target_operation is distinct from 'checkpoint_discovery_search'
    or target_provenance ->> 'searchPhase' is distinct from 'claimed'
  ) then raise exception 'Only an internal original claim can propose a budget hold.' using errcode = '42501'; end if;
  -- Checkpoints are internal automation bookkeeping under the same consent
  -- lock. No delegated client gains a cursor-writing capability.
  if target_operation = 'checkpoint_discovery_search' and (
    target_principal_kind is distinct from 'automation' or proof ->> 'kind' is distinct from 'automation'
    or target_client_id is not null or target_compensation is not null
    or target_provenance ->> 'producer' is distinct from 'server_scheduler'
    or coalesce(target_provenance ->> 'searchPhase', '') not in ('claimed', 'settled')
    or coalesce(target_provenance ->> 'searchPlanFingerprint', '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_provenance ->> 'scopeFingerprint', '') !~ '^[a-f0-9]{64}$'
    or coalesce(target_provenance ->> 'searchCycleId', '') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(target_provenance -> 'searchBatch') is distinct from 'object'
    or target_provenance -> 'searchBatch' ->> 'phase' is distinct from target_provenance ->> 'searchPhase'
    or target_provenance -> 'searchBatch' ->> 'planFingerprint' is distinct from target_provenance ->> 'searchPlanFingerprint'
    or target_provenance -> 'searchBatch' ->> 'cycleId' is distinct from target_provenance ->> 'searchCycleId'
    or coalesce(target_provenance -> 'searchBatch' ->> 'claimAttemptId', '') !~ '^[a-f0-9-]{36}$'
    or jsonb_typeof(target_provenance -> 'searchBatch' -> 'index') is distinct from 'number'
    or target_provenance -> 'searchBatch' ->> 'index' is distinct from target_provenance ->> 'searchBatchIndex'
  ) then raise exception 'Only internal Discovery automation checkpoints are allowed.' using errcode = '42501'; end if;
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
  if target_operation = 'checkpoint_discovery_search' then
    select w.* into checkpoint_workspace from public.pjsdas_workspaces w where w.user_id = target_user_id for update;
    -- Preserve the ordinary CAS conflict/replay behavior. A current-revision
    -- checkpoint can only submit the exact existing authoritative snapshot.
    if found and checkpoint_workspace.revision = target_expected_revision
      and (target_snapshot is distinct from checkpoint_workspace.snapshot or target_schema_version is distinct from checkpoint_workspace.schema_version) then
      raise exception 'Search checkpoints cannot mutate workspace data.' using errcode = '42501';
    end if;
  end if;
  if target_provenance ? 'searchBatch' then
    if target_principal_kind is distinct from 'automation' or proof ->> 'kind' is distinct from 'automation' then
      raise exception 'Only server automation owns search progress.' using errcode = '42501';
    end if;
    if target_operation = 'ingest_verified_discovery' and target_provenance ->> 'searchPhase' is distinct from 'settled' then
      raise exception 'Discovery facts can only settle an original search claim.' using errcode = '42501';
    end if;
    -- Serialize progress admission with the original workspace transaction.
    perform 1 from public.pjsdas_workspaces w where w.user_id = target_user_id for update;
    select c.* into original_claim from public.pjsdas_command_ledger c
      where c.user_id = target_user_id and c.operation = 'checkpoint_discovery_search' and c.status = 'COMMITTED'
        and c.principal_kind = 'automation' and c.provenance ->> 'producer' = 'server_scheduler'
        and c.provenance ->> 'sourceId' = requested_source_id
        and c.provenance ->> 'scopeFingerprint' = target_provenance ->> 'scopeFingerprint'
        and c.provenance ->> 'searchPlanFingerprint' = target_provenance ->> 'searchPlanFingerprint'
        and c.provenance ->> 'searchCycleId' = target_provenance ->> 'searchCycleId'
        and c.provenance ->> 'searchBatchIndex' = target_provenance ->> 'searchBatchIndex'
        and c.provenance ->> 'searchPhase' = 'claimed';
    if target_provenance ->> 'searchPhase' = 'settled' then
      if not found or original_claim.provenance -> 'searchBatch' ->> 'claimAttemptId'
        is distinct from target_provenance -> 'searchBatch' ->> 'claimAttemptId' then
        raise exception 'Search settlement requires its original claim.' using errcode = '42501';
      end if;
    elsif target_provenance ->> 'searchPhase' = 'claimed' then
      if found and original_claim.command_id is distinct from target_command_id then
        raise exception 'This search batch already has an original claim.' using errcode = '42501';
      end if;
      if (target_provenance ->> 'searchBatchIndex')::integer > 0 and not exists (
        select 1 from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
          and c.principal_kind = 'automation' and c.provenance ->> 'producer' = 'server_scheduler'
          and c.provenance ->> 'sourceId' = requested_source_id
          and c.provenance ->> 'searchPlanFingerprint' = target_provenance ->> 'searchPlanFingerprint'
          and c.provenance ->> 'searchCycleId' = target_provenance ->> 'searchCycleId'
          and c.provenance ->> 'searchBatchIndex' = ((target_provenance ->> 'searchBatchIndex')::integer - 1)::text
          and c.provenance ->> 'searchPhase' = 'settled'
      ) then raise exception 'Search progress cannot skip an unsettled batch.' using errcode = '42501'; end if;
    else raise exception 'Invalid search progress phase.' using errcode = '42501'; end if;
    if target_provenance ->> 'searchPhase' = 'settled' and exists (select 1 from public.pjsdas_command_ledger c
      where c.user_id = target_user_id and c.status = 'COMMITTED'
        and c.provenance ->> 'sourceId' = requested_source_id
        and c.provenance ->> 'searchPlanFingerprint' = target_provenance ->> 'searchPlanFingerprint'
        and c.provenance ->> 'searchCycleId' = target_provenance ->> 'searchCycleId'
        and c.provenance ->> 'searchBatchIndex' = target_provenance ->> 'searchBatchIndex'
        and c.provenance ->> 'searchPhase' = 'settled' and c.command_id is distinct from target_command_id) then
      raise exception 'This search batch already has its immutable settlement.' using errcode = '42501';
    end if;
    if target_provenance ->> 'searchPhase' = 'claimed' and target_provenance ? 'discoveryBudgetHold' then
      budget_hold := target_provenance -> 'discoveryBudgetHold';
      budget_policy := budget_hold -> 'policy';
      if jsonb_typeof(budget_hold) is distinct from 'object'
        or budget_hold - array['version','policy','policyFingerprint','sourceId','claimAttemptId','searchRequestLimit','modelRequestLimit','reservedMicroUsd'] <> '{}'::jsonb
        or budget_hold -> 'version' is distinct from '1'::jsonb
        or jsonb_typeof(budget_hold -> 'sourceId') is distinct from 'string'
        or jsonb_typeof(budget_hold -> 'claimAttemptId') is distinct from 'string'
        or coalesce(budget_hold ->> 'claimAttemptId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or budget_hold ->> 'sourceId' is distinct from requested_source_id
        or budget_hold ->> 'claimAttemptId' is distinct from target_provenance -> 'searchBatch' ->> 'claimAttemptId'
        or jsonb_typeof(budget_hold -> 'policyFingerprint') is distinct from 'string'
        or coalesce(budget_hold ->> 'policyFingerprint', '') !~ '^[a-f0-9]{64}$'
        or budget_hold ->> 'modelRequestLimit' is distinct from '1'
        or jsonb_typeof(budget_hold -> 'modelRequestLimit') is distinct from 'number'
        or jsonb_typeof(budget_hold -> 'searchRequestLimit') is distinct from 'number'
        or coalesce(budget_hold ->> 'searchRequestLimit', '') !~ '^[1-9][0-9]?$'
        or budget_hold ->> 'searchRequestLimit' is distinct from target_provenance -> 'searchBatch' ->> 'queryCount'
        or jsonb_typeof(budget_hold -> 'reservedMicroUsd') is distinct from 'number'
        or coalesce(budget_hold ->> 'reservedMicroUsd', '') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(budget_policy) is distinct from 'object'
        or budget_policy - array['version','application','approvalId','accountId','scopeFingerprint','currency','maximumMicroUsd','validFrom','expiresAt','tariffVersion'] <> '{}'::jsonb
        or budget_policy -> 'version' is distinct from '1'::jsonb
        or budget_policy ->> 'application' is distinct from 'todayaction'
        or budget_policy ->> 'accountId' is distinct from target_user_id::text
        or budget_policy ->> 'scopeFingerprint' is distinct from target_provenance ->> 'scopeFingerprint'
        or budget_policy ->> 'currency' is distinct from 'USD'
        or budget_policy ->> 'tariffVersion' is distinct from 'todayaction-standard-search-text-2026-10-08'
        or jsonb_typeof(budget_policy -> 'approvalId') is distinct from 'string'
        or jsonb_typeof(budget_policy -> 'scopeFingerprint') is distinct from 'string'
        or coalesce(budget_policy ->> 'scopeFingerprint', '') !~ '^[a-f0-9]{64}$'
        or coalesce(budget_policy ->> 'approvalId', '') !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$'
        or jsonb_typeof(budget_policy -> 'maximumMicroUsd') is distinct from 'number'
        or coalesce(budget_policy ->> 'maximumMicroUsd', '') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(budget_policy -> 'validFrom') is distinct from 'string'
        or jsonb_typeof(budget_policy -> 'expiresAt') is distinct from 'string'
        or coalesce(budget_policy ->> 'validFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
        or coalesce(budget_policy ->> 'expiresAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
        raise exception 'Invalid account-bound Discovery budget terms.' using errcode = '42501';
      end if;
      budget_amount := (budget_hold ->> 'reservedMicroUsd')::bigint;
      budget_cap := (budget_policy ->> 'maximumMicroUsd')::bigint;
      if (budget_hold ->> 'searchRequestLimit')::integer > 48
        or budget_amount <> (budget_hold ->> 'searchRequestLimit')::bigint * 5000 + 427031
        or budget_cap > 9007199254740991 then
        raise exception 'The hold does not cover the complete fixed-tariff batch.' using errcode = '42501';
      end if;
      begin
        budget_starts_at := (budget_policy ->> 'validFrom')::timestamptz;
        budget_expires_at := (budget_policy ->> 'expiresAt')::timestamptz;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'Invalid Discovery budget window.' using errcode = '42501';
      end;
      if not isfinite(budget_starts_at) or not isfinite(budget_expires_at) or budget_expires_at <= budget_starts_at then
        raise exception 'Invalid Discovery budget window.' using errcode = '42501';
      end if;
      if original_claim.command_id = target_command_id then
        -- A retry preserves the original decision and amount, including a
        -- rejected hold. It never tests the remaining cap a second time.
        if original_claim.provenance -> 'discoveryBudgetHold' is distinct from budget_hold
          or original_claim.receipt -> 'discoveryBudget' is null then
          raise exception 'Budget replay differs from its original claim.' using errcode = '42501';
        end if;
        trusted_budget := original_claim.receipt -> 'discoveryBudget';
      else
        -- Use wall time after both authority and workspace locks. Waiting on a
        -- lock cannot extend an expired approval using transaction start time.
        if clock_timestamp() < budget_starts_at or clock_timestamp() >= budget_expires_at then
          raise exception 'Discovery budget window is closed.' using errcode = '42501';
        end if;
        select c.provenance #> '{discoveryBudgetHold,policy}' into prior_budget_policy
          from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
            and c.operation = 'checkpoint_discovery_search' and c.principal_kind = 'automation'
            and c.provenance ->> 'searchPhase' = 'claimed' and c.provenance ? 'discoveryBudgetHold'
            and c.provenance #>> '{discoveryBudgetHold,policy,approvalId}' = budget_policy ->> 'approvalId'
          order by c.resulting_revision limit 1;
        if found and prior_budget_policy is distinct from budget_policy then
          raise exception 'An existing budget approval cannot change terms or reset its cap.' using errcode = '42501';
        end if;
        if exists (select 1 from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
            and c.operation = 'checkpoint_discovery_search' and c.principal_kind = 'automation'
            and c.provenance ->> 'searchPhase' = 'claimed' and c.provenance ? 'discoveryBudgetHold'
            and c.provenance #>> '{discoveryBudgetHold,policy,approvalId}' = budget_policy ->> 'approvalId'
            and (c.receipt #>> '{discoveryBudget,version}' is distinct from '1'
              or c.receipt #> '{discoveryBudget,hold}' is distinct from c.provenance -> 'discoveryBudgetHold'
              or jsonb_typeof(c.receipt #> '{discoveryBudget,admitted}') is distinct from 'boolean'
              or c.receipt #>> '{discoveryBudget,retainedMicroUsd}' is distinct from
                case when c.receipt #>> '{discoveryBudget,admitted}' = 'true'
                  then c.provenance #>> '{discoveryBudgetHold,reservedMicroUsd}' else '0' end)) then
          raise exception 'An original budget hold lacks verified admission; reconcile before new spending.' using errcode = '42501';
        end if;
        select coalesce(sum((c.receipt #>> '{discoveryBudget,retainedMicroUsd}')::numeric), 0) into held_total
          from public.pjsdas_command_ledger c where c.user_id = target_user_id and c.status = 'COMMITTED'
            and c.operation = 'checkpoint_discovery_search' and c.principal_kind = 'automation'
            and c.provenance ->> 'searchPhase' = 'claimed' and c.provenance ? 'discoveryBudgetHold'
            and c.provenance #>> '{discoveryBudgetHold,policy,approvalId}' = budget_policy ->> 'approvalId';
        budget_admitted := held_total + budget_amount <= budget_cap;
        trusted_budget := jsonb_build_object('version', 1, 'hold', budget_hold, 'admitted', budget_admitted,
          'retainedMicroUsd', case when budget_admitted then budget_amount else 0 end);
      end if;
    elsif target_provenance ->> 'searchPhase' = 'settled' and original_claim.provenance ? 'discoveryBudgetHold' then
      trusted_budget := original_claim.receipt -> 'discoveryBudget';
      if trusted_budget is null then raise exception 'The original budget admission is unavailable.' using errcode = '42501'; end if;
      if trusted_budget ->> 'admitted' = 'false' and (
        target_operation <> 'checkpoint_discovery_search'
        or target_provenance -> 'searchBatch' ->> 'outcome' is distinct from 'budget_exhausted'
      ) then raise exception 'A declined budget claim cannot record successful retrieval or facts.' using errcode = '42501'; end if;
    end if;
  end if;
  return query select * from public.pjsdas_commit_workspace_v2(
    target_user_id, target_command_id, target_operation, target_payload_hash,
    target_expected_revision, target_snapshot, target_schema_version, target_principal_kind,
    target_client_id, target_provenance, target_compensation, target_effective_time,
    (coalesce(target_receipt_context, '{}'::jsonb) - 'discoveryBudget')
      || jsonb_build_object('discoveryAuthorization', trusted_proof)
      || case when trusted_budget is null then '{}'::jsonb else jsonb_build_object('discoveryBudget', trusted_budget) end
  );
end
$$;

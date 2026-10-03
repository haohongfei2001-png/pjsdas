-- Source-only first-party empty-start wrapper. Existing migration/import RPC unchanged.
create function public.pjsdas_bootstrap_consumer_workspace_v1(
 target_user_id uuid, initial_snapshot jsonb, initial_schema_version integer,
 initial_source_fingerprint text, initial_migrated_from text,
 target_first_party boolean, target_audience_mode text
) returns table(outcome text,workspace_id uuid,revision bigint,snapshot jsonb)
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if target_first_party is distinct from true or target_user_id is null
  or target_audience_mode is null or target_audience_mode not in ('allowlist','legacy')
  or initial_schema_version is distinct from 4
  or initial_migrated_from is distinct from 'explicit-consumer-empty-start'
  or initial_snapshot->>'schema' is distinct from 'pjsdas-local-snapshot'
  or initial_snapshot->'version' is distinct from '4'::jsonb
  or octet_length(initial_snapshot::text)>1048576 then
  raise exception 'Explicit first-party empty initialization required.' using errcode='42501';
 end if;
 if exists(select 1 from unnest(array['opportunities','processes','processEvents','actions','prep','applicationGroups','scheduleNodes','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox','discoveryInbox','changeSets']) key where initial_snapshot->'data'->key is distinct from '[]'::jsonb) then
  raise exception 'Consumer initialization accepts only empty business collections.' using errcode='42501';
 end if;
 -- This SHARE lock lasts through the UNIQUE(user_id) bootstrap transaction.
 -- Audience revocation that wins first is rechecked; initialization that wins
 -- first completes before revocation. No snapshot overwrite is possible.
 if target_audience_mode='allowlist' then
  perform 1 from public.pjsdas_access_grants a where a.user_id=target_user_id
   and a.role in ('owner','beta') and a.revoked_at is null for share;
  if not found then raise exception 'Current audience access required.' using errcode='42501';end if;
 end if;
 return query select * from public.pjsdas_bootstrap_workspace(target_user_id,initial_snapshot,initial_schema_version,initial_source_fingerprint,initial_migrated_from);
end $$;
revoke all on function public.pjsdas_bootstrap_consumer_workspace_v1(uuid,jsonb,integer,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.pjsdas_bootstrap_consumer_workspace_v1(uuid,jsonb,integer,text,text,boolean,text) to service_role;

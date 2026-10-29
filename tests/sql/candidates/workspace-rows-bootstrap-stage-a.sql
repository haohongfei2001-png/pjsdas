-- Existing active layout only. Never initializes rows, overwrites data, or
-- changes source fingerprints. Consumer empty-start keeps its original checks.
create function pjsdas_rows_candidate.bootstrap_existing(target_user_id uuid,target_epoch uuid,initial_snapshot jsonb,initial_schema_version integer,initial_migrated_from text,target_audience_mode text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare h pjsdas_rows_candidate.head%rowtype;
begin
 if target_user_id is null or target_epoch is null then raise exception 'existing generation required' using errcode='22023';end if;
 if target_audience_mode is not null then
  if target_audience_mode not in ('allowlist','legacy') or initial_schema_version is distinct from 4
   or initial_migrated_from is distinct from 'explicit-consumer-empty-start'
   or initial_snapshot is null or initial_snapshot->>'schema' is distinct from 'pjsdas-local-snapshot'
   or initial_snapshot->'version' is distinct from '4'::jsonb or octet_length(initial_snapshot::text)>1048576 then
    raise exception 'explicit consumer empty-start required' using errcode='42501';end if;
  if exists(select 1 from unnest(array['opportunities','processes','processEvents','actions','prep','applicationGroups','scheduleNodes','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox','discoveryInbox','changeSets']) key where initial_snapshot->'data'->key is distinct from '[]'::jsonb) then
    raise exception 'consumer initialization accepts only empty collections' using errcode='42501';end if;
  if target_audience_mode='allowlist' then
   perform 1 from public.pjsdas_access_grants a where a.user_id=target_user_id and a.role in ('owner','beta') and a.revoked_at is null for share;
   if not found then raise exception 'current audience access required' using errcode='42501';end if;
  end if;
 end if;
 perform pjsdas_rows_internal.assert_row_generation(target_user_id,target_epoch);
 select * into h from pjsdas_rows_candidate.head where user_id=target_user_id;
 if not found or h.epoch is distinct from target_epoch then raise exception 'active generation absent' using errcode='PT409';end if;
 return jsonb_build_object('outcome','EXISTS','workspaceId',h.id,'userId',h.user_id,'epoch',h.epoch,'revision',h.revision);
end$$;
revoke all on function pjsdas_rows_candidate.bootstrap_existing(uuid,uuid,jsonb,integer,text,text) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.bootstrap_existing(uuid,uuid,jsonb,integer,text,text) to service_role;

-- Isolated Stage-A public-only transport candidate. NOT a production migration.
-- No new exposed schema, role, or SECURITY DEFINER privilege. Atomic DDL/ACL.
begin;
create function pjsdas_rows_internal.require_active_layout(target_user_id uuid,target_epoch uuid)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare active_epoch uuid;
begin
 -- Read-only preflight adds no authority/workspace lock inversion. The lower
 -- guarded writers still acquire their original grant/binding then workspace
 -- locks and recheck the epoch. An active marker cannot be cleared by old writes.
 select w.row_candidate_epoch into active_epoch from public.pjsdas_workspaces w
 join pjsdas_rows_candidate.head h on h.id=w.id and h.user_id=w.user_id and h.epoch=w.row_candidate_epoch
 where w.user_id=target_user_id;
 if not found or active_epoch is null or (target_epoch is not null and target_epoch is distinct from active_epoch) then
  raise exception 'public row transport requires the activated generation' using errcode='PT409';
 end if;
end$$;
revoke all on function pjsdas_rows_internal.require_active_layout(uuid,uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.require_active_layout(uuid,uuid) to service_role;
create function public.pjsdas_rows_v1_read_head(target_user_id uuid) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null); return pjsdas_rows_candidate.read_head($1); end $$;
revoke all on function public.pjsdas_rows_v1_read_head(uuid) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_read_head(uuid) to service_role;
create function public.pjsdas_rows_v1_read_page(target_user_id uuid,target_workspace_id uuid,target_epoch uuid,target_revision bigint,after_collection text default null,after_ordinal bigint default null,max_rows integer default 127) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,target_epoch); return pjsdas_rows_candidate.read_page($1,$2,$3,$4,$5,$6,$7); end $$;
revoke all on function public.pjsdas_rows_v1_read_page(uuid,uuid,uuid,bigint,text,bigint,integer) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_read_page(uuid,uuid,uuid,bigint,text,bigint,integer) to service_role;
create function public.pjsdas_rows_v1_read_history(target_user_id uuid,target_epoch uuid,target_revision bigint,query jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,target_epoch); return pjsdas_rows_candidate.read_history($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_read_history(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_read_history(uuid,uuid,bigint,jsonb) to service_role;
create function public.pjsdas_rows_v1_bootstrap_existing(target_user_id uuid,target_epoch uuid,initial_snapshot jsonb,initial_schema_version integer,initial_migrated_from text,target_audience_mode text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,target_epoch); return pjsdas_rows_candidate.bootstrap_existing($1,$2,$3,$4,$5,$6); end $$;
revoke all on function public.pjsdas_rows_v1_bootstrap_existing(uuid,uuid,jsonb,integer,text,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_bootstrap_existing(uuid,uuid,jsonb,integer,text,text) to service_role;
create function public.pjsdas_rows_v1_commit_rows(req jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_rows($1); end $$;
revoke all on function public.pjsdas_rows_v1_commit_rows(jsonb) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_rows(jsonb) to service_role;
create function public.pjsdas_rows_v1_commit_authoritative(req jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_authoritative($1); end $$;
revoke all on function public.pjsdas_rows_v1_commit_authoritative(jsonb) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_authoritative(jsonb) to service_role;
create function public.pjsdas_rows_v1_commit_planning(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_planning($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_commit_planning(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_planning(jsonb,uuid,bigint,text) to service_role;
create function public.pjsdas_rows_v1_commit_discovery_profile(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_discovery_profile($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_commit_discovery_profile(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_discovery_profile(jsonb,uuid,bigint,text) to service_role;
create function public.pjsdas_rows_v1_commit_private_reminder(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_private_reminder($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_commit_private_reminder(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_private_reminder(jsonb,uuid,bigint,text) to service_role;
create function public.pjsdas_rows_v1_commit_opportunity(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_opportunity($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_commit_opportunity(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_opportunity(jsonb,uuid,bigint,text) to service_role;
create function public.pjsdas_rows_v1_commit_business(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_business($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_commit_business(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_business(jsonb,uuid,bigint,text) to service_role;
create function public.pjsdas_rows_v1_commit_management_v2(req jsonb,target_grant_id uuid,target_grant_revision bigint,target_client_id text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_management_v2($1,$2,$3,$4); end $$;
revoke all on function public.pjsdas_rows_v1_commit_management_v2(jsonb,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_management_v2(jsonb,uuid,bigint,text) to service_role;
create function public.pjsdas_rows_v1_commit_ai_capture(req jsonb,target_capture_request_id text,target_capture_observation jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_ai_capture($1,$2,$3); end $$;
revoke all on function public.pjsdas_rows_v1_commit_ai_capture(jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_ai_capture(jsonb,text,jsonb) to service_role;
create function public.pjsdas_rows_v1_admit_ai_capture(
  target_user_id uuid, target_request_id text, target_payload_hash text,
  target_text text, target_timezone text, target_reference_time timestamptz,
  target_expected_revision bigint, target_reservation_units bigint, target_epoch uuid
) returns setof public.pjsdas_ai_capture_previews
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,target_epoch); return query select * from pjsdas_rows_candidate.admit_ai_capture($1,$2,$3,$4,$5,$6,$7,$8,$9); return; end $$;
revoke all on function public.pjsdas_rows_v1_admit_ai_capture(uuid,text,text,text,text,timestamptz,bigint,bigint,uuid) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_admit_ai_capture(uuid,text,text,text,text,timestamptz,bigint,bigint,uuid) to service_role;
create function public.pjsdas_rows_v1_commit_discovery(req jsonb,target_discovery_authorization jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout((req->>'userId')::uuid,(req->>'expectedEpoch')::uuid); return pjsdas_rows_candidate.commit_discovery($1,$2); end $$;
revoke all on function public.pjsdas_rows_v1_commit_discovery(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.pjsdas_rows_v1_commit_discovery(jsonb,jsonb) to service_role;
commit;

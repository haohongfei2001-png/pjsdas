-- LOCAL REVIEW CANDIDATE ONLY. Requires approved static preimage and supported atomic transport.
BEGIN;
-- SYNTHETIC DESIGN CANDIDATE ONLY. NOT AN APPROVED PRODUCTION MIGRATION.
-- Existing Stage A layout fence must already be installed.
-- Production requires a static catalog/ACL preimage and atomic approved transport.
-- Drain database transactions already selecting this relation, not HTTP buffers.
lock table public.pjsdas_workspaces in access exclusive mode;
create role pjsdas_workspace_blob_reader nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
grant pjsdas_workspace_blob_reader to CURRENT_USER with set true,inherit false;
grant create on schema pjsdas_rows_internal to pjsdas_workspace_blob_reader;
grant usage on schema public,pjsdas_rows_internal to pjsdas_workspace_blob_reader;
grant select on public.pjsdas_workspaces to pjsdas_workspace_blob_reader;
-- PostgreSQL requires an UPDATE column privilege for SELECT FOR UPDATE.
-- No function below issues an UPDATE; the role has no login or application-role members; creator retains only bootstrap ADMIN membership.
grant update(id) on public.pjsdas_workspaces to pjsdas_workspace_blob_reader;
create policy pjsdas_blob_reader_select on public.pjsdas_workspaces for select to pjsdas_workspace_blob_reader using (true);
create policy pjsdas_blob_reader_lock on public.pjsdas_workspaces for update to pjsdas_workspace_blob_reader using (true) with check (false);

create function pjsdas_rows_internal.read_legacy_workspace(target_user_id uuid)
returns setof public.pjsdas_workspaces language plpgsql stable security definer
set search_path=pg_catalog,pg_temp as $$
declare w public.pjsdas_workspaces; caller_user uuid;
begin
 -- current_setting(role) stays the invoking role inside SECURITY DEFINER.
 -- Explicit service trust, not a browser-controlled claim or target identifier.
 if current_setting('role',true) is distinct from 'service_role' then
  raise exception 'server workspace reader only' using errcode='42501';
 end if;
 caller_user:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
  (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid;
 if caller_user is not null and caller_user is distinct from target_user_id then
  raise exception 'workspace owner mismatch' using errcode='42501';
 end if;
 if target_user_id is null then raise exception 'owner is required' using errcode='22023';end if;
 select * into w from public.pjsdas_workspaces where user_id=target_user_id;
 if not found then return;end if;
 if w.row_candidate_epoch is not null then
  raise exception 'legacy read unavailable for active row generation' using errcode='PT409';
 end if;
 return next w;
end$$;
revoke all on function pjsdas_rows_internal.read_legacy_workspace(uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.read_legacy_workspace(uuid) to service_role;
alter function pjsdas_rows_internal.read_legacy_workspace(uuid) owner to pjsdas_workspace_blob_reader;

create function pjsdas_rows_internal.lock_legacy_workspace(target_user_id uuid)
returns setof public.pjsdas_workspaces language plpgsql volatile security definer
set search_path=pg_catalog,pg_temp as $$
declare w public.pjsdas_workspaces; caller_user uuid;
begin
 if current_setting('role',true) is distinct from 'service_role' then
  raise exception 'server workspace reader only' using errcode='42501';
 end if;
 caller_user:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
  (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid;
 if caller_user is not null and caller_user is distinct from target_user_id then
  raise exception 'workspace owner mismatch' using errcode='42501';
 end if;
 if target_user_id is null then raise exception 'owner is required' using errcode='22023';end if;
 select * into w from public.pjsdas_workspaces where user_id=target_user_id for update;
 if not found then return;end if;
 if w.row_candidate_epoch is not null then
  raise exception 'legacy write unavailable for active row generation' using errcode='PT409';
 end if;
 return next w;
end$$;
revoke all on function pjsdas_rows_internal.lock_legacy_workspace(uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.lock_legacy_workspace(uuid) to service_role;
alter function pjsdas_rows_internal.lock_legacy_workspace(uuid) owner to pjsdas_workspace_blob_reader;

create function public.pjsdas_read_legacy_workspace_v1(target_user_id uuid)
returns setof public.pjsdas_workspaces language sql stable security invoker
set search_path=pg_catalog,pg_temp as $$
 select * from pjsdas_rows_internal.read_legacy_workspace(target_user_id)
$$;
revoke all on function public.pjsdas_read_legacy_workspace_v1(uuid) from public,anon,authenticated;
grant execute on function public.pjsdas_read_legacy_workspace_v1(uuid) to service_role;

-- Merely REVOKE SELECT(snapshot) does not override a table-wide SELECT grant.
revoke select on public.pjsdas_workspaces from service_role;
revoke select(snapshot) on public.pjsdas_workspaces from service_role;
grant select(id,user_id,revision,schema_version,migrated_from,source_fingerprint,created_at,updated_at,materialized_revision,row_candidate_epoch)
on public.pjsdas_workspaces to service_role;
-- Production must independently assert no PUBLIC/role-membership/column grant
-- still makes snapshot readable. Do not silently revoke unrelated inherited ACLs.

revoke create on schema pjsdas_rows_internal from pjsdas_workspace_blob_reader;
revoke pjsdas_workspace_blob_reader from CURRENT_USER granted by CURRENT_USER;

-- Insert the 9 reviewed static INVOKER definitions before COMMIT.
COMMIT;

-- ISOLATED STAGE A ONLY, NOT A PRODUCTION MIGRATION.
-- Exercise real legacy entry points against an explicit row generation. This
-- catalog-derived fixture patch preserves existing ACL/owner/security options;
-- production would require a separately reviewed static exact migration.
alter table public.pjsdas_workspaces add column row_candidate_epoch uuid;
create function pjsdas_rows_internal.assert_snapshot_writer(target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare epoch uuid;
begin
 select w.row_candidate_epoch into epoch from public.pjsdas_workspaces w where w.user_id=target_user_id for update;
 if epoch is not null then raise exception 'legacy snapshot writer lacks row-generation capability' using errcode='PT409';end if;
end$$;
create function pjsdas_rows_internal.assert_row_generation(target_user_id uuid,target_epoch uuid) returns void
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare epoch uuid;
begin
 -- Shared metadata lock precedes candidate head locks. Shadow experiments with
 -- no active marker remain possible; production routing must require a marker.
 select w.row_candidate_epoch into epoch from public.pjsdas_workspaces w where w.user_id=target_user_id for update;
 if epoch is not null and epoch is distinct from target_epoch then raise exception 'row generation changed' using errcode='PT409';end if;
end$$;
create function pjsdas_rows_internal.assert_row_read_generation(target_user_id uuid,target_epoch uuid) returns boolean
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare epoch uuid;
begin
 select w.row_candidate_epoch into epoch from public.pjsdas_workspaces w where w.user_id=target_user_id;
 if epoch is not null and epoch is distinct from target_epoch then raise exception 'row read generation changed' using errcode='PT409';end if;
 return true;
end$$;
create function pjsdas_rows_internal.guard_retained_blob() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pjsdas_rows_candidate as $$
begin
 if old.row_candidate_epoch is not null then
  raise exception 'active row layout cannot be overwritten, drained or cleared by a legacy table write' using errcode='PT409';
 end if;
 if tg_op='DELETE' then return old;end if;
 if new.row_candidate_epoch is not null and not exists(select 1 from pjsdas_rows_candidate.head h where h.id=old.id and h.user_id=old.user_id and h.epoch=new.row_candidate_epoch and h.revision=old.revision and h.schema_version=old.schema_version and h.legacy_snapshot is not distinct from old.snapshot) then
  raise exception 'row activation requires a matching staged generation and revision' using errcode='PT409';
 end if;
 return new;
end$$;
create trigger pjsdas_candidate_retained_blob_guard before update or delete on public.pjsdas_workspaces
 for each row execute function pjsdas_rows_internal.guard_retained_blob();
revoke all on function pjsdas_rows_internal.assert_snapshot_writer(uuid),pjsdas_rows_internal.assert_row_generation(uuid,uuid),pjsdas_rows_internal.assert_row_read_generation(uuid,uuid),pjsdas_rows_internal.guard_retained_blob() from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.assert_snapshot_writer(uuid),pjsdas_rows_internal.assert_row_generation(uuid,uuid),pjsdas_rows_internal.assert_row_read_generation(uuid,uuid) to service_role;

-- Existing wrappers keep their authority -> workspace lock ordering. Fence the
-- shared base writes (including replay), bootstrap and model admission, not a
-- new workspace-first lock in front of a grant-first legacy wrapper.
do $$
declare p record;patched text;definition text;
begin
 for p in select oid,proname,prosrc from pg_proc where pronamespace='public'::regnamespace and proname=any(array['pjsdas_commit_workspace','pjsdas_commit_workspace_v2','pjsdas_commit_workspace_v3','pjsdas_bootstrap_workspace','pjsdas_admit_ai_capture','pjsdas_drain_empty_gmail_runs_v1']) loop
  if p.prosrc !~ E'(?im)^begin[[:space:]]*$' then raise exception 'unexpected legacy function body: %',p.proname;end if;
  patched:=regexp_replace(p.prosrc,E'(?im)^begin[[:space:]]*$',E'begin\n  perform pjsdas_rows_internal.assert_snapshot_writer(target_user_id);');
  definition:=replace(pg_get_functiondef(p.oid),p.prosrc,patched);execute definition;
 end loop;
 -- 305 authority is binding -> lease -> workspace. Insert the marker check only
 -- after its real workspace lock, before replay and metadata mutation.
 select oid,prosrc into p from pg_proc where pronamespace='public'::regnamespace and proname='pjsdas_checkpoint_empty_gmail_poll_v1';
 if strpos(p.prosrc,'  -- The lock wait is part of this transaction; expiry must be tested AFTER it.')=0 then raise exception 'unexpected empty checkpoint boundary';end if;
 patched:=replace(p.prosrc,'  -- The lock wait is part of this transaction; expiry must be tested AFTER it.',E'  perform pjsdas_rows_internal.assert_snapshot_writer(target_user_id);\n  -- The lock wait is part of this transaction; expiry must be tested AFTER it.');
 execute replace(pg_get_functiondef(p.oid),p.prosrc,patched);
end$$;
-- Read-only legacy logical projection cannot return a stale retained blob.
create or replace function public.pjsdas_logical_workspace_snapshot_v1(w public.pjsdas_workspaces)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if w.row_candidate_epoch is not null then raise exception 'legacy logical reader lacks row capability' using errcode='PT409';end if;
 return public.pjsdas_merge_empty_gmail_runs_v1(w.user_id,w.snapshot,w.materialized_revision,w.revision,w.snapshot,true);
end$$;

-- Candidate wrappers acquire the shared metadata lock after their original
-- authority check and before the row head; the base repeats an already-held
-- lock. This protects against epoch replacement without changing grant order.
do $$
declare p record;patched text;needle text;
begin
 for p in select oid,proname,prosrc from pg_proc where pronamespace in ('pjsdas_rows_candidate'::regnamespace,'pjsdas_rows_internal'::regnamespace)
 and proname=any(array['apply_rows','commit_planning','commit_discovery_profile','commit_private_reminder','commit_opportunity','commit_business','commit_management_v2','commit_ai_capture']) loop
  needle:=' select * into h from pjsdas_rows_candidate.head';
  if strpos(p.prosrc,needle)=0 then raise exception 'unexpected row head lock boundary: %',p.proname;end if;
  patched:=replace(p.prosrc,needle,E' perform pjsdas_rows_internal.assert_row_generation((req->>\'userId\')::uuid,(req->>\'expectedEpoch\')::uuid);\n'||needle);
  execute replace(pg_get_functiondef(p.oid),p.prosrc,patched);
 end loop;
 select oid,prosrc into p from pg_proc where pronamespace='pjsdas_rows_candidate'::regnamespace and proname='admit_ai_capture';
 needle:='  select w.* into workspace from pjsdas_rows_candidate.head';
 if strpos(p.prosrc,needle)=0 then raise exception 'unexpected row admission lock';end if;
 patched:=replace(p.prosrc,needle,E'  perform pjsdas_rows_internal.assert_row_generation(target_user_id,target_epoch);\n'||needle);
 execute replace(pg_get_functiondef(p.oid),p.prosrc,patched);
 select oid,prosrc into p from pg_proc where pronamespace='pjsdas_rows_candidate'::regnamespace and proname='commit_discovery';
 needle:='  select h.* into checkpoint_workspace from pjsdas_rows_candidate.head';
 if strpos(p.prosrc,needle)=0 then raise exception 'unexpected Discovery row lock';end if;
 patched:=replace(p.prosrc,needle,E'  perform pjsdas_rows_internal.assert_row_generation(target_user_id,(req->>\'expectedEpoch\')::uuid);\n'||needle);
 execute replace(pg_get_functiondef(p.oid),p.prosrc,patched);
 for p in select oid,proname,prosrc from pg_proc where pronamespace='pjsdas_rows_candidate'::regnamespace and proname=any(array['read_head','read_page']) loop
  if p.proname='read_head' then
   needle:='where user_id=target_user_id';
   patched:=replace(p.prosrc,needle,needle||' and pjsdas_rows_internal.assert_row_read_generation(user_id,epoch)');
  else
   needle:='where id=target_workspace_id and user_id=target_user_id';
   patched:=replace(p.prosrc,needle,needle||' and pjsdas_rows_internal.assert_row_read_generation(user_id,epoch)');
  end if;
  if patched=p.prosrc then raise exception 'unexpected candidate read fence';end if;
  execute replace(pg_get_functiondef(p.oid),p.prosrc,patched);
 end loop;
end$$;

-- Stable history reads bind the same active generation as logical row pages.
do $$
declare p record;patched text;
begin
 select oid,prosrc into p from pg_proc where pronamespace='pjsdas_rows_candidate'::regnamespace and proname='read_history';
 if p.prosrc !~ E'(?im)^begin[[:space:]]*$' then raise exception 'unexpected history reader boundary';end if;
 patched:=regexp_replace(p.prosrc,E'(?im)^begin[[:space:]]*$',E'begin\n perform pjsdas_rows_internal.assert_row_read_generation(target_user_id,target_epoch);');
 execute replace(pg_get_functiondef(p.oid),p.prosrc,patched);
end$$;

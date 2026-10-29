-- LOCAL SYNTHETIC FIXTURE ONLY. Installs transaction-scoped primitives into the
-- EXISTING public-only PostgREST routes. No runtime PG client / BEGIN / COMMIT.
-- Install after resource-reservations + durable-intent + audit-bytes candidates.
-- No row, limit, expiry, enrollment, or production policy is seeded here.
create table ta_resource_reservations.rpc_scope(user_id uuid primary key);
-- Historical logical occupied peaks, updated by the same atomic precharge.
-- These are not process RSS, filesystem, PostgreSQL physical IO or disk peaks.
alter table ta_resource_reservations.pool add column rpc_peak_occupied bigint not null default 0 check(rpc_peak_occupied>=occupied and rpc_peak_occupied<=held);
alter table ta_resource_reservations.owner add column rpc_peak_occupied bigint not null default 0 check(rpc_peak_occupied>=occupied and rpc_peak_occupied<=held);
alter table ta_resource_reservations.reservation add column rpc_peak_occupied bigint not null default 0 check(rpc_peak_occupied>=occupied and rpc_peak_occupied<=reserved);
revoke all on ta_resource_reservations.rpc_scope from public,anon,authenticated,service_role;
grant usage on schema ta_resource_reservations to service_role;
grant select on ta_resource_reservations.rpc_scope,ta_resource_reservations.pool to service_role;
grant select,insert,update on ta_resource_reservations.owner,ta_resource_reservations.reservation,
 ta_resource_reservations.allocation,ta_resource_reservations.chunk to service_role;
grant update on ta_resource_reservations.pool to service_role;
-- Scope/policy are fixture-owner-only. Existing intents/stages cannot silently
-- become zero-cost inventory. Enrollment requires an empty original namespace.
create function ta_resource_reservations.rpc_enroll_guard() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op<>'INSERT' then raise exception 'resource enrollment is immutable' using errcode='42501';end if;
 if exists(select 1 from pjsdas_rows_candidate.large_stage where user_id=new.user_id)
 or exists(select 1 from pjsdas_rows_candidate.large_command_intent where user_id=new.user_id)
 then raise exception 'existing stage/intent inventory requires migration' using errcode='PT409';end if;
 return new;
end$$;
create trigger rpc_enrollment before insert or update or delete on ta_resource_reservations.rpc_scope
 for each row execute function ta_resource_reservations.rpc_enroll_guard();

create function ta_resource_reservations.rpc_enabled(target_user uuid) returns boolean
language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from ta_resource_reservations.rpc_scope where user_id=target_user)
$$;

-- Called BEFORE any head/stage/bundle/FK lock, including original intent reads.
-- Nested original finalizers repeat only locks already held by the same tx.
create function ta_resource_reservations.rpc_lock(identity jsonb,target_user uuid,target_stage uuid default null) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare p ta_resource_reservations.pool%rowtype;r ta_resource_reservations.reservation%rowtype;
begin
 if not ta_resource_reservations.rpc_enabled(target_user) then return false;end if;
 perform pjsdas_rows_internal.authorize_intent(identity,target_user);
 select * into p from ta_resource_reservations.pool where singleton for update;
 if not found or not p.enabled or not p.inventory_verified or p.generation<>'rpc-local-v1' then raise exception 'resource policy/inventory unavailable' using errcode='PT503';end if;
 insert into ta_resource_reservations.owner(user_id) values(target_user::text) on conflict do nothing;
 perform 1 from ta_resource_reservations.owner where user_id=target_user::text for update;
 select * into r from ta_resource_reservations.reservation where user_id=target_user::text and command_id=identity->>'commandId' for update;
 if found and ((target_stage is not null and r.stage_id<>target_stage::text)
  or (r.binding-array['stageId','workspaceId','expectedEpoch','expectedRevision','preparedSha256','manifestSha256']) is distinct from identity)
 then raise exception 'resource original identity mismatch' using errcode='42501';end if;
 return true;
end$$;

create function ta_resource_reservations.rpc_stage(target_stage uuid,target_user uuid) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;fresh pjsdas_rows_candidate.large_command_intent%rowtype;r ta_resource_reservations.reservation%rowtype;
 st pjsdas_rows_candidate.large_stage%rowtype;b pjsdas_rows_candidate.large_document_bundle%rowtype;k text;
begin
 if not ta_resource_reservations.rpc_enabled(target_user) then return false;end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if not found then raise exception 'resource writer requires original durable intent' using errcode='42501';end if;
 perform ta_resource_reservations.rpc_lock(i.identity,target_user,target_stage);
 select * into fresh from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 select * into r from ta_resource_reservations.reservation where stage_id=target_stage::text;
 if not found or fresh is distinct from i or r.binding is distinct from i.binding or r.deadline_at<>i.deadline_at
 then raise exception 'resource immutable admission changed' using errcode='42501';end if;
 if r.phase not in ('open','committed') or r.writer_fence is not null then raise exception 'resource writer fenced' using errcode='PT409';end if;
 -- All original stage writers, including upload, now share head->stage order.
 perform 1 from pjsdas_rows_candidate.head where id=(i.binding->>'workspaceId')::uuid and user_id=target_user for update;
 select * into st from pjsdas_rows_candidate.large_stage where id=target_stage for update;
 if found then
  if st.user_id<>target_user or st.workspace_id<>(i.binding->>'workspaceId')::uuid
   or st.family not in (i.binding->>'family','documents:'||(i.binding->>'family')) or st.authority is distinct from i.binding->'authority'
   then raise exception 'resource stage authority changed' using errcode='42501';end if;
  foreach k in array array['userId','workspaceId','expectedEpoch','expectedRevision','commandId','payloadHash','operation','principal'] loop
   if st.request->k is distinct from i.binding->k then raise exception 'resource stage binding changed' using errcode='42501';end if;
  end loop;
 end if;
 select * into b from pjsdas_rows_candidate.large_document_bundle where stage_id=target_stage for update;
 if found and (b.manifest->'binding' is distinct from i.binding-array['preparedSha256','manifestSha256'] or b.manifest_sha256 is distinct from i.binding->>'manifestSha256')
 then raise exception 'resource manifest identity changed' using errcode='42501';end if;
 return true;
end$$;

-- Original admission has already locked/validated authority + head and prior
-- reservation. This is NOT an external transaction wrapper or another commit.
create function ta_resource_reservations.rpc_admit(identity jsonb,binding jsonb,encoded jsonb,deadline_at bigint,target_user uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare p ta_resource_reservations.pool%rowtype;o ta_resource_reservations.owner%rowtype;r pjsdas_rows_candidate.large_document_reservation%rowtype;
 old ta_resource_reservations.reservation%rowtype;expiry bigint;
begin
 if not ta_resource_reservations.rpc_enabled(target_user) then return;end if;
 select * into p from ta_resource_reservations.pool where singleton;
 select * into o from ta_resource_reservations.owner where user_id=target_user::text;
 select * into r from pjsdas_rows_candidate.large_document_reservation where stage_id=(binding->>'stageId')::uuid;
 expiry:=floor(extract(epoch from r.expires_at)*1000)::bigint;
 if r.user_id is distinct from target_user or r.workspace_id is distinct from (binding->>'workspaceId')::uuid
 or r.reserved_bytes is null or r.reserved_bytes<(encoded->>'bytes')::bigint or expiry<=extract(epoch from clock_timestamp())*1000
 or deadline_at<=extract(epoch from clock_timestamp())*1000 then raise exception 'resource original reservation expired/absent' using errcode='PT503';end if;
 select * into old from ta_resource_reservations.reservation where stage_id=rpc_admit.binding->>'stageId';
 if found then
  if old.binding is distinct from binding or old.reserved<>r.reserved_bytes or old.deadline_at<>deadline_at or old.expires_at<>expiry then raise exception 'resource admission reused' using errcode='23505';end if;
  return;
 end if;
 if r.reserved_bytes>p.command_limit or r.reserved_bytes>p.owner_limit-o.held or r.reserved_bytes>p.global_limit-p.held then raise exception 'resource capacity unavailable' using errcode='PT503';end if;
 insert into ta_resource_reservations.reservation(stage_id,user_id,command_id,binding,reserved,expires_at,deadline_at)
 values(binding->>'stageId',target_user::text,identity->>'commandId',binding,r.reserved_bytes,expiry,deadline_at);
 update ta_resource_reservations.pool set held=held+r.reserved_bytes,revision=revision+1 where singleton;
 update ta_resource_reservations.owner set held=held+r.reserved_bytes where user_id=target_user::text;
end$$;

-- Precharge and materialization share one SQL transaction. An exception or
-- backend death rolls BOTH back; a lost HTTP ACK leaves BOTH committed.
-- bytes are logical durable representation sizes, NOT heap/TOAST/WAL/memory.
create function ta_resource_reservations.rpc_charge(target_stage uuid,p_allocation text,p_kind text,p_offset bigint,data bytea) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare r ta_resource_reservations.reservation%rowtype;a ta_resource_reservations.allocation%rowtype;c ta_resource_reservations.chunk%rowtype;
 n bigint:=octet_length(data);digest text:=encode(sha256(data),'hex');
begin
 select * into r from ta_resource_reservations.reservation where stage_id=target_stage::text;
 if not found then return;end if;
 if n is null or n<1 or p_offset<0 then raise exception 'invalid resource bytes' using errcode='22023';end if;
 select * into a from ta_resource_reservations.allocation where stage_id=target_stage::text and allocation_id=p_allocation;
 if found and (a.kind<>p_kind or a.removed) then raise exception 'resource allocation unavailable' using errcode='PT409';end if;
 select * into c from ta_resource_reservations.chunk where stage_id=target_stage::text and allocation_id=p_allocation and chunk.byte_offset=p_offset;
 if found then
  if c.bytes<>n or c.sha256<>digest or c.status<>'present' then raise exception 'resource repeated bytes changed' using errcode='23505';end if;
  return;
 end if;
 select * into a from ta_resource_reservations.allocation where stage_id=target_stage::text and allocation_id=p_allocation;
 if (found and (a.kind<>p_kind or a.removed)) or p_offset<>coalesce(a.next_offset,0) then raise exception 'resource allocation gap/identity' using errcode='22023';end if;
 if r.phase<>'open' or r.writer_fence is not null or least(r.deadline_at,r.expires_at)<=extract(epoch from clock_timestamp())*1000
 then raise exception 'resource original writer deadline/fence' using errcode='PT503';end if;
 if n>r.reserved-r.occupied then raise exception 'resource cumulative representations exceed original reservation' using errcode='PT503';end if;
 insert into ta_resource_reservations.allocation(stage_id,allocation_id,kind) values(target_stage::text,p_allocation,p_kind) on conflict do nothing;
 insert into ta_resource_reservations.chunk values(target_stage::text,p_allocation,p_offset,n,digest,'present');
 update ta_resource_reservations.allocation set next_offset=next_offset+n,occupied=occupied+n,present=present+n where stage_id=target_stage::text and allocation_id=p_allocation;
 update ta_resource_reservations.reservation set occupied=occupied+n,present=present+n,rpc_peak_occupied=greatest(rpc_peak_occupied,occupied+n),revision=revision+1 where stage_id=target_stage::text;
 update ta_resource_reservations.owner set occupied=occupied+n,present=present+n,rpc_peak_occupied=greatest(rpc_peak_occupied,occupied+n) where user_id=r.user_id;
 update ta_resource_reservations.pool set occupied=occupied+n,present=present+n,rpc_peak_occupied=greatest(rpc_peak_occupied,occupied+n),revision=revision+1 where singleton;
end$$;

-- The initial small stage binding is replaced, not retained as a separate
-- logical representation. Confirm the exact new stored request in THIS tx
-- before retiring only its old logical charge. No stage/audit bytes are deleted.
create function ta_resource_reservations.rpc_request_replaced(target_stage uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare a ta_resource_reservations.allocation%rowtype;r ta_resource_reservations.reservation%rowtype;c ta_resource_reservations.chunk%rowtype;raw bytea;
begin
 select * into r from ta_resource_reservations.reservation where stage_id=target_stage::text;
 if not found then return;end if;
 select * into a from ta_resource_reservations.allocation where stage_id=target_stage::text and allocation_id='stage-binding';
 if not found or a.removed then return;end if;
 select convert_to(request::text,'UTF8') into raw from pjsdas_rows_candidate.large_stage where id=target_stage;
 select * into c from ta_resource_reservations.chunk where stage_id=target_stage::text and allocation_id='reconstructed-request' and byte_offset=0;
 if not found or c.status<>'present' or c.bytes<>octet_length(raw) or c.sha256<>encode(sha256(raw),'hex') then raise exception 'resource replacement unconfirmed' using errcode='42501';end if;
 update ta_resource_reservations.allocation set removed=true,occupied=0,present=0 where stage_id=target_stage::text and allocation_id='stage-binding';
 update ta_resource_reservations.reservation set occupied=occupied-a.occupied,present=present-a.present,revision=revision+1 where stage_id=target_stage::text;
 update ta_resource_reservations.owner set occupied=occupied-a.occupied,present=present-a.present where user_id=r.user_id;
 update ta_resource_reservations.pool set occupied=occupied-a.occupied,present=present-a.present,revision=revision+1 where singleton;
end$$;

-- No destructive resolution/reclaim: commit is only the original ledger's
-- authoritative receipt + exact revision. Absent/uncertain stays fully held.
create function ta_resource_reservations.rpc_resolve(target_stage uuid,target_user uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare r ta_resource_reservations.reservation%rowtype;original jsonb;observed_outcome jsonb;comp jsonb;
begin
 select * into r from ta_resource_reservations.reservation where stage_id=target_stage::text and user_id=target_user::text;
 if not found or r.phase not in ('open','stopped','finalizing','unknown','committed') or r.writer_fence is not null then return;end if;
 original:=pjsdas_rows_internal.original_command((r.binding->>'workspaceId')::uuid,target_user,r.command_id);
 if original is null then return;end if;
 select compensation into comp from pjsdas_rows_candidate.ledger where user_id=target_user and command_id=r.command_id;
 if not found or original->>'payloadHash' is distinct from r.binding->>'payloadHash'
 or original#>>'{receipt,status}' is distinct from 'COMMITTED' or original#>>'{receipt,contractVersion}' is distinct from '5'
 or not(original->'receipt' ? 'projectionDelta') then raise exception 'resource original complete audit absent' using errcode='42501';end if;
 -- Hash reference, never a replacement or a deletable copy of the sole audit.
 observed_outcome:=jsonb_build_object('kind','committed','revision',original->'revision','receiptSha256',encode(sha256(convert_to((original->'receipt')::text,'UTF8')),'hex'),
  'compensationSha256',encode(sha256(convert_to(coalesce(comp,'null'::jsonb)::text,'UTF8')),'hex'));
 if r.phase='committed' then
  if r.outcome is distinct from observed_outcome then raise exception 'resource original outcome changed' using errcode='42501';end if;
  return;
 end if;
 update ta_resource_reservations.reservation set phase='committed',outcome=observed_outcome,revision=revision+1 where stage_id=r.stage_id;
 update ta_resource_reservations.pool set revision=revision+1 where singleton;
end$$;

-- History command lookup is the ORIGINAL unknown-result resolution route.
-- Only exactly matching authorization families participate. A different grant
-- does not acquire a second grant while holding the first; it remains a normal
-- authorized history read and leaves resource capacity pinned.
create function ta_resource_reservations.rpc_history_lock(target_user uuid,query jsonb) returns uuid
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;proof jsonb:=query->'auditAuthorization';r ta_resource_reservations.reservation%rowtype;
begin
 if not ta_resource_reservations.rpc_enabled(target_user) or query->>'mode' is distinct from 'command' or query->>'auditProtocol' is distinct from 'workspace-audit-bytes-v1' then return null;end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where user_id=target_user and command_id=query->>'commandId';
 if not found then return null;end if;
 if not exists(select 1 from pjsdas_rows_candidate.large_stage where id=i.stage_id and result is not null) then return null;end if;
 if i.identity->>'principal' is distinct from proof->>'principal' then return null;end if;
 if proof->>'principal'='delegated_mcp' and i.identity->'authority' is distinct from jsonb_build_object('grantId',proof->'grantId','grantRevision',proof->'grantRevision','clientId',proof->'clientId') then return null;end if;
 -- Observation never invokes the writable/inventory gate. Frozen recovery,
 -- stopped/unknown records cannot block the original authorized ledger reader.
 perform 1 from ta_resource_reservations.pool where singleton for update;
 if not found then return null;end if;
 perform 1 from ta_resource_reservations.owner where user_id=target_user::text for update;
 select * into r from ta_resource_reservations.reservation where stage_id=i.stage_id::text and user_id=target_user::text for update;
 if not found or r.binding is distinct from i.binding or r.deadline_at<>i.deadline_at or r.writer_fence is not null
 or r.phase not in ('open','stopped','finalizing','unknown','committed') then return null;end if;
 -- Head lock drains an in-flight original finalizer before ledger observation.
 perform 1 from pjsdas_rows_candidate.head where id=(i.binding->>'workspaceId')::uuid and user_id=target_user for share;
 begin
  perform ta_resource_reservations.rpc_resolve(i.stage_id,target_user);
 exception when sqlstate '42501' then
  -- An inconsistent sidecar is not authority to hide an original audit. Keep
  -- all bytes/capacity pinned; the normal history checks still run unchanged.
  return null;
 end;
 return i.stage_id;
end$$;

-- Reject alternate incoming authority BEFORE a nested original guard could
-- acquire another grant while global is held. Original guards still run.
create function ta_resource_reservations.rpc_input(target_stage uuid,target_user uuid,req jsonb,authority jsonb default null,manifest_sha text default null) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;k text;
begin
 if not ta_resource_reservations.rpc_enabled(target_user) then return;end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if not found then raise exception 'resource input requires original intent' using errcode='42501';end if;
 foreach k in array array['userId','workspaceId','expectedEpoch','expectedRevision','commandId','payloadHash','operation','principal'] loop
  if req->k is distinct from i.binding->k then raise exception 'resource input binding mismatch' using errcode='42501';end if;
 end loop;
 if authority is not null and authority is distinct from i.binding->'authority' then raise exception 'resource input authority mismatch' using errcode='42501';end if;
 if manifest_sha is not null and (manifest_sha is distinct from i.binding->>'manifestSha256'
  or req is distinct from i.binding-array['preparedSha256','manifestSha256']) then raise exception 'resource input manifest mismatch' using errcode='42501';end if;
end$$;

-- Catalog patching is exclusively a disposable-fixture integration mechanism.
-- Preserve every original guard and ACL; fail if each exact insertion boundary
-- is absent/nonunique. No runtime options, DTOs, timeout or API names change.
create function ta_resource_reservations.rpc_patch(signature text,needle text,insertion text) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare p record;
begin
 select oid,prosrc into strict p from pg_proc where oid=to_regprocedure(signature);
 if (length(p.prosrc)-length(replace(p.prosrc,needle,'')))/length(needle)<>1 then raise exception 'resource patch boundary mismatch: %',signature;end if;
 execute replace(pg_get_functiondef(p.oid),p.prosrc,replace(p.prosrc,needle,insertion));
end$$;
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_intent_read(jsonb,uuid)',
 ' perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);',
 E' perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);\n perform ta_resource_reservations.rpc_lock(identity,target_user_id);');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid)',
 ' perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);',
 E' perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);\n perform ta_resource_reservations.rpc_lock(identity,target_user_id,(binding->>\'stageId\')::uuid);');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid)',
 ' insert into pjsdas_rows_candidate.large_command_intent values',
 E' perform ta_resource_reservations.rpc_admit(identity,binding,encoded,deadline_at,target_user_id);\n perform ta_resource_reservations.rpc_charge((binding->>\'stageId\')::uuid,\'intent-record\',\'intent-encoded\',0,convert_to(jsonb_build_object(\'identity\',identity,\'binding\',binding,\'encoded\',encoded)::text,\'UTF8\'));\n insert into pjsdas_rows_candidate.large_command_intent values');
-- Every stage-touching entry, including direct candidate calls and legacy
-- begin/finish wrappers, joins grant->global->owner->reservation BEFORE locks.
do $$declare sig text;expr text;begin
 for sig,expr in select * from(values
 ('pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text)','stage_id,(req->>''userId'')::uuid'),
 ('pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text)','stage_id,(req->>''userId'')::uuid'),
 ('pjsdas_rows_candidate.large_append(uuid,uuid,jsonb)','stage_id,target_user_id'),
 ('pjsdas_rows_candidate.large_finish(uuid,uuid)','stage_id,target_user_id'),
 ('pjsdas_rows_candidate.large_finish_opportunity(uuid,uuid)','stage_id,target_user_id'),
 ('pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text)','target_stage,(req->>''userId'')::uuid'),
 ('pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb)','target_stage,(req->>''userId'')::uuid'),
 ('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)','(manifest_wire::jsonb#>>''{binding,stageId}'')::uuid,target_user_id'),
 ('pjsdas_rows_candidate.large_documents_append(jsonb,uuid)','(part->>''stageId'')::uuid,target_user_id'),
 ('pjsdas_rows_candidate.large_documents_finish(uuid,uuid,text)','stage_id,target_user_id')
 ) x(s,e) loop
  perform ta_resource_reservations.rpc_patch(sig,E'\nbegin\n',E'\nbegin\n perform ta_resource_reservations.rpc_stage('||expr||E');\n');
 end loop;
end$$;
-- Scope excludes legacy effect-only begin APIs: the real app uses the durable
-- document entry, so no unbound stage may be attached to its reservation.
do $$declare sig text;begin
 foreach sig in array array['pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text)','pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text)'] loop
  perform ta_resource_reservations.rpc_patch(sig,E'\nbegin\n',E'\nbegin\n if ta_resource_reservations.rpc_enabled((req->>\'userId\')::uuid) then raise exception \'resource scope requires original document begin\' using errcode=\'42501\';end if;\n');
 end loop;
end$$;
select ta_resource_reservations.rpc_patch('pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text)',
 E'\nbegin\n',E'\nbegin\n perform ta_resource_reservations.rpc_input(target_stage,(req->>\'userId\')::uuid,req,jsonb_build_object(\'grantId\',target_grant_id,\'grantRevision\',target_grant_revision,\'clientId\',target_client_id));\n');
select ta_resource_reservations.rpc_patch('pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb)',
 E'\nbegin\n',E'\nbegin\n perform ta_resource_reservations.rpc_input(target_stage,(req->>\'userId\')::uuid,req);\n');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)',
 E'\nbegin\n',E'\nbegin\n perform ta_resource_reservations.rpc_input((manifest_wire::jsonb#>>\'{binding,stageId}\')::uuid,target_user_id,manifest_wire::jsonb->\'binding\',manifest_wire::jsonb#>\'{binding,authority}\',manifest_sha256);\n');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)',
 ' insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at,family,authority)',
 E' if not exists(select 1 from pjsdas_rows_candidate.large_stage where id=document_stage_id) then perform ta_resource_reservations.rpc_charge(document_stage_id,\'stage-binding\',\'intent-decoded\',0,convert_to(req::text,\'UTF8\'));end if;\n insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at,family,authority)');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)',
 ' insert into pjsdas_rows_candidate.large_document_bundle(stage_id,manifest_wire,manifest_sha256,manifest)',
 E' perform ta_resource_reservations.rpc_charge(document_stage_id,\'manifest-wire\',\'document-fragments\',0,convert_to(manifest_wire,\'UTF8\'));\n perform ta_resource_reservations.rpc_charge(document_stage_id,\'manifest-jsonb\',\'document-fragments\',0,convert_to(m::text,\'UTF8\'));\n insert into pjsdas_rows_candidate.large_document_bundle(stage_id,manifest_wire,manifest_sha256,manifest)');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_documents_append(jsonb,uuid)',
 '  insert into pjsdas_rows_candidate.large_document_fragment values(document_stage_id,name,off,raw);',
 E'  perform ta_resource_reservations.rpc_charge(document_stage_id,\'document:\'||name,\'document-fragments\',off,raw);\n  insert into pjsdas_rows_candidate.large_document_fragment values(document_stage_id,name,off,raw);');
-- One charge per wire/effect page, not a global counter rewrite per effect.
create function ta_resource_reservations.rpc_effect_page(target_stage uuid,parts jsonb,first_ordinal integer) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare part jsonb;wire bytea:=''::bytea;parsed bytea:=''::bytea;
begin
 if not exists(select 1 from ta_resource_reservations.reservation where stage_id=target_stage::text) then return;end if;
 for part in select value from jsonb_array_elements(parts) where (value->>'ordinal')::integer>=first_ordinal loop
  wire:=wire||convert_to(part->>'wire','UTF8');parsed:=parsed||convert_to((part->>'wire')::jsonb::text,'UTF8');
 end loop;
 if octet_length(wire)>0 then
  perform ta_resource_reservations.rpc_charge(target_stage,'effect-wire:'||first_ordinal,'effect-wire',0,wire);
  perform ta_resource_reservations.rpc_charge(target_stage,'effect-jsonb:'||first_ordinal,'effect-jsonb',0,parsed);
 end if;
end$$;
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_append(uuid,uuid,jsonb)',
 ' for p in select value from jsonb_array_elements(parts) loop',
 E' perform ta_resource_reservations.rpc_effect_page(stage_id,parts,s.next_ordinal);\n for p in select value from jsonb_array_elements(parts) loop');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_documents_finish(uuid,uuid,text)',
 '  update pjsdas_rows_candidate.large_stage set request=req,family=document_family where id=stage_id;',
 E'  perform ta_resource_reservations.rpc_charge(stage_id,\'reconstructed-request\',\'intent-decoded\',0,convert_to(req::text,\'UTF8\'));\n  update pjsdas_rows_candidate.large_stage set request=req,family=document_family where id=stage_id;\n  perform ta_resource_reservations.rpc_request_replaced(stage_id);');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_finish(uuid,uuid)',
 ' if r->>''outcome'' in (''COMMITTED'',''ALREADY_APPLIED'') then update pjsdas_rows_candidate.large_stage set result=r where id=s.id;end if;',
 E' if r->>\'outcome\' in (\'COMMITTED\',\'ALREADY_APPLIED\') then perform ta_resource_reservations.rpc_charge(stage_id,\'stage-result\',\'intent-decoded\',0,convert_to(r::text,\'UTF8\'));update pjsdas_rows_candidate.large_stage set result=r where id=s.id;end if;');
select ta_resource_reservations.rpc_patch('pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text)',
 ' if staged_result->>''outcome'' in (''COMMITTED'',''ALREADY_APPLIED'') then update pjsdas_rows_candidate.large_stage set result=staged_result where id=s.id;end if;',
 E' if staged_result->>\'outcome\' in (\'COMMITTED\',\'ALREADY_APPLIED\') then perform ta_resource_reservations.rpc_charge(target_stage,\'stage-result\',\'intent-decoded\',0,convert_to(staged_result::text,\'UTF8\'));update pjsdas_rows_candidate.large_stage set result=staged_result where id=s.id;end if;');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.large_finish(uuid,uuid)',
 ' return r;',E' perform ta_resource_reservations.rpc_resolve(stage_id,target_user_id);\n return r;');
select ta_resource_reservations.rpc_patch('pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text)',
 ' return staged_result;',E' perform ta_resource_reservations.rpc_resolve(target_stage,target_user_id);\n return staged_result;');
select ta_resource_reservations.rpc_patch('pjsdas_rows_candidate.read_history(uuid,uuid,bigint,jsonb)',
 ' select * into h from pjsdas_rows_candidate.head where user_id=target_user_id;',
 E' perform ta_resource_reservations.rpc_history_lock(target_user_id,query);\n select * into h from pjsdas_rows_candidate.head where user_id=target_user_id;');
-- Existing public routes are unchanged. Helpers are private, INVOKER, and only
-- executable by the existing service role; policy/enrollment remain owner-only.
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='ta_resource_reservations'::regnamespace loop
  execute 'revoke all on function '||p.signature||' from public,anon,authenticated';
  if p.signature::text not like '%rpc_patch(%' and p.signature::text not like '%rpc_enroll_guard(%' then execute 'grant execute on function '||p.signature||' to service_role';end if;
 end loop;
end$$;
drop function ta_resource_reservations.rpc_patch(text,text,text);

-- LOCAL SYNTHETIC / DEFAULT OFF. Install after durable-attempts-v2.
-- Logical admission capacity only: DELETE/NULL does NOT shrink disk/TOAST/WAL.
-- No background executor, TTL, new RPC, runtime direct-PG adapter or production ACL.
alter table ta_resource_reservations.pool add column reclamation_enabled boolean not null default false;
alter table ta_resource_reservations.reservation add column current_held bigint;
alter table ta_resource_reservations.reservation add column released_bytes bigint not null default 0;
alter table ta_resource_reservations.reservation add column retained_control_bytes bigint not null default 0;
update ta_resource_reservations.reservation set current_held=case when phase='released' then 0 else reserved end,
 released_bytes=case when phase='released' then reserved else 0 end;
alter table ta_resource_reservations.reservation alter column current_held set not null;
-- Replace only the exact affected CHECKs; preserve unrelated baseline checks.
do $$declare c record;begin
 for c in select conrelid::regclass rel,conname from pg_constraint where contype='c' and
 ((conrelid='ta_resource_reservations.reservation'::regclass and (pg_get_constraintdef(oid) like '%phase%' or pg_get_constraintdef(oid) like '%occupied%reserved%'))
 or (conrelid in ('ta_resource_reservations.pool'::regclass,'ta_resource_reservations.owner'::regclass) and pg_get_constraintdef(oid) like '%rpc_peak_occupied%')
 or (conrelid='ta_resource_reservations.allocation'::regclass and pg_get_constraintdef(oid) like '%kind%')) loop
 execute format('alter table %s drop constraint %I',c.rel,c.conname);end loop;
end$$;
alter table ta_resource_reservations.pool add check(rpc_peak_occupied>=occupied and rpc_peak_occupied<=9007199254740991);
alter table ta_resource_reservations.owner add check(rpc_peak_occupied>=occupied and rpc_peak_occupied<=9007199254740991);
alter table ta_resource_reservations.reservation add check(phase in ('open','stopped','finalizing','unknown','committed','not-committed','reclaiming','reclaimed','released')),
 add check(0<=present and present<=occupied and occupied<=current_held and current_held<=reserved
 and released_bytes>=0 and current_held+released_bytes=reserved and retained_control_bytes between 0 and present),
 add check(phase<>'released' or (current_held=0 and occupied=0 and present=0 and retained_control_bytes=0)),
 add check(phase<>'reclaimed' or (retained_control_bytes>0 and current_held=retained_control_bytes and occupied=current_held and present=current_held)),
 add check((phase in ('reclaiming','reclaimed','released'))=(reclaim_id is not null and writer_fence is not null and writer_fence_revision is not null and reclaim_inventory_revision is not null)),
 add check((phase in ('committed','not-committed','reclaiming','reclaimed','released'))=(outcome is not null)),
 add check(phase not in ('finalizing','unknown') or finalize_attempt is not null),
 add check(phase in ('reclaimed','released') or (released_bytes=0 and current_held=reserved)),
 add check(phase in ('reclaiming','reclaimed') or retained_control_bytes=0);
alter table ta_resource_reservations.allocation add check(kind in ('intent-encoded','intent-decoded','document-fragments','effect-wire','effect-jsonb','audit-spool','storage-overhead','retained-control'));
create function ta_resource_reservations.rpc_held_init() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' then new.current_held:=new.reserved;new.released_bytes:=0;new.retained_control_bytes:=0;
 elsif (new.stage_id,new.user_id,new.command_id,new.binding,new.reserved,new.expires_at,new.deadline_at,new.intent_protocol)
 is distinct from (old.stage_id,old.user_id,old.command_id,old.binding,old.reserved,old.expires_at,old.deadline_at,old.intent_protocol)
 then raise exception 'original resource authorization immutable' using errcode='42501';
 elsif new.released_bytes<old.released_bytes or new.rpc_peak_occupied<old.rpc_peak_occupied
 then raise exception 'resource release/peak cannot regress' using errcode='42501';
 elsif old.writer_fence is not null and (new.writer_fence,new.reclaim_id,new.writer_fence_revision,new.reclaim_inventory_revision,new.outcome) is distinct from (old.writer_fence,old.reclaim_id,old.writer_fence_revision,old.reclaim_inventory_revision,old.outcome)
 then raise exception 'permanent resource fence immutable' using errcode='42501';
 elsif old.outcome is not null and new.outcome is distinct from old.outcome
 then raise exception 'original resource outcome immutable' using errcode='42501';
 elsif old.phase in ('reclaimed','released') and new is distinct from old
 then raise exception 'retired resource immutable' using errcode='42501';end if;
 return new;
end$$;
create trigger rpc_held_init before insert or update on ta_resource_reservations.reservation for each row execute function ta_resource_reservations.rpc_held_init();
alter table pjsdas_rows_candidate.large_command_intent alter column encoded drop not null;
alter table pjsdas_rows_candidate.large_command_intent add column retirement jsonb;
alter table pjsdas_rows_candidate.large_command_intent add check((encoded is null)=(retirement is not null));
alter table pjsdas_rows_candidate.large_stage alter column request drop not null;
grant update(encoded,retirement) on pjsdas_rows_candidate.large_command_intent to service_role;
-- Observation only: unmapped standalone-adapter bytes must block release.
grant select on ta_resource_reservations.temporary_bytes to service_role;

-- Permanent one-way payload identity anchors, independent of resource enrollment.
create function pjsdas_rows_internal.retirement_identity_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or old.retirement is not null or
 (to_jsonb(new)-array['encoded','retirement']) is distinct from (to_jsonb(old)-array['encoded','retirement'])
 or new.encoded is not null or new.retirement is null
 then raise exception 'intent identity/retirement immutable' using errcode='42501';end if;
 return new;
end$$;
create trigger retirement_identity_guard before update or delete on pjsdas_rows_candidate.large_command_intent for each row execute function pjsdas_rows_internal.retirement_identity_guard();
-- Additional sequential DML invariants, NOT a concurrency/ACL boundary for
-- arbitrary privileged service-role DML. Only participating original RPC writers
-- hold the canonical locks; production least-privilege installation remains a gate.
create function pjsdas_rows_internal.retirement_payload_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare sid uuid;i pjsdas_rows_candidate.large_command_intent%rowtype;
begin
 if tg_op in ('UPDATE','DELETE') then
  sid:=case when tg_table_name='large_stage' then (to_jsonb(old)->>'id')::uuid else (to_jsonb(old)->>'stage_id')::uuid end;
  if exists(select 1 from pjsdas_rows_candidate.large_command_intent where stage_id=sid and retirement is not null) then
   if tg_op='DELETE' or tg_table_name<>'large_stage' or (to_jsonb(new)->>'id')::uuid is distinct from sid
   then raise exception 'retired old payload identity fenced' using errcode='PT409';end if;
  end if;
  if tg_op='DELETE' then return old;end if;
 end if;
 sid:=case when tg_table_name='large_stage' then (to_jsonb(new)->>'id')::uuid else (to_jsonb(new)->>'stage_id')::uuid end;
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=sid;
 if i.retirement is not null then
  if tg_table_name<>'large_stage' then raise exception 'retired payload writer fenced' using errcode='PT409';end if;
  if tg_op='INSERT' or new.request is not null or new.result is not null
   or (to_jsonb(new)-array['request','result']) is distinct from (to_jsonb(old)-array['request','result'])
  then raise exception 'retired payload writer fenced' using errcode='PT409';end if;
 elsif tg_table_name='large_stage' then
  if new.request is null then raise exception 'live stage request required' using errcode='42501';end if;
 end if;
 return new;
end$$;
create trigger retirement_payload_guard before insert or update or delete on pjsdas_rows_candidate.large_stage for each row execute function pjsdas_rows_internal.retirement_payload_guard();
create trigger retirement_payload_guard before insert or update on pjsdas_rows_candidate.large_document_bundle for each row execute function pjsdas_rows_internal.retirement_payload_guard();
create trigger retirement_payload_guard before insert or update on pjsdas_rows_candidate.large_document_fragment for each row execute function pjsdas_rows_internal.retirement_payload_guard();
create trigger retirement_payload_guard before insert or update on pjsdas_rows_candidate.large_effect for each row execute function pjsdas_rows_internal.retirement_payload_guard();

create function pjsdas_rows_internal.retirement_attempt_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if tg_op in ('UPDATE','DELETE') then
  if old.terminal_reason is not null and (tg_op='DELETE' or new is distinct from old) then raise exception 'original terminal attempt immutable' using errcode='PT409';end if;
  if exists(select 1 from pjsdas_rows_candidate.large_command_intent where stage_id=old.stage_id and retirement is not null) then raise exception 'retired original attempt immutable' using errcode='PT409';end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 if exists(select 1 from pjsdas_rows_candidate.large_command_intent where stage_id=new.stage_id and retirement is not null) then raise exception 'retired original attempt writer fenced' using errcode='PT409';end if;
 return new;
end$$;
create trigger retirement_attempt_guard before insert or update or delete on pjsdas_rows_candidate.large_command_attempt for each row execute function pjsdas_rows_internal.retirement_attempt_guard();

-- Observer locks retain original grant -> pool -> owner -> command -> head.
-- Frozen allocation policy must not hide an already-authorized original receipt.
create function pjsdas_rows_internal.retirement_lock(identity jsonb,target_user uuid) returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pjsdas_rows_internal.authorize_intent(identity,target_user);
 if ta_resource_reservations.rpc_enabled(target_user) then
  perform 1 from ta_resource_reservations.pool where singleton for update;
  perform 1 from ta_resource_reservations.owner where user_id=target_user::text for update;
  perform 1 from ta_resource_reservations.reservation where user_id=target_user::text and command_id=identity->>'commandId' for update;
 end if;
 perform 1 from pjsdas_rows_candidate.head where user_id=target_user for update;
end$$;

-- Original receipt + original Undo lineage. No receipt is reconstructed from
-- upload bytes; canonical original_command still rejects ambiguous ledgers.
create function pjsdas_rows_internal.retired_original(target_stage uuid,target_user uuid,strict_audit boolean default false) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;l pjsdas_rows_candidate.ledger%rowtype;
 original jsonb;target jsonb;prior_evidence jsonb;old_evidence jsonb;old_operation text;old_status text;row_operation text;row_status text;row_found boolean;old_found boolean;has_candidate boolean;undo_of text;
begin
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if not found then return null;end if;
 perform pjsdas_rows_internal.retirement_lock(i.identity,target_user);
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 original:=pjsdas_rows_internal.original_command((i.binding->>'workspaceId')::uuid,target_user,i.command_id);
 if original is null then
  if i.retirement->>'kind'='COMMITTED' then raise exception 'retired original receipt missing' using errcode='42501';end if;
  return null;
 end if;
 if original->>'payloadHash' is distinct from i.identity->>'payloadHash' or original#>>'{receipt,operation}' is distinct from i.identity->>'operation' then raise exception 'original receipt mismatch' using errcode='23505';end if;
 select * into l from pjsdas_rows_candidate.ledger where user_id=target_user and command_id=i.command_id;has_candidate:=found;
 if (strict_audit or i.retirement is not null) and (not has_candidate or l.payload_hash is distinct from i.identity->>'payloadHash' or l.expected_revision is distinct from (i.binding->>'expectedRevision')::bigint
 or l.principal_kind is distinct from i.identity->>'principal' or l.client_id is distinct from i.identity#>>'{authority,clientId}'
 or original->>'payloadHash' is distinct from i.identity->>'payloadHash' or original#>>'{receipt,operation}' is distinct from i.identity->>'operation'
 or original#>>'{receipt,status}' is distinct from 'COMMITTED' or original#>>'{receipt,contractVersion}' is distinct from '5'
 or not(original->'receipt' ? 'projectionDelta')) then raise exception 'original retained audit identity mismatch' using errcode='42501';end if;
 if has_candidate then undo_of:=l.provenance->>'undoOf';else select provenance->>'undoOf' into undo_of from public.pjsdas_command_ledger where user_id=target_user and command_id=i.command_id;end if;
 if i.retirement is not null and i.retirement->>'undoOf' is distinct from undo_of then raise exception 'retired undo lineage changed' using errcode='42501';end if;
 if i.identity->>'operation'='undo_command' then
  if i.identity->>'family'='first_party_abandon' then
   target:=pjsdas_rows_internal.original_command((i.binding->>'workspaceId')::uuid,target_user,undo_of);
   if target is null or coalesce(target#>>'{receipt,operation}','') not in ('abandon_opportunity','domain:abandon_opportunity') then raise exception 'wrong undo authority' using errcode='42501';end if;
  else
   select compensation,receipt->>'operation',receipt->>'status' into prior_evidence,row_operation,row_status from pjsdas_rows_candidate.ledger where user_id=target_user and command_id=undo_of;row_found:=found;
   select compensation,operation,status into old_evidence,old_operation,old_status from public.pjsdas_command_ledger where user_id=target_user and command_id=undo_of;old_found:=found;
   if not(row_found or old_found) or (row_found and (row_operation is distinct from 'opportunity_management' or row_status is distinct from 'COMMITTED'))
    or (old_found and (old_operation is distinct from 'opportunity_management' or old_status is distinct from 'COMMITTED'))
    or (row_found and old_found and prior_evidence is distinct from old_evidence)
   then raise exception 'opportunity undo target absent or ambiguous' using errcode='42501';end if;
  end if;
 end if;
 return original;
end$$;

-- Exact actual-table inventory; allocation page boundaries only partition the
-- original effects. Missing/extra pages, rows, byte ranges and hashes fail below.
create function ta_resource_reservations.rpc_original_inventory(target_stage uuid)
returns table(allocation_id text,byte_offset bigint,data bytea) language sql stable security invoker set search_path=pg_catalog as $$
 with pages as (select substring(a.allocation_id from 13)::integer lo,
 lead(substring(a.allocation_id from 13)::integer) over(order by substring(a.allocation_id from 13)::integer) hi
 from ta_resource_reservations.allocation a where a.stage_id=target_stage::text and a.allocation_id ~ '^effect-wire:[0-9]+$' and not a.removed),
 effect_pages as(select p.lo,string_agg(e.wire,'' order by e.ordinal) wire,string_agg(e.effect::text,'' order by e.ordinal) parsed
 from pages p join pjsdas_rows_candidate.large_effect e on e.stage_id=target_stage and e.ordinal>=p.lo and (p.hi is null or e.ordinal<p.hi) group by p.lo)
 select 'intent-record',0::bigint,convert_to(jsonb_build_object('identity',i.identity,'binding',i.binding,'encoded',i.encoded)::text,'UTF8') from pjsdas_rows_candidate.large_command_intent i where i.stage_id=target_stage and i.retirement is null
 union all select 'manifest-wire',0,convert_to(b.manifest_wire,'UTF8') from pjsdas_rows_candidate.large_document_bundle b where b.stage_id=target_stage
 union all select 'manifest-jsonb',0,convert_to(b.manifest::text,'UTF8') from pjsdas_rows_candidate.large_document_bundle b where b.stage_id=target_stage
 union all select 'document:'||f.document_name,f.byte_offset,f.bytes from pjsdas_rows_candidate.large_document_fragment f where f.stage_id=target_stage
 union all select 'effect-wire:'||lo,0,convert_to(wire,'UTF8') from effect_pages
 union all select 'effect-jsonb:'||lo,0,convert_to(parsed,'UTF8') from effect_pages
 union all select case when s.family like 'documents:%' then 'stage-binding' else 'reconstructed-request' end,0,convert_to(s.request::text,'UTF8') from pjsdas_rows_candidate.large_stage s where s.id=target_stage and s.request is not null
 union all select 'stage-result',0,convert_to(s.result::text,'UTF8') from pjsdas_rows_candidate.large_stage s where s.id=target_stage and s.result is not null
$$;
create function ta_resource_reservations.rpc_assert_original_inventory(target_stage uuid) returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare r ta_resource_reservations.reservation%rowtype;n bigint;mismatch boolean;
begin
 select * into strict r from ta_resource_reservations.reservation where stage_id=target_stage::text;
 if exists(select 1 from ta_resource_reservations.temporary_bytes where stage_id=target_stage::text) then raise exception 'unmapped sidecar bytes' using errcode='PT409';end if;
 with actual as materialized(select allocation_id,byte_offset,octet_length(data)::bigint bytes,encode(sha256(data),'hex') sha256 from ta_resource_reservations.rpc_original_inventory(target_stage)),
 expected as(select c.* from ta_resource_reservations.chunk c join ta_resource_reservations.allocation a using(stage_id,allocation_id) where c.stage_id=target_stage::text and not a.removed)
 select (select coalesce(sum(bytes),0) from actual),exists(select 1 from actual x full join expected e using(allocation_id,byte_offset) where x.bytes is distinct from e.bytes or x.sha256 is distinct from e.sha256 or e.status is distinct from 'present') into n,mismatch;
 if mismatch then raise exception 'original-table inventory mismatch' using errcode='PT409';end if;
 if exists(select 1 from (select c.byte_offset,c.bytes,a.next_offset,
  coalesce(lag(c.byte_offset+c.bytes) over(partition by c.allocation_id order by c.byte_offset),0) expected_offset,
  max(c.byte_offset+c.bytes) over(partition by c.allocation_id) last_offset
  from ta_resource_reservations.chunk c join ta_resource_reservations.allocation a using(stage_id,allocation_id)
  where c.stage_id=target_stage::text and not a.removed) x where byte_offset<>expected_offset or last_offset<>next_offset)
 then raise exception 'original inventory offset gap/overlap' using errcode='PT409';end if;
 if exists(select 1 from ta_resource_reservations.allocation a left join lateral(select sum(bytes) n from ta_resource_reservations.chunk c where c.stage_id=a.stage_id and c.allocation_id=a.allocation_id and status='present') c on true
 where a.stage_id=target_stage::text and not a.removed and (a.occupied is distinct from c.n or a.present is distinct from c.n or a.next_offset is distinct from c.n))
 then raise exception 'allocation inventory mismatch' using errcode='PT409';end if;
 if n<>r.occupied or n<>r.present or exists(select 1 from pjsdas_rows_candidate.large_effect e where e.stage_id=target_stage and not exists(select 1 from ta_resource_reservations.allocation a where a.stage_id=target_stage::text and a.allocation_id='effect-wire:0' and not a.removed))
 then raise exception 'original inventory aggregate/orphan mismatch' using errcode='PT409';end if;
end$$;

-- Canonical UTC JSONB/UTF8 logical residual (not caller/session timezone): all
-- Complete per-command logical control, including metering rows and all accounting
-- scalars. Shared pool/owner aggregates are independently checked, not duplicated
-- per command. DB tuple/index/MVCC/TOAST/WAL overhead is not logical JSON bytes.
-- Only the self-hash VALUE is canonicalized to 64 zero hex characters; its full
-- key/string length remains charged. Solve the integer byte-length fixed point,
-- not a SHA fixed point. No stable length => defer with the original full charge.
-- Explicit slim projections avoid serializing large payloads merely to drop them.
create function ta_resource_reservations.rpc_control_bytes(target_stage uuid,t jsonb) returns bytea
language plpgsql stable security invoker set search_path=pg_catalog set timezone='UTC' as $$
declare base jsonb;r ta_resource_reservations.reservation%rowtype;resource_row jsonb;meter jsonb;meter_chunk jsonb;
 raw bytea;n bigint:=1;measured bigint;iteration integer;
begin
 select * into strict r from ta_resource_reservations.reservation where stage_id=target_stage::text;
 select jsonb_build_object(
  'intent',(select to_jsonb(slim) from (select i.user_id,i.command_id,i.stage_id,i.identity,i.binding,null::jsonb encoded,i.deadline_at,i.protocol,t retirement) slim),
  'stage',(select to_jsonb(slim) from (select s.id,s.user_id,s.workspace_id,null::jsonb request,s.effect_count,s.final_digest,
    s.next_ordinal,s.rolling_digest,s.received_bytes,s.expires_at,null::jsonb result,s.family,s.authority from pjsdas_rows_candidate.large_stage s where s.id=target_stage) slim),
  'documentReservation',(select to_jsonb(d) from pjsdas_rows_candidate.large_document_reservation d where d.stage_id=target_stage),
  'attempt',(select to_jsonb(a) from pjsdas_rows_candidate.large_command_attempt a where a.stage_id=target_stage),
  'allocationTombstones',(select coalesce(jsonb_agg(to_jsonb(a)||'{"removed":true,"occupied":0,"present":0}'::jsonb order by a.allocation_id),'[]'::jsonb) from ta_resource_reservations.allocation a where a.stage_id=target_stage::text and a.allocation_id<>'retained-control'),
  'chunkTombstones',(select coalesce(jsonb_agg(to_jsonb(c) order by c.allocation_id,c.byte_offset),'[]'::jsonb) from ta_resource_reservations.chunk c where c.stage_id=target_stage::text and c.allocation_id<>'retained-control')
 ) into base from pjsdas_rows_candidate.large_command_intent i where i.stage_id=target_stage;
 -- Once precharged, validate that exact chosen C; do not seek another root
 -- after the transition peak has been materialized.
 if r.phase in ('reclaiming','reclaimed') then n:=r.retained_control_bytes;end if;
 for iteration in 1..32 loop
  if r.phase='reclaimed' then
   resource_row:=to_jsonb(r);
   select to_jsonb(a) into meter from ta_resource_reservations.allocation a where a.stage_id=r.stage_id and allocation_id='retained-control';
   select to_jsonb(c)||jsonb_build_object('sha256',repeat('0',64)) into meter_chunk from ta_resource_reservations.chunk c where c.stage_id=r.stage_id and allocation_id='retained-control' and byte_offset=0;
  else
   resource_row:=to_jsonb(r)||jsonb_build_object('phase','reclaimed','revision',(t->>'fenceRevision')::bigint+1,
    'outcome',t->'resourceOutcome','reclaim_id',t->'reclaimId','writer_fence',t->'writerFence',
    'writer_fence_revision',t->'fenceRevision','reclaim_inventory_revision',t->'inventoryRevision',
    'occupied',n,'present',n,'current_held',n,'released_bytes',r.reserved-n,'retained_control_bytes',n,
    'rpc_peak_occupied',case when r.phase='reclaiming' then r.rpc_peak_occupied else greatest(r.rpc_peak_occupied,r.occupied+n) end);
   meter:=to_jsonb(row(r.stage_id,'retained-control','retained-control',n,n,n,false)::ta_resource_reservations.allocation);
   meter_chunk:=to_jsonb(row(r.stage_id,'retained-control',0,n,repeat('0',64),'present')::ta_resource_reservations.chunk);
  end if;
  raw:=convert_to((base||jsonb_build_object('resourceReservation',resource_row,'controlAllocation',meter,'controlChunk',meter_chunk))::text,'UTF8');
  measured:=octet_length(raw);if measured=n then return raw;end if;
  if r.phase in ('reclaiming','reclaimed') then return null;end if;n:=measured;
 end loop;
 return null;
end$$;

create function ta_resource_reservations.rpc_assert_aggregates() returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if exists(select 1 from ta_resource_reservations.pool p cross join (select coalesce(sum(current_held),0) h,coalesce(sum(occupied),0) o,coalesce(sum(present),0) b from ta_resource_reservations.reservation) x
  where p.held<>x.h or p.occupied<>x.o or p.present<>x.b)
 or exists(select 1 from ta_resource_reservations.owner o left join (select user_id,sum(current_held) h,sum(occupied) n,sum(present) b from ta_resource_reservations.reservation group by user_id) x using(user_id)
  where o.held<>coalesce(x.h,0) or o.occupied<>coalesce(x.n,0) or o.present<>coalesce(x.b,0))
 then raise exception 'original resource aggregate mismatch' using errcode='PT409';end if;
end$$;

create function ta_resource_reservations.rpc_reclaim_original(target_stage uuid,target_user uuid) returns text
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;s pjsdas_rows_candidate.large_stage%rowtype;
 b pjsdas_rows_candidate.large_document_bundle%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;
 r ta_resource_reservations.reservation%rowtype;p ta_resource_reservations.pool%rowtype;d pjsdas_rows_candidate.large_document_reservation%rowtype;
 original jsonb;comp jsonb;provenance jsonb;t jsonb;observed_outcome jsonb;raw bytea;n bigint;delta bigint;before_occupied bigint;before_present bigint;
begin
 if not ta_resource_reservations.rpc_enabled(target_user) then return 'disabled';end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if not found then return 'absent';end if;
 perform pjsdas_rows_internal.retirement_lock(i.identity,target_user);
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 select * into p from ta_resource_reservations.pool where singleton;
 if not found or not p.reclamation_enabled or not p.enabled or not p.inventory_verified or p.generation<>'rpc-local-v1' then return 'deferred-policy';end if;
 select * into r from ta_resource_reservations.reservation where stage_id=target_stage::text;
 if not found or r.binding is distinct from i.binding or r.intent_protocol is distinct from i.protocol or r.deadline_at is distinct from i.deadline_at then raise exception 'reclaim immutable resource mismatch' using errcode='PT409';end if;
 select * into a from pjsdas_rows_candidate.large_command_attempt where stage_id=target_stage for update;
 select * into s from pjsdas_rows_candidate.large_stage where id=target_stage for update;
 select * into b from pjsdas_rows_candidate.large_document_bundle where stage_id=target_stage for update;
 select * into d from pjsdas_rows_candidate.large_document_reservation where stage_id=target_stage;
 if d.user_id is distinct from target_user or d.workspace_id is distinct from (i.binding->>'workspaceId')::uuid or d.reserved_bytes is distinct from r.reserved
 or floor(extract(epoch from d.expires_at)*1000)::bigint is distinct from r.expires_at then raise exception 'reclaim original reservation mismatch' using errcode='PT409';end if;
 original:=pjsdas_rows_internal.retired_original(target_stage,target_user,true);
 if i.retirement is not null then
  if r.phase<>'reclaimed' or r.reclaim_id is distinct from i.retirement->>'reclaimId' or r.writer_fence is distinct from i.retirement->>'writerFence'
   or r.outcome is distinct from i.retirement->'resourceOutcome' or r.writer_fence_revision is distinct from (i.retirement->>'fenceRevision')::bigint
   or r.reclaim_inventory_revision is distinct from (i.retirement->>'inventoryRevision')::bigint
   or i.encoded is not null or s.request is not null or s.result is not null or b.stage_id is not null
   or exists(select 1 from pjsdas_rows_candidate.large_document_fragment where stage_id=target_stage)
   or exists(select 1 from pjsdas_rows_candidate.large_effect where stage_id=target_stage)
   or exists(select 1 from ta_resource_reservations.allocation where stage_id=target_stage::text and allocation_id<>'retained-control' and not removed)
  then raise exception 'retired original inventory changed' using errcode='PT409';end if;
  raw:=ta_resource_reservations.rpc_control_bytes(target_stage,i.retirement);n:=octet_length(raw);
  if n<>r.retained_control_bytes
  or not exists(select 1 from ta_resource_reservations.allocation where stage_id=target_stage::text and allocation_id='retained-control' and kind='retained-control' and not removed and next_offset=n and occupied=n and present=n)
  or (select count(*) from ta_resource_reservations.chunk where stage_id=target_stage::text and allocation_id='retained-control')<>1
  or not exists(select 1 from ta_resource_reservations.chunk where stage_id=target_stage::text and allocation_id='retained-control' and byte_offset=0 and bytes=n and sha256=encode(sha256(raw),'hex') and status='present')
  then raise exception 'retained control changed' using errcode='PT409';end if;
  perform ta_resource_reservations.rpc_assert_aggregates();
  return 'replayed';
 end if;
 if original is not null then
  if s.result is null or s.result->'receipt' is distinct from original->'receipt' or s.result->'revision' is distinct from original->'revision'
   or coalesce(s.result->>'outcome','') not in ('COMMITTED','ALREADY_APPLIED') or (s.result-array['outcome','revision','receipt'])<>'{}'::jsonb
  then raise exception 'exact original result required for retirement' using errcode='PT409';end if;
  select compensation,l.provenance into comp,provenance from pjsdas_rows_candidate.ledger l where user_id=target_user and command_id=i.command_id;
  observed_outcome:=jsonb_build_object('kind','committed','revision',original->'revision','receiptSha256',encode(sha256(convert_to((original->'receipt')::text,'UTF8')),'hex'),
   'compensationSha256',encode(sha256(convert_to(coalesce(comp,'null'::jsonb)::text,'UTF8')),'hex'));
  if r.outcome is not null and r.outcome is distinct from observed_outcome then raise exception 'original resource outcome changed' using errcode='PT409';end if;
 elsif a.terminal_reason is not null then
  observed_outcome:=jsonb_build_object('kind','not-committed','reason',a.terminal_reason);
  if r.outcome is not null and r.outcome is distinct from observed_outcome then raise exception 'terminal resource outcome changed' using errcode='PT409';end if;
 else return 'unresolved';end if;
 if r.writer_fence is not null or r.phase not in ('open','stopped','finalizing','unknown','committed','not-committed') then raise exception 'reclaim state mismatch' using errcode='PT409';end if;
 if s.id is not null and (s.user_id is distinct from target_user or s.workspace_id is distinct from (i.binding->>'workspaceId')::uuid
  or s.authority is distinct from i.binding->'authority' or s.family not in (i.binding->>'family','documents:'||(i.binding->>'family'))
  or s.request->>'commandId' is distinct from i.command_id or s.request->>'payloadHash' is distinct from i.identity->>'payloadHash')
 then raise exception 'original stage identity changed' using errcode='PT409';end if;
 if b.stage_id is not null and (b.manifest_sha256 is distinct from i.binding->>'manifestSha256'
  or encode(sha256(convert_to(b.manifest_wire,'UTF8')),'hex') is distinct from b.manifest_sha256 or b.manifest_wire::jsonb is distinct from b.manifest
  or b.manifest->'binding' is distinct from i.binding-array['preparedSha256','manifestSha256']
  or s.effect_count is distinct from (b.manifest#>>'{effects,count}')::integer or s.final_digest is distinct from b.manifest#>>'{effects,sha256}')
 then raise exception 'original manifest identity changed' using errcode='PT409';end if;
 if s.id is not null and s.next_ordinal<>(select count(*) from pjsdas_rows_candidate.large_effect where stage_id=target_stage)
 then raise exception 'original effect inventory count changed' using errcode='PT409';end if;
 perform ta_resource_reservations.rpc_assert_aggregates();
 perform ta_resource_reservations.rpc_assert_original_inventory(target_stage);
 t:=jsonb_build_object('protocol','workspace-retired-stage-v1','kind',case when original is null then 'TERMINAL_UNCOMMITTED' else 'COMMITTED' end,
  'reason',a.terminal_reason,'reclaimId',gen_random_uuid()::text,'writerFence',gen_random_uuid()::text,'fenceRevision',r.revision+1,'inventoryRevision',p.revision,
  'resourceOutcome',observed_outcome,'encodedDescriptor',i.encoded-'base64','encodedSha256',encode(sha256(convert_to(i.encoded::text,'UTF8')),'hex'),
  'requestSha256',case when s.request is null then null else encode(sha256(convert_to(s.request::text,'UTF8')),'hex') end,
  'resultSha256',case when s.result is null then null else encode(sha256(convert_to(s.result::text,'UTF8')),'hex') end,
  'resultMeta',s.result-'receipt','undoOf',provenance->>'undoOf','documents',b.manifest->'documents','nextOffsets',b.next_offsets);
 raw:=ta_resource_reservations.rpc_control_bytes(target_stage,t);n:=octet_length(raw);
 -- No early release: the actual transition control is charged atop ALL live
 -- copies. Deferral leaves the existing successful result and full R intact.
 if n is null or n<1 or n>r.current_held-r.occupied then return 'deferred-transition-capacity';end if;
 before_occupied:=r.occupied;before_present:=r.present;
 insert into ta_resource_reservations.allocation(stage_id,allocation_id,kind,next_offset,occupied,present) values(r.stage_id,'retained-control','retained-control',n,n,n);
 insert into ta_resource_reservations.chunk values(r.stage_id,'retained-control',0,n,encode(sha256(raw),'hex'),'present');
 update ta_resource_reservations.reservation set phase='reclaiming',outcome=observed_outcome,reclaim_id=t->>'reclaimId',writer_fence=t->>'writerFence',writer_fence_revision=(t->>'fenceRevision')::bigint,
  reclaim_inventory_revision=(t->>'inventoryRevision')::bigint,occupied=occupied+n,present=present+n,retained_control_bytes=n,rpc_peak_occupied=greatest(rpc_peak_occupied,occupied+n),revision=revision+1 where stage_id=r.stage_id;
 update ta_resource_reservations.owner set occupied=occupied+n,present=present+n,rpc_peak_occupied=greatest(rpc_peak_occupied,occupied+n) where user_id=r.user_id;
 update ta_resource_reservations.pool set occupied=occupied+n,present=present+n,rpc_peak_occupied=greatest(rpc_peak_occupied,occupied+n),revision=revision+1 where singleton;
 -- Tombstone precedes deletion. No logical point in this transaction permits a
 -- writer to insert again; any backend death rolls business and reclaim back.
 update pjsdas_rows_candidate.large_command_intent set encoded=null,retirement=t where stage_id=target_stage;
 delete from pjsdas_rows_candidate.large_document_fragment where stage_id=target_stage;
 delete from pjsdas_rows_candidate.large_effect where stage_id=target_stage;
 delete from pjsdas_rows_candidate.large_document_bundle where stage_id=target_stage;
 update pjsdas_rows_candidate.large_stage set request=null,result=null where id=target_stage;
 if exists(select 1 from ta_resource_reservations.rpc_original_inventory(target_stage))
 or ta_resource_reservations.rpc_control_bytes(target_stage,t) is distinct from raw then raise exception 'retired original payload absence/control not confirmed' using errcode='PT409';end if;
 update ta_resource_reservations.allocation set removed=true,occupied=0,present=0 where stage_id=r.stage_id and allocation_id<>'retained-control';
 delta:=r.current_held-n;
 update ta_resource_reservations.reservation set phase='reclaimed',occupied=n,present=n,current_held=n,released_bytes=released_bytes+delta,revision=revision+1 where stage_id=r.stage_id;
 update ta_resource_reservations.owner set held=held-delta,occupied=occupied-before_occupied,present=present-before_present where user_id=r.user_id;
 update ta_resource_reservations.pool set held=held-delta,occupied=occupied-before_occupied,present=present-before_present,revision=revision+1 where singleton;
 perform ta_resource_reservations.rpc_assert_aggregates();
 return 'reclaimed';
end$$;

-- Existing terminal/receipt remains valid if optional cleanup finds corrupt or
-- unavailable inventory. The savepoint rolls back ALL attempted cleanup. Never
-- swallow deadline/backend/cancel/unknown errors or manufacture a receipt.
create function pjsdas_rows_internal.try_retire_original(target_stage uuid,target_user uuid) returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform ta_resource_reservations.rpc_reclaim_original(target_stage,target_user);
exception when sqlstate 'PT409' or sqlstate '42501' then return;
end$$;

create function pjsdas_rows_internal.settled_intent_outcome(identity jsonb,target_user uuid) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;original jsonb;
begin
 select * into i from pjsdas_rows_candidate.large_command_intent where user_id=target_user and command_id=settled_intent_outcome.identity->>'commandId';
 if not found then return null;end if;
 perform pjsdas_rows_internal.retirement_lock(identity,target_user);
 select * into i from pjsdas_rows_candidate.large_command_intent where user_id=target_user and command_id=settled_intent_outcome.identity->>'commandId';
 if i.identity->'payloadHash' is distinct from identity->'payloadHash' then raise exception 'command payload reused' using errcode='23505';end if;
 if i.identity is distinct from identity then raise exception 'original immutable authority required' using errcode='42501';end if;
 original:=pjsdas_rows_internal.retired_original(i.stage_id,target_user);
 if original is not null then return jsonb_build_object('outcome','ALREADY_APPLIED','commandId',i.command_id,'revision',original->'revision');end if;
 select * into a from pjsdas_rows_candidate.large_command_attempt where stage_id=i.stage_id for update;
 if a.terminal_reason is not null then
  if i.retirement is not null and (i.retirement->>'kind'<>'TERMINAL_UNCOMMITTED' or i.retirement->>'reason' is distinct from a.terminal_reason) then raise exception 'terminal retirement changed' using errcode='42501';end if;
  return jsonb_build_object('outcome','TERMINAL_UNCOMMITTED','reason',a.terminal_reason);
 end if;
 if i.retirement is not null then raise exception 'retired intent cannot become absent/live' using errcode='PT409';end if;
 return null;
end$$;
create function pjsdas_rows_internal.retired_stage_status(target_stage uuid,target_user uuid,manifest_sha text,mode text) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;original jsonb;result jsonb;h pjsdas_rows_candidate.head%rowtype;s pjsdas_rows_candidate.large_stage%rowtype;b pjsdas_rows_candidate.large_document_bundle%rowtype;
begin
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if not found then return null;end if;
 select * into s from pjsdas_rows_candidate.large_stage where id=target_stage;
 if i.retirement is null and s.result is null then return null;end if;
 if manifest_sha is not null and manifest_sha is distinct from i.binding->>'manifestSha256' then raise exception 'original retired manifest required' using errcode='42501';end if;
 result:=pjsdas_rows_internal.settled_intent_outcome(i.identity,target_user);
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if result->>'outcome'='TERMINAL_UNCOMMITTED' then return result;end if;
 select * into h from pjsdas_rows_candidate.head where user_id=target_user;
 if h.id is distinct from (i.binding->>'workspaceId')::uuid or h.epoch is distinct from (i.binding->>'expectedEpoch')::uuid or h.format<>'workspace-rows-v1' then raise exception 'original retired generation changed' using errcode='PT409';end if;
 if i.retirement is null then
  select * into s from pjsdas_rows_candidate.large_stage where id=target_stage;
  original:=pjsdas_rows_internal.retired_original(target_stage,target_user);
  if s.result->'receipt' is distinct from original->'receipt' or s.result->'revision' is distinct from original->'revision' then raise exception 'original completion cache mismatch' using errcode='42501';end if;
  if mode='begin' then
   select * into b from pjsdas_rows_candidate.large_document_bundle where stage_id=target_stage;
   return jsonb_build_object('stageId',target_stage,'manifestSha256',i.binding->'manifestSha256','completed',true,'nextOffsets',b.next_offsets);
  end if;
  return s.result;
 end if;
 if mode='begin' then return jsonb_build_object('stageId',target_stage,'manifestSha256',i.binding->'manifestSha256','completed',true,'nextOffsets',i.retirement->'nextOffsets');end if;
 original:=pjsdas_rows_internal.retired_original(target_stage,target_user);
 result:=(i.retirement->'resultMeta')||jsonb_build_object('receipt',original->'receipt');
 if encode(sha256(convert_to(result::text,'UTF8')),'hex') is distinct from i.retirement->>'resultSha256' then raise exception 'original result envelope changed' using errcode='42501';end if;
 return result;
end$$;
create function pjsdas_rows_internal.retirement_execution_snapshot(target_stage uuid,target_user uuid) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;d pjsdas_rows_candidate.large_document_reservation%rowtype;
begin
 perform pjsdas_rows_internal.require_intent_deadline(target_stage,target_user);
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 if not found then return null;end if;
 select * into a from pjsdas_rows_candidate.large_command_attempt where stage_id=target_stage;
 select * into d from pjsdas_rows_candidate.large_document_reservation where stage_id=target_stage;
 return jsonb_build_object('protocol',i.protocol,'deadline',case when i.protocol='workspace-prepared-intent-v1' then i.deadline_at else a.deadline_at end,
  'attemptId',a.attempt_id,'generation',a.generation,'expiry',d.expires_at);
end$$;
create function pjsdas_rows_internal.assert_retirement_execution(target_stage uuid,target_user uuid,captured jsonb) returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;d pjsdas_rows_candidate.large_document_reservation%rowtype;
begin
 if captured is null then return;end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user;
 select * into a from pjsdas_rows_candidate.large_command_attempt where stage_id=target_stage;
 select * into d from pjsdas_rows_candidate.large_document_reservation where stage_id=target_stage;
 if i.protocol is distinct from captured->>'protocol' or to_jsonb(d.expires_at) is distinct from captured->'expiry'
 or (i.protocol='workspace-prepared-intent-v1' and i.deadline_at is distinct from (captured->>'deadline')::bigint)
 or (i.protocol='workspace-prepared-intent-v2' and (to_jsonb(a.attempt_id) is distinct from captured->'attemptId' or to_jsonb(a.generation) is distinct from captured->'generation' or a.deadline_at is distinct from (captured->>'deadline')::bigint))
 then raise exception 'original execution fence changed during retirement' using errcode='PT409';end if;
 if (captured->>'deadline')::bigint<=extract(epoch from clock_timestamp())*1000 or (captured->>'expiry')::timestamptz<=clock_timestamp()
 then raise exception 'original attempt budget exhausted during retirement' using errcode='PT503';end if;
end$$;

-- One outer public finish shared by v1/v2. All original nested business/audit,
-- authority/CAS/readability and final deadline guards execute BEFORE retirement.
create or replace function public.pjsdas_rows_v1_large_documents_finish(stage_id uuid,target_user_id uuid,manifest_sha256 text) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare result jsonb;captured jsonb;
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,null);
 result:=pjsdas_rows_internal.retired_stage_status(stage_id,target_user_id,manifest_sha256,'finish');
 if result is not null then perform pjsdas_rows_internal.try_retire_original(stage_id,target_user_id);return result;end if;
 perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 result:=pjsdas_rows_candidate.large_documents_finish(stage_id,target_user_id,manifest_sha256);
 perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 captured:=pjsdas_rows_internal.retirement_execution_snapshot(stage_id,target_user_id);
 if result->>'outcome' in ('COMMITTED','ALREADY_APPLIED') then perform ta_resource_reservations.rpc_reclaim_original(stage_id,target_user_id);end if;
 perform pjsdas_rows_internal.assert_retirement_execution(stage_id,target_user_id,captured);
 return result;
end$$;
create or replace function public.pjsdas_rows_v1_large_documents_begin(manifest_wire text,manifest_sha256 text,target_user_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare result jsonb;sid uuid:=(manifest_wire::jsonb#>>'{binding,stageId}')::uuid;
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,(manifest_wire::jsonb#>>'{binding,expectedEpoch}')::uuid);
 perform pjsdas_rows_internal.require_original_intent_document(manifest_wire,manifest_sha256,target_user_id);
 if encode(sha256(convert_to(manifest_wire,'UTF8')),'hex') is distinct from manifest_sha256 then raise exception 'manifest digest changed' using errcode='22023';end if;
 result:=pjsdas_rows_internal.retired_stage_status(sid,target_user_id,manifest_sha256,'begin');
 if result is not null then return result;end if;
 perform pjsdas_rows_internal.require_intent_deadline(sid,target_user_id);
 result:=pjsdas_rows_candidate.large_documents_begin(manifest_wire,manifest_sha256,target_user_id);
 perform pjsdas_rows_internal.require_intent_deadline(sid,target_user_id);
 return result;
end$$;

create function pjsdas_rows_internal.reclaim_patch(signature text,needle text,replacement text) returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare p record;
begin
 select oid,prosrc into strict p from pg_proc where oid=to_regprocedure(signature);
 if (length(p.prosrc)-length(replace(p.prosrc,needle,'')))/length(needle)<>1 then raise exception 'reclaim patch boundary mismatch: %',signature;end if;
 execute replace(pg_get_functiondef(p.oid),p.prosrc,replace(p.prosrc,needle,replacement));
end$$;
-- Re-read after locks, so a LIVE reader delayed by a committing/cancelling
-- session cannot use its old row variable to rematerialize cleared bytes.
select pjsdas_rows_internal.reclaim_patch('pjsdas_rows_internal.require_intent_deadline(uuid,uuid)',
 ' perform pjsdas_rows_internal.intent_lock(i.identity,target_user_id);',
 E' perform pjsdas_rows_internal.intent_lock(i.identity,target_user_id);\n select * into i from pjsdas_rows_candidate.large_command_intent x where x.stage_id=require_intent_deadline.stage_id;\n if i.retirement is not null then raise exception \'retired original intent writer fenced\' using errcode=\'PT409\';end if;');
select pjsdas_rows_internal.reclaim_patch('ta_resource_reservations.rpc_charge(uuid,text,text,bigint,bytea)',
 ' if not found then return;end if;',E' if not found then return;end if;\n if r.phase<>\'open\' or r.writer_fence is not null or exists(select 1 from pjsdas_rows_candidate.large_command_intent i where i.stage_id=target_stage and i.retirement is not null) then raise exception \'permanent resource writer fence\' using errcode=\'PT409\';end if;');
select pjsdas_rows_internal.reclaim_patch('ta_resource_reservations.rpc_charge(uuid,text,text,bigint,bytea)','n>r.reserved-r.occupied','n>r.current_held-r.occupied');
select pjsdas_rows_internal.reclaim_patch('ta_resource_reservations.rpc_stage(uuid,uuid)',' r.phase not in (''open'',''committed'')', ' r.phase<>''open''');
select pjsdas_rows_internal.reclaim_patch('ta_resource_reservations.rpc_request_replaced(uuid)',
 ' if not found then return;end if;',E' if not found then return;end if;\n if r.writer_fence is not null or r.phase<>\'open\' then raise exception \'resource replacement fenced\' using errcode=\'PT409\';end if;');
-- Direct finish entries may replay but never re-enter a writer on completion.
do $$declare sig text;family text;begin
 for sig,family in select * from(values('pjsdas_rows_candidate.large_finish(uuid,uuid)','first_party_abandon'),('pjsdas_rows_candidate.large_finish_opportunity(uuid,uuid)','opportunity_v3')) x(s,f) loop
 perform pjsdas_rows_internal.reclaim_patch(sig,E'\nbegin\n',E'\nbegin\n declare saved jsonb;begin if exists(select 1 from pjsdas_rows_candidate.large_command_intent where large_command_intent.stage_id='||split_part(split_part(sig,'(',1),'.',2)||E'.stage_id and user_id=target_user_id and identity->>\'family\'=\''||family||E'\') then saved:=pjsdas_rows_internal.retired_stage_status(stage_id,target_user_id,null,\'finish\');if saved is not null then return saved;end if;end if;end;\n');
 end loop;
end$$;
-- Observational compact outcomes run before LIVE-only base/codec/deadline checks.
select pjsdas_rows_internal.reclaim_patch('pjsdas_rows_candidate.large_intent_read(jsonb,uuid)',
 ' perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);',
 E' declare settled jsonb;begin settled:=pjsdas_rows_internal.settled_intent_outcome(identity,target_user_id);if settled is not null then return settled;end if;end;\n perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);');
select pjsdas_rows_internal.reclaim_patch('pjsdas_rows_candidate.large_v2_intent_read(jsonb,uuid)',
 ' perform pjsdas_rows_internal.intent_lock(identity,target_user_id);',
 E' declare settled jsonb;begin settled:=pjsdas_rows_internal.settled_intent_outcome(identity,target_user_id);if settled is not null then return settled;end if;end;\n perform pjsdas_rows_internal.intent_lock(identity,target_user_id);');
select pjsdas_rows_internal.reclaim_patch('pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid)',
 ' perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);',
 E' existing:=pjsdas_rows_internal.settled_intent_outcome(identity,target_user_id);if existing is not null then return existing;end if;\n perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);');
-- Published retirement remains distinct from the internal readability probe.
select pjsdas_rows_internal.reclaim_patch('ta_resource_reservations.rpc_history_lock(uuid,jsonb)',
 'where id=i.stage_id and result is not null',
 'where id=i.stage_id and (result is not null or i.retirement is not null)');
-- Completed reservation queries must not rely on the deleted duplicate result.
select pjsdas_rows_internal.reclaim_patch('pjsdas_rows_candidate.large_documents_check_reservation(uuid,uuid,uuid,bigint)',
 's.id=r.stage_id and s.result is not null',
 's.id=r.stage_id and (s.result is not null or exists(select 1 from pjsdas_rows_candidate.large_command_intent i where i.stage_id=s.id and i.retirement->>''kind''=''COMMITTED''))');
-- Exact public observer wrappers only; nested history/readability never cleans.
do $$declare sig text;body text;p record;begin
 for sig in select oid::regprocedure::text from pg_proc where pronamespace='public'::regnamespace and proname in
 ('pjsdas_rows_v1_large_intent_read','pjsdas_rows_v1_large_intent_admit','pjsdas_rows_v1_large_v2_intent_read','pjsdas_rows_v1_large_v2_intent_admit','pjsdas_rows_v1_large_v2_attempt_begin','pjsdas_rows_v1_large_v2_intent_cancel') loop
  select oid,prosrc into strict p from pg_proc where oid=to_regprocedure(sig);
  body:=regexp_replace(p.prosrc,'return ([^;]+);','declare saved jsonb;sid uuid;lookup_command text:=identity->>''commandId'';begin saved:=\1;if saved ? ''outcome'' then select stage_id into sid from pjsdas_rows_candidate.large_command_intent where user_id=target_user_id and command_id=lookup_command;if sid is not null then perform pjsdas_rows_internal.try_retire_original(sid,target_user_id);end if;end if;return saved;end;');
  if body=p.prosrc then raise exception 'public terminal hook absent: %',sig;end if;
  execute replace(pg_get_functiondef(p.oid),p.prosrc,body);
 end loop;
end$$;
select pjsdas_rows_internal.reclaim_patch('pjsdas_rows_internal.exhausted_intent(uuid,uuid)',
 ' return pjsdas_rows_internal.terminalize_intent(i.identity,target_user_id,''RESOURCE_EXHAUSTED'');',
 ' declare saved jsonb;begin saved:=pjsdas_rows_internal.terminalize_intent(i.identity,target_user_id,''RESOURCE_EXHAUSTED'');perform pjsdas_rows_internal.try_retire_original(target_stage,target_user_id);return saved;end;');

create or replace function public.pjsdas_rows_v1_large_v2_documents_check_reservation(stage_id uuid,target_user_id uuid,target_workspace_id uuid,required_bytes bigint,attempt jsonb) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare result boolean;settled jsonb;
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,null);
 settled:=pjsdas_rows_internal.retired_stage_status(stage_id,target_user_id,null,'finish');
 if settled is not null then
  if settled->>'outcome'='TERMINAL_UNCOMMITTED' then raise exception 'original terminal intent' using errcode='PT410';end if;
  return public.pjsdas_rows_v1_large_documents_check_reservation(stage_id,target_user_id,target_workspace_id,required_bytes);
 end if;
 perform set_config('pjsdas_rows.attempt_v2',attempt::text,true);
 perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 result:=public.pjsdas_rows_v1_large_documents_check_reservation(stage_id,target_user_id,target_workspace_id,required_bytes);
 perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 return result;
end$$;

-- Service-only private helpers retain INVOKER and existing public-only routing.
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where (pronamespace='ta_resource_reservations'::regnamespace and proname in ('rpc_assert_aggregates','rpc_held_init','rpc_original_inventory','rpc_assert_original_inventory','rpc_control_bytes','rpc_reclaim_original'))
 or (pronamespace='pjsdas_rows_internal'::regnamespace and proname in ('retirement_attempt_guard','retirement_identity_guard','retirement_payload_guard','retirement_lock','retired_original','try_retire_original','settled_intent_outcome','retired_stage_status','retirement_execution_snapshot','assert_retirement_execution')) loop
  execute 'revoke all on function '||p.signature||' from public,anon,authenticated';
  execute 'grant execute on function '||p.signature||' to service_role';
 end loop;
end$$;
drop function pjsdas_rows_internal.reclaim_patch(text,text,text);

-- LOCAL SYNTHETIC PROTOTYPE ONLY. Not a migration, public RPC, or rollout.
-- Existing fast-path caps remain unchanged. Only an explicit first-party
-- abandon/its Undo vertical slice is supported; never dispatch guarded families.
create table pjsdas_rows_candidate.large_stage (
 id uuid primary key, user_id uuid not null, workspace_id uuid not null,
 request jsonb not null, effect_count integer not null check(effect_count>=0),
 final_digest text not null check(final_digest ~ '^[0-9a-f]{64}$'),
 next_ordinal integer not null default 0, rolling_digest text not null default repeat('0',64),
 received_bytes bigint not null default 0, expires_at timestamptz not null,
 result jsonb, family text not null default 'first_party_abandon', authority jsonb not null default '{}'::jsonb,
 foreign key(workspace_id,user_id) references pjsdas_rows_candidate.head(id,user_id)
);
create table pjsdas_rows_candidate.large_effect (
 stage_id uuid not null references pjsdas_rows_candidate.large_stage(id),
 ordinal integer not null check(ordinal>=0), wire text not null, digest text not null,
 effect jsonb not null,
 primary key(stage_id,ordinal)
);
create unique index large_effect_identity on pjsdas_rows_candidate.large_effect(stage_id,(effect->>'collection'),(effect->>'id'));
alter table pjsdas_rows_candidate.large_stage enable row level security;
alter table pjsdas_rows_candidate.large_effect enable row level security;
revoke all on pjsdas_rows_candidate.large_stage,pjsdas_rows_candidate.large_effect from public,anon,authenticated;
grant select,insert,update,delete on pjsdas_rows_candidate.large_stage,pjsdas_rows_candidate.large_effect to service_role;

create function pjsdas_rows_candidate.large_begin(stage_id uuid,req jsonb,effect_count integer,final_digest text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype; h pjsdas_rows_candidate.head%rowtype;
begin
 if req->>'principal' is distinct from 'first_party_web' or req->>'operation' not in ('abandon_opportunity','domain:abandon_opportunity','undo_command')
 or req->>'operation' is null or req ?| array['changes','managementAuthorization','aiCaptureAuthorization','discoveryAuthorization']
 or req->>'clientId' is not null or effect_count is null or effect_count<0 or effect_count>130048
 or final_digest is null or final_digest !~ '^[0-9a-f]{64}$' or octet_length(req::text)>1048576 then
 raise exception 'unsupported local staged contract' using errcode='22023';end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=(req->>'userId')::uuid;
 if not found or h.epoch is distinct from (req->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'owner/generation mismatch' using errcode='42501';end if;
 insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at)
 values(stage_id,h.user_id,h.id,req,effect_count,final_digest,clock_timestamp()+interval '1 hour') on conflict(id) do nothing;
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id for update;
 if s.family is distinct from 'first_party_abandon' or s.authority is distinct from '{}'::jsonb or s.request is distinct from req or s.effect_count is distinct from effect_count or s.final_digest is distinct from final_digest then
 raise exception 'stage identity collision' using errcode='23505';end if;
 if s.expires_at<=clock_timestamp() and s.result is null then raise exception 'expired stage' using errcode='22023';end if;
 return jsonb_build_object('nextOrdinal',s.next_ordinal,'result',s.result);
end$$;

create function pjsdas_rows_candidate.large_append(stage_id uuid,target_user_id uuid,parts jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype;p jsonb;seq integer;raw text;digest text;bytes bigint;prior pjsdas_rows_candidate.large_effect%rowtype;
begin
 if jsonb_typeof(parts) is distinct from 'array' or jsonb_array_length(parts)>127 or octet_length(parts::text)>262144 then raise exception 'invalid page' using errcode='22023';end if;
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id for update;
 if not found or s.user_id is distinct from target_user_id then raise exception 'stage owner mismatch' using errcode='42501';end if;
 if s.result is not null or s.expires_at<=clock_timestamp() then raise exception 'stage sealed/expired' using errcode='22023';end if;
 for p in select value from jsonb_array_elements(parts) loop
  if jsonb_typeof(p->'ordinal') is distinct from 'number' or (p->>'ordinal') !~ '^(0|[1-9][0-9]*)$' or jsonb_typeof(p->'wire') is distinct from 'string' then raise exception 'invalid part' using errcode='22023';end if;
  seq:=(p->>'ordinal')::integer;raw:=p->>'wire';bytes:=octet_length(raw);digest:=encode(sha256(convert_to(raw,'UTF8')),'hex');
  if seq<s.next_ordinal then
   select * into prior from pjsdas_rows_candidate.large_effect where large_effect.stage_id=s.id and ordinal=seq;
   if not found or prior.wire is distinct from raw then raise exception 'changed repeated part' using errcode='23505';end if;
   continue;
  end if;
  if seq<>s.next_ordinal or seq>=s.effect_count or s.received_bytes+bytes>134217728 then raise exception 'stage gap/resource admission' using errcode='22023';end if;
  insert into pjsdas_rows_candidate.large_effect values(s.id,seq,raw,digest,raw::jsonb);
  s.rolling_digest:=encode(sha256(convert_to(s.rolling_digest||digest,'UTF8')),'hex');
  s.next_ordinal:=s.next_ordinal+1;s.received_bytes:=s.received_bytes+bytes;
 end loop;
 update pjsdas_rows_candidate.large_stage set next_ordinal=s.next_ordinal,rolling_digest=s.rolling_digest,received_bytes=s.received_bytes where id=s.id;
 return jsonb_build_object('nextOrdinal',s.next_ordinal);
end$$;
-- Revalidate persisted bytes, parsed effect and the complete ordered chain under
-- the stage lock. Cached upload counters alone are not integrity evidence.
create function pjsdas_rows_internal.verify_staged_effects(target_stage uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype;e pjsdas_rows_candidate.large_effect%rowtype;
 n integer:=0;total_bytes bigint:=0;digest text:=repeat('0',64);part_hash text;
begin
 select * into s from pjsdas_rows_candidate.large_stage where id=target_stage for update;
 if not found then raise exception 'missing effect stream' using errcode='22023';end if;
 for e in select * from pjsdas_rows_candidate.large_effect where stage_id=target_stage order by ordinal for share loop
  part_hash:=encode(sha256(convert_to(e.wire,'UTF8')),'hex');
  if e.ordinal<>n or e.digest is distinct from part_hash or e.effect is distinct from e.wire::jsonb then
   raise exception 'persisted effect integrity mismatch' using errcode='22023';end if;
  digest:=encode(sha256(convert_to(digest||part_hash,'UTF8')),'hex');
  total_bytes:=total_bytes+octet_length(e.wire);n:=n+1;
 end loop;
 if n<>s.effect_count or n<>s.next_ordinal or total_bytes<>s.received_bytes or digest is distinct from s.final_digest or digest is distinct from s.rolling_digest then
  raise exception 'persisted effect chain mismatch' using errcode='22023';end if;
end$$;
revoke all on function pjsdas_rows_internal.verify_staged_effects(uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.verify_staged_effects(uuid) to service_role;

create function pjsdas_rows_internal.apply_staged_rows(req jsonb,target_stage uuid,trusted_receipt_context jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare h pjsdas_rows_candidate.head%rowtype;original jsonb;c jsonb;actual_before jsonb;n integer:=0;r jsonb;
begin
 if req->>'contract' is distinct from 'workspace-rows-v1'
 or jsonb_typeof(req->'commandId') is distinct from 'string' or nullif(req->>'commandId','') is null or coalesce(req->>'payloadHash','') !~ '^[0-9a-f]{64}$'
 then raise exception 'invalid narrow request' using errcode='22023';end if;
 if (req ? 'receiptContext' and req->'receiptContext' is distinct from 'null'::jsonb and jsonb_typeof(req->'receiptContext') is distinct from 'object')
 or (req ? 'provenance' and req->'provenance' is distinct from 'null'::jsonb and jsonb_typeof(req->'provenance') is distinct from 'object')
 or jsonb_typeof(trusted_receipt_context) is distinct from 'object' then
 raise exception 'invalid command audit metadata' using errcode='22023';end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid for update;
 if not found or h.user_id is distinct from (req->>'userId')::uuid then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'unsupported generation' using errcode='PT409';end if;
 perform pjsdas_rows_internal.verify_staged_effects(target_stage);
 original:=pjsdas_rows_internal.original_command(h.id,h.user_id,req->>'commandId');
 if original is not null then
  if original->>'payloadHash' is distinct from req->>'payloadHash' then raise exception 'command payload differs' using errcode='23505';end if;
  return jsonb_build_object('outcome','ALREADY_APPLIED','revision',original->'revision','receipt',original->'receipt');
 end if;
 if h.revision is distinct from (req->>'expectedRevision')::bigint or h.epoch is distinct from (req->>'expectedEpoch')::uuid then
  return jsonb_build_object('outcome','CONFLICT','revision',h.revision);end if;
 if h.format is distinct from 'workspace-rows-v1' then raise exception 'unsupported layout' using errcode='PT409';end if;
 if jsonb_typeof(req#>'{afterEnvelope,version}') is distinct from 'number'
 or (req#>>'{afterEnvelope,version}') !~ '^[1-9][0-9]*$'
 or (req#>>'{afterEnvelope,version}')::numeric<h.schema_version
 or (req ? 'schemaVersion' and req->'schemaVersion' is distinct from req#>'{afterEnvelope,version}') then
 raise exception 'invalid schema version or downgrade' using errcode='22023';end if;
 if h.envelope is distinct from req->'beforeEnvelope' or h.manifest is distinct from req->'beforeManifest' then raise exception 'preimage metadata mismatch' using errcode='PT409';end if;
 if exists(select 1 from pjsdas_rows_candidate.large_effect where stage_id=target_stage group by effect->>'collection',effect->>'id' having count(*)>1) then raise exception 'duplicate effect key' using errcode='22023';end if;
 -- One indexed preimage relation, not one SPI SELECT/UPSERT per entity. Keep
 -- every original shape/preimage check before set-based DML; head lock, final
 -- manifest and deferred ordering constraints still protect the one transaction.
 -- Scope both relations once and extract effect keys once. With stale
 -- single-owner statistics, the old join estimated 1 row but scanned 2100
 -- preimages per effect, repeatedly detoasting JSONB until the 10s timeout.
 -- These materialization fences do not change any row/shape/preimage check,
 -- head/stage lock, effect identity, work_mem or request deadline.
 for c,actual_before in
  with effects as materialized (
   select effect,ordinal,effect->>'collection' collection,effect->>'id' id
   from pjsdas_rows_candidate.large_effect where stage_id=target_stage
  ), preimages as materialized (
   select collection,id,ordinal,value from pjsdas_rows_candidate.item where workspace_id=h.id
  )
  select e.effect,case when i.id is null then 'null'::jsonb else jsonb_build_object('collection',i.collection,'id',i.id,'ordinal',i.ordinal,'value',i.value) end
  from effects e left join preimages i on i.collection=e.collection and i.id=e.id order by e.ordinal
 loop
  if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'collection') is distinct from 'string' or jsonb_typeof(c->'id') is distinct from 'string' or (c-array['collection','id','before','after'])<>'{}'::jsonb or not (c ?& array['collection','id','before','after']) then raise exception 'invalid effect' using errcode='22023';end if;
  if actual_before is distinct from c->'before' then raise exception 'row preimage mismatch' using errcode='PT409';end if;
  if c->'after'<>'null'::jsonb then
   if jsonb_typeof(c->'after') is distinct from 'object' or jsonb_typeof(c#>'{after,id}') is distinct from 'string' or jsonb_typeof(c#>'{after,collection}') is distinct from 'string' or ((c->'after')-array['collection','id','ordinal','value'])<>'{}'::jsonb
    or c#>>'{after,collection}' is distinct from c->>'collection' or c#>>'{after,id}' is distinct from c->>'id'
    or jsonb_typeof(c#>'{after,ordinal}') is distinct from 'number' or not (c#>>'{after,ordinal}' ~ '^(0|[1-9][0-9]*)$') then raise exception 'invalid after row' using errcode='22023';end if;
  end if;
  n:=n+1;
 end loop;
 -- The deletion relation needs the same scalar-key fence: stale owner
 -- statistics must not repeatedly extract/detoast effect JSONB per target row.
 -- This remains after ALL original preimage checks, with the same key/scope.
 with deletions as materialized (
  select effect->>'collection' collection,effect->>'id' id
  from pjsdas_rows_candidate.large_effect where stage_id=target_stage and effect->'after'='null'::jsonb
 )
 delete from pjsdas_rows_candidate.item i using deletions d
  where i.workspace_id=h.id and i.collection=d.collection and i.id=d.id;
 insert into pjsdas_rows_candidate.item(workspace_id,user_id,collection,id,ordinal,value,updated_revision)
  select h.id,h.user_id,e.effect->>'collection',e.effect->>'id',(e.effect#>>'{after,ordinal}')::bigint,e.effect#>'{after,value}',h.revision+1
  from pjsdas_rows_candidate.large_effect e where e.stage_id=target_stage and e.effect->'after'<>'null'::jsonb order by e.ordinal
  on conflict(workspace_id,collection,id) do update set ordinal=excluded.ordinal,value=excluded.value,updated_revision=excluded.updated_revision;
 update pjsdas_rows_candidate.head set revision=h.revision+1,envelope=req->'afterEnvelope',manifest=req->'afterManifest',schema_version=(req#>>'{afterEnvelope,version}')::integer where id=h.id;
 if pjsdas_rows_candidate.valid_state(h.id) is not true then raise exception 'incomplete collection manifest' using errcode='22023';end if;
 r:=coalesce(nullif(req->'receiptContext','null'::jsonb),'{}'::jsonb) || trusted_receipt_context || jsonb_build_object('commandId',req->>'commandId','receiptId','command-receipt:'||(req->>'commandId'),'status','COMMITTED','operation',req->>'operation','revision',h.revision+1,'committedAt',now(),'undoAvailable',req->'compensation' is not null and req->'compensation' is distinct from 'null'::jsonb);
 insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest,principal_kind,client_id,provenance,expected_revision,effective_time)
 values(h.id,h.user_id,req->>'commandId',req->>'payloadHash',h.revision+1,r,coalesce(req->'compensation','null'::jsonb),(select final_digest from pjsdas_rows_candidate.large_stage where id=target_stage),req->>'principal',req->>'clientId',coalesce(nullif(req->'provenance','null'::jsonb),'{}'::jsonb),(req->>'expectedRevision')::bigint,(req->>'effectiveTime')::timestamptz);
 -- Never commit an immutable audit row that the bounded logical history reader
 -- cannot later return. Projection overhead is conservatively included.
 if (select octet_length((to_jsonb(l)-'effect_digest')::text)+octet_length(to_jsonb(l.receipt->>'operation')::text)+64>2097150
     from pjsdas_rows_candidate.ledger l where l.workspace_id=h.id and l.command_id=req->>'commandId') then
  if req->>'auditReadProtocol' is distinct from 'workspace-audit-bytes-v1' then raise exception 'audit record exceeds candidate read eligibility' using errcode='22023';end if;
  perform pjsdas_rows_internal.assert_large_audit_readable(req,h.id,h.user_id);
 end if;
 return jsonb_build_object('outcome','COMMITTED','revision',h.revision+1,'receipt',r);
end$$;

-- Finalization is one transaction. No business row/revision/receipt is changed by
-- upload. This proof intentionally supports no delegated/Gmail/discovery family.
create function pjsdas_rows_candidate.large_finish(stage_id uuid,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype;h pjsdas_rows_candidate.head%rowtype;original jsonb;r jsonb;
begin
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id;
 if not found or s.user_id is distinct from target_user_id or s.family is distinct from 'first_party_abandon' then raise exception 'stage owner/family mismatch' using errcode='42501';end if;
 -- Finalizers share workspace -> stage order; upload takes only the stage lock.
 select * into h from pjsdas_rows_candidate.head where id=s.workspace_id and user_id=target_user_id for update;
 if not found or h.epoch is distinct from (s.request->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'generation mismatch' using errcode='42501';end if;
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id for update;
 if not found or s.user_id is distinct from target_user_id or s.workspace_id is distinct from h.id or s.family is distinct from 'first_party_abandon' then raise exception 'stage owner/family mismatch' using errcode='42501';end if;
 if s.request->>'principal' is distinct from 'first_party_web' or coalesce(s.request->>'operation','') not in ('abandon_opportunity','domain:abandon_opportunity','undo_command')
 or s.request->>'clientId' is not null
 or coalesce(s.request->'receiptContext','{}'::jsonb) ? 'managementAuthorization'
 or s.request ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then raise exception 'unsupported authority' using errcode='42501';end if;
 if s.request->>'operation'='undo_command' then
  original:=pjsdas_rows_internal.original_command(h.id,h.user_id,s.request#>>'{provenance,undoOf}');
  if original is null or coalesce(original#>>'{receipt,operation}','') not in ('abandon_opportunity','domain:abandon_opportunity') then raise exception 'wrong undo authority' using errcode='42501';end if;
 end if;
 if s.result is not null then return s.result;end if;
 if s.expires_at<=clock_timestamp() or s.next_ordinal<>s.effect_count or s.rolling_digest<>s.final_digest then raise exception 'incomplete/expired/digest mismatch' using errcode='22023';end if;
 r:=pjsdas_rows_internal.apply_staged_rows(s.request,s.id);
 if r->>'outcome' in ('COMMITTED','ALREADY_APPLIED') then update pjsdas_rows_candidate.large_stage set result=r where id=s.id;end if;
 return r;
end$$;
revoke all on function pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb) to service_role;
revoke all on function pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text),pjsdas_rows_candidate.large_append(uuid,uuid,jsonb),pjsdas_rows_candidate.large_finish(uuid,uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text),pjsdas_rows_candidate.large_append(uuid,uuid,jsonb),pjsdas_rows_candidate.large_finish(uuid,uuid) to service_role;

-- Read prototype: byte fragments avoid rejecting a retained individual audit
-- document solely because it exceeds the old response page. No new production
-- API. Each call binds the same owner/epoch/revision; the client checks final
-- fence and complete digest before publishing its provisional spool.
create function pjsdas_rows_candidate.large_read_fragment(req jsonb) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog as $$
declare h pjsdas_rows_candidate.head%rowtype;doc jsonb;bytes bytea;pos bigint;key text;
begin
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid and user_id=(req->>'userId')::uuid;
 if not found then raise exception 'owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'epoch')::uuid or h.revision is distinct from (req->>'revision')::bigint or h.format is distinct from 'workspace-rows-v1' then raise exception 'generation/revision changed' using errcode='PT409';end if;
 if jsonb_typeof(req->'offset') is distinct from 'number' or (req->>'offset') !~ '^(0|[1-9][0-9]*)$' then raise exception 'invalid offset' using errcode='22023';end if;
 pos:=(req->>'offset')::bigint;key:=req->>'documentKey';
 if req->>'mode'='audit' then
  select to_jsonb(l)-'effect_digest' into doc from pjsdas_rows_candidate.ledger l where l.workspace_id=h.id and l.user_id=h.user_id and l.command_id=key;
 elsif req->>'mode'='envelope' and key='envelope' then doc:=h.envelope;
 elsif req->>'mode'='entity' then
  select jsonb_build_object('collection',collection,'id',id,'ordinal',ordinal,'value',value) into doc from pjsdas_rows_candidate.item where workspace_id=h.id and user_id=h.user_id and collection=req->>'collection' and id=key;
 else raise exception 'unknown document mode' using errcode='22023';end if;
 if doc is null then raise exception 'document missing' using errcode='22023';end if;
 bytes:=convert_to(doc::text,'UTF8');if pos>octet_length(bytes) then raise exception 'offset beyond end' using errcode='22023';end if;
 return jsonb_build_object('offset',pos,'totalBytes',octet_length(bytes),'base64',replace(encode(substring(bytes from (pos+1)::integer for 65536),'base64'),E'\n',''),
 'sha256',case when pos=0 then encode(sha256(bytes),'hex') else null end,'revision',h.revision,'epoch',h.epoch,'documentKey',key);
end$$;
revoke all on function pjsdas_rows_candidate.large_read_fragment(jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.large_read_fragment(jsonb) to service_role;

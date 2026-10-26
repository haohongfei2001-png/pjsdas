-- LOCAL SYNTHETIC CANDIDATE ONLY. Not a migration, exposed-schema change, quota,
-- or production admission policy. Requires the existing effect and v3 prototypes.
-- A fixture owner pre-reserves document bytes. service_role cannot mint a
-- reservation. Global admission, retention, cleanup and giant reads remain gates.
create table pjsdas_rows_candidate.large_document_reservation (
 stage_id uuid primary key, user_id uuid not null, workspace_id uuid not null,
 reserved_bytes bigint not null check(reserved_bytes>0), expires_at timestamptz not null,
 foreign key(workspace_id,user_id) references pjsdas_rows_candidate.head(id,user_id)
);
create table pjsdas_rows_candidate.large_document_bundle (
 stage_id uuid primary key references pjsdas_rows_candidate.large_stage(id),
 manifest_wire text not null, manifest_sha256 text not null, manifest jsonb not null,
 next_offsets jsonb not null default '{"metadata":0,"beforeEnvelope":0,"afterEnvelope":0,"compensation":0}'::jsonb,
 foreign key(stage_id) references pjsdas_rows_candidate.large_document_reservation(stage_id)
);
create table pjsdas_rows_candidate.large_document_fragment (
 stage_id uuid not null references pjsdas_rows_candidate.large_document_bundle(stage_id),
 document_name text not null, byte_offset bigint not null check(byte_offset>=0), bytes bytea not null,
 primary key(stage_id,document_name,byte_offset)
);
alter table pjsdas_rows_candidate.large_document_reservation enable row level security;
alter table pjsdas_rows_candidate.large_document_bundle enable row level security;
alter table pjsdas_rows_candidate.large_document_fragment enable row level security;
revoke all on pjsdas_rows_candidate.large_document_reservation,pjsdas_rows_candidate.large_document_bundle,pjsdas_rows_candidate.large_document_fragment from public,anon,authenticated,service_role;
grant select on pjsdas_rows_candidate.large_document_reservation to service_role;
grant select,insert,update,delete on pjsdas_rows_candidate.large_document_bundle,pjsdas_rows_candidate.large_document_fragment to service_role;

create function pjsdas_rows_candidate.large_documents_check_reservation(stage_id uuid,target_user_id uuid,target_workspace_id uuid,required_bytes bigint) returns boolean
language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if required_bytes is null or required_bytes<1 or not exists(
  select 1 from pjsdas_rows_candidate.large_document_reservation r where r.stage_id=large_documents_check_reservation.stage_id
  and r.user_id=target_user_id and r.workspace_id=target_workspace_id and r.reserved_bytes>=required_bytes
  and (r.expires_at>clock_timestamp() or exists(select 1 from pjsdas_rows_candidate.large_stage s where s.id=r.stage_id and s.result is not null))
 ) then raise exception 'prior document resource reservation required' using errcode='42501';end if;
 return true;
end$$;

create function pjsdas_rows_candidate.large_documents_begin(manifest_wire text,manifest_sha256 text,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare m jsonb;b jsonb;d jsonb;r pjsdas_rows_candidate.large_document_reservation%rowtype;
 s pjsdas_rows_candidate.large_stage%rowtype;bundle pjsdas_rows_candidate.large_document_bundle%rowtype;
 h pjsdas_rows_candidate.head%rowtype;document_stage_id uuid;inserted_count integer;total bigint:=0;n integer:=0;names text[]:=array['metadata','beforeEnvelope','afterEnvelope','compensation'];req jsonb;
begin
 if manifest_wire is null or octet_length(manifest_wire)>32768 or manifest_sha256 is null or manifest_sha256 !~ '^[a-f0-9]{64}$'
 or encode(sha256(convert_to(manifest_wire,'UTF8')),'hex') is distinct from manifest_sha256 then raise exception 'invalid manifest bytes' using errcode='22023';end if;
 m:=manifest_wire::jsonb;b:=m->'binding';
 if jsonb_typeof(m) is distinct from 'object' or (m-array['protocol','binding','effects','documents'])<>'{}'::jsonb
 or m->>'protocol' is distinct from 'workspace-staged-documents-v1' or jsonb_typeof(b) is distinct from 'object'
 or b->>'family' not in ('first_party_abandon','opportunity_v3') or b->>'family' is null
 or (b->>'userId')::uuid is distinct from target_user_id
 or (b->>'stageId') is null or (b->>'workspaceId') is null or (b->>'expectedEpoch') is null
 or jsonb_typeof(b->'expectedRevision') is distinct from 'number' or (b->>'expectedRevision') !~ '^(0|[1-9][0-9]*)$'
 or nullif(b->>'commandId','') is null or coalesce(b->>'payloadHash','') !~ '^[a-f0-9]{64}$'
 or m#>>'{effects,protocol}' is distinct from 'workspace-effect-chain-v1'
 or jsonb_typeof(m#>'{effects,count}') is distinct from 'number' or (m#>>'{effects,count}') !~ '^(0|[1-9][0-9]*)$'
 or (m#>>'{effects,count}')::numeric>130048 or coalesce(m#>>'{effects,sha256}','') !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(m->'documents') is distinct from 'array' or jsonb_array_length(m->'documents')<>4 then raise exception 'invalid local document contract' using errcode='22023';end if;
 if b->>'family'='first_party_abandon' then
  if b->>'principal' is distinct from 'first_party_web' or b->>'operation' not in ('abandon_opportunity','domain:abandon_opportunity','undo_command') or b->>'operation' is null
  or b->'authority' is distinct from '{}'::jsonb then raise exception 'unsupported first-party document family' using errcode='42501';end if;
 else
  if b->>'principal' is distinct from 'delegated_mcp' or b->>'operation' not in ('opportunity_management','undo_command') or b->>'operation' is null
  or jsonb_typeof(b->'authority') is distinct from 'object' or (b#>'{authority,grantId}') is null
  or jsonb_typeof(b#>'{authority,grantRevision}') is distinct from 'number' or (b#>>'{authority,grantRevision}') !~ '^[1-9][0-9]*$'
  or nullif(trim(b#>>'{authority,clientId}'),'') is null then raise exception 'unsupported v3 document family' using errcode='42501';end if;
  perform (b#>>'{authority,grantId}')::uuid;
 end if;
 for d in select value from jsonb_array_elements(m->'documents') loop
  n:=n+1;
  if jsonb_typeof(d) is distinct from 'object' or d->>'name' is distinct from names[n]
  or jsonb_typeof(d->'bytes') is distinct from 'number' or (d->>'bytes') !~ '^[1-9][0-9]*$'
  or coalesce(d->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid document directory' using errcode='22023';end if;
  total:=total+(d->>'bytes')::bigint;
 end loop;
 document_stage_id:=(b->>'stageId')::uuid;
 select * into r from pjsdas_rows_candidate.large_document_reservation where stage_id=document_stage_id;
 if not found or r.user_id is distinct from target_user_id or r.workspace_id is distinct from (b->>'workspaceId')::uuid
 or r.reserved_bytes<total then raise exception 'document resource reservation required' using errcode='42501';end if;
 select * into h from pjsdas_rows_candidate.head where id=r.workspace_id and user_id=target_user_id;
 if not found or h.epoch is distinct from (b->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'document generation mismatch' using errcode='PT409';end if;
 -- Until verified finalization, the marker rejects BOTH original finish entries.
 req:=b-array['stageId','family','authority'];
 insert into pjsdas_rows_candidate.large_stage(id,user_id,workspace_id,request,effect_count,final_digest,expires_at,family,authority)
 values(document_stage_id,r.user_id,r.workspace_id,req,(m#>>'{effects,count}')::integer,m#>>'{effects,sha256}',r.expires_at,'documents:'||(b->>'family'),b->'authority') on conflict(id) do nothing;
 get diagnostics inserted_count=row_count;
 if inserted_count=0 and not exists(select 1 from pjsdas_rows_candidate.large_document_bundle where stage_id=document_stage_id) then
  raise exception 'cannot attach documents to an unrelated old stage' using errcode='23505';end if;
 select * into s from pjsdas_rows_candidate.large_stage where large_stage.id=document_stage_id for update;
 if s.user_id is distinct from target_user_id or s.workspace_id is distinct from r.workspace_id
 or s.family not in ('documents:'||(b->>'family'),b->>'family') or s.authority is distinct from b->'authority'
 then raise exception 'document stage authority collision' using errcode='42501';end if;
 if s.request->'commandId' is distinct from b->'commandId' or s.request->'payloadHash' is distinct from b->'payloadHash' then raise exception 'command payload differs' using errcode='23505';end if;
 if s.effect_count is distinct from (m#>>'{effects,count}')::integer or s.final_digest is distinct from m#>>'{effects,sha256}'
 then raise exception 'original prepared effect intent required' using errcode='PT409';end if;
 insert into pjsdas_rows_candidate.large_document_bundle(stage_id,manifest_wire,manifest_sha256,manifest)
 values(document_stage_id,manifest_wire,manifest_sha256,m) on conflict(stage_id) do nothing;
 select * into bundle from pjsdas_rows_candidate.large_document_bundle where stage_id=document_stage_id for update;
 if bundle.manifest_wire is distinct from manifest_wire or bundle.manifest_sha256 is distinct from manifest_sha256 then
  if bundle.manifest#>'{binding,payloadHash}' is distinct from b->'payloadHash' then raise exception 'command payload differs' using errcode='23505';end if;
  -- The same command may have been re-evaluated with a different clock. That
  -- is an immutable draft conflict, not evidence of a different command payload.
  raise exception 'original prepared document intent required' using errcode='PT409';
 end if;
 if s.result is null and (s.expires_at<=clock_timestamp() or r.expires_at<=clock_timestamp()) then raise exception 'expired document reservation' using errcode='22023';end if;
 -- Upload status is NOT a receipt/replay authority endpoint.
 return jsonb_build_object('stageId',document_stage_id,'manifestSha256',manifest_sha256,'completed',s.result is not null,'nextOffsets',bundle.next_offsets);
end$$;

create function pjsdas_rows_candidate.large_documents_append(part jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare s pjsdas_rows_candidate.large_stage%rowtype;b pjsdas_rows_candidate.large_document_bundle%rowtype;
 d jsonb;document_stage_id uuid;name text;off bigint;next_off bigint;raw bytea;prior bytea;expected bigint;
begin
 if jsonb_typeof(part) is distinct from 'object' or octet_length(part::text)>90000
 or jsonb_typeof(part->'offset') is distinct from 'number' or (part->>'offset') !~ '^(0|[1-9][0-9]*)$'
 or jsonb_typeof(part->'base64') is distinct from 'string' then raise exception 'invalid document fragment' using errcode='22023';end if;
 document_stage_id:=(part->>'stageId')::uuid;name:=part->>'document';off:=(part->>'offset')::bigint;
 select * into s from pjsdas_rows_candidate.large_stage where large_stage.id=document_stage_id for update;
 if not found or s.user_id is distinct from target_user_id then raise exception 'document owner mismatch' using errcode='42501';end if;
 if s.result is not null or s.expires_at<=clock_timestamp() then raise exception 'sealed/expired document stage' using errcode='22023';end if;
 select * into b from pjsdas_rows_candidate.large_document_bundle where stage_id=document_stage_id for update;
 if not found or b.manifest_sha256 is distinct from part->>'manifestSha256' then raise exception 'document context mismatch' using errcode='42501';end if;
 select value into d from jsonb_array_elements(b.manifest->'documents') where value->>'name'=name;
 if not found or off%65536<>0 then raise exception 'invalid document offset' using errcode='22023';end if;
 raw:=decode(part->>'base64','base64');expected:=least(65536,(d->>'bytes')::bigint-off);next_off:=(b.next_offsets->>name)::bigint;
 -- PostgreSQL base64 inserts line breaks; remove only its generated newlines,
 -- never accept whitespace or alternate encodings supplied by the caller.
 if replace(encode(raw,'base64'),E'\n','') is distinct from part->>'base64' or octet_length(raw)=0
 or octet_length(raw)<>expected then raise exception 'invalid document fragment bytes' using errcode='22023';end if;
 if off<next_off then
  select bytes into prior from pjsdas_rows_candidate.large_document_fragment where stage_id=document_stage_id and document_name=name and byte_offset=off;
  if not found or prior is distinct from raw then raise exception 'changed repeated document fragment' using errcode='23505';end if;
 else
  if off<>next_off then raise exception 'document fragment gap' using errcode='22023';end if;
  insert into pjsdas_rows_candidate.large_document_fragment values(document_stage_id,name,off,raw);
  next_off:=next_off+octet_length(raw);
  update pjsdas_rows_candidate.large_document_bundle set next_offsets=jsonb_set(next_offsets,array[name],to_jsonb(next_off)) where stage_id=document_stage_id;
 end if;
 return jsonb_build_object('stageId',document_stage_id,'manifestSha256',b.manifest_sha256,'document',name,'nextOffset',next_off);
end$$;

-- Private reconstruction primitive. Caller already holds original authority,
-- head and large_stage locks. This returns request bytes, NEVER a receipt.
create function pjsdas_rows_internal.large_documents_request(target_stage uuid,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare b pjsdas_rows_candidate.large_document_bundle%rowtype;d jsonb;raw bytea;v jsonb;values_by_name jsonb:='{}'::jsonb;req jsonb;key text;
begin
 select bundle.* into b from pjsdas_rows_candidate.large_document_bundle bundle join pjsdas_rows_candidate.large_stage s on s.id=bundle.stage_id
 where bundle.stage_id=target_stage and s.user_id=target_user_id for update of bundle;
 if not found then raise exception 'document stage absent' using errcode='42501';end if;
 if encode(sha256(convert_to(b.manifest_wire,'UTF8')),'hex') is distinct from b.manifest_sha256 or b.manifest_wire::jsonb is distinct from b.manifest then raise exception 'document manifest changed' using errcode='22023';end if;
 for d in select value from jsonb_array_elements(b.manifest->'documents') loop
  if b.next_offsets->>(d->>'name') is distinct from d->>'bytes' then raise exception 'incomplete staged document' using errcode='22023';end if;
  select string_agg(bytes,''::bytea order by byte_offset) into raw from pjsdas_rows_candidate.large_document_fragment where stage_id=target_stage and document_name=d->>'name';
  if raw is null or octet_length(raw)<>(d->>'bytes')::bigint or encode(sha256(raw),'hex') is distinct from d->>'sha256' then raise exception 'document digest mismatch' using errcode='22023';end if;
  v:=convert_from(raw,'UTF8')::jsonb;values_by_name:=jsonb_set(values_by_name,array[d->>'name'],v);
 end loop;
 req:=values_by_name->'metadata';
 if jsonb_typeof(req) is distinct from 'object' or req ?| array['changes','beforeEnvelope','afterEnvelope','compensation']
 or jsonb_typeof(values_by_name->'beforeEnvelope') is distinct from 'object' or jsonb_typeof(values_by_name->'afterEnvelope') is distinct from 'object'
 then raise exception 'invalid reconstructed request' using errcode='22023';end if;
 foreach key in array array['userId','workspaceId','expectedEpoch','expectedRevision','commandId','payloadHash','operation','principal'] loop
  if req->key is distinct from b.manifest#>array['binding',key] then raise exception 'request binding mismatch' using errcode='42501';end if;
 end loop;
 return req||jsonb_build_object('beforeEnvelope',values_by_name->'beforeEnvelope','afterEnvelope',values_by_name->'afterEnvelope','compensation',values_by_name->'compensation');
end$$;

create function pjsdas_rows_candidate.large_documents_finish(stage_id uuid,target_user_id uuid,manifest_sha256 text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare b pjsdas_rows_candidate.large_document_bundle%rowtype;s pjsdas_rows_candidate.large_stage%rowtype;
 h pjsdas_rows_candidate.head%rowtype;binding jsonb;req jsonb;document_family text;
begin
 -- Read identity without taking a stage lock. Never reverse original locks.
 select * into b from pjsdas_rows_candidate.large_document_bundle where large_document_bundle.stage_id=large_documents_finish.stage_id;
 if not found or b.manifest_sha256 is distinct from manifest_sha256 or (b.manifest#>>'{binding,userId}')::uuid is distinct from target_user_id then raise exception 'document identity mismatch' using errcode='42501';end if;
 binding:=b.manifest->'binding';document_family:=binding->>'family';
 if document_family='opportunity_v3' then
  -- Lock only the ORIGINAL grant ID. The unmodified v3 guard below performs
  -- every original owner/client/version/capability/consent/revocation check.
  perform 1 from public.pjsdas_business_management_grants where id=(binding#>>'{authority,grantId}')::uuid for share;
 elsif document_family is distinct from 'first_party_abandon' then raise exception 'unsupported document finalizer' using errcode='42501';end if;
 select * into h from pjsdas_rows_candidate.head where id=(binding->>'workspaceId')::uuid and user_id=target_user_id for update;
 if not found or h.epoch is distinct from (binding->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'document generation mismatch' using errcode='PT409';end if;
 select * into s from pjsdas_rows_candidate.large_stage where id=stage_id for update;
 if not found or s.user_id is distinct from target_user_id or s.workspace_id is distinct from h.id
 or s.family not in ('documents:'||document_family,document_family) or s.authority is distinct from binding->'authority'
 then raise exception 'document family mismatch' using errcode='42501';end if;
 select * into b from pjsdas_rows_candidate.large_document_bundle where large_document_bundle.stage_id=large_documents_finish.stage_id for update;
 if not found or b.manifest_sha256 is distinct from manifest_sha256 or b.manifest->'binding' is distinct from binding then
  raise exception 'document identity changed while waiting' using errcode='42501';end if;
 if s.result is null then
  if s.expires_at<=clock_timestamp() then raise exception 'expired document stage after locks' using errcode='22023';end if;
  req:=pjsdas_rows_internal.large_documents_request(stage_id,target_user_id);
  -- This is still inside the ONE finalization transaction, not a business
  -- commit. Any later authorization/effect/preimage failure rolls it back.
  update pjsdas_rows_candidate.large_stage set request=req,family=document_family where id=stage_id;
 end if;
 -- Original finalizers preserve the original complete semantic guards,
 -- authority-before-replay, CAS, Undo family and immutable V5 receipt evidence.
 if document_family='opportunity_v3' then return pjsdas_rows_candidate.large_finish_opportunity(stage_id,target_user_id);end if;
 return pjsdas_rows_candidate.large_finish(stage_id,target_user_id);
end$$;

revoke all on function pjsdas_rows_candidate.large_documents_begin(text,text,uuid),pjsdas_rows_candidate.large_documents_append(jsonb,uuid),pjsdas_rows_candidate.large_documents_finish(uuid,uuid,text),pjsdas_rows_internal.large_documents_request(uuid,uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.large_documents_begin(text,text,uuid),pjsdas_rows_candidate.large_documents_append(jsonb,uuid),pjsdas_rows_candidate.large_documents_finish(uuid,uuid,text),pjsdas_rows_internal.large_documents_request(uuid,uuid) to service_role;

-- Existing public schema only. All wrappers remain INVOKER, service-only; none
-- mints reservations or authorizes arbitrary command families.
create function public.pjsdas_rows_v1_large_documents_check_reservation(stage_id uuid,target_user_id uuid,target_workspace_id uuid,required_bytes bigint) returns boolean
language plpgsql stable security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null); return pjsdas_rows_candidate.large_documents_check_reservation(stage_id,target_user_id,target_workspace_id,required_bytes);end $$;
create function public.pjsdas_rows_v1_large_documents_begin(manifest_wire text,manifest_sha256 text,target_user_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,(manifest_wire::jsonb#>>'{binding,expectedEpoch}')::uuid);return pjsdas_rows_candidate.large_documents_begin(manifest_wire,manifest_sha256,target_user_id);end $$;
create function public.pjsdas_rows_v1_large_documents_append(part jsonb,target_user_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);return pjsdas_rows_candidate.large_documents_append(part,target_user_id);end $$;
create function public.pjsdas_rows_v1_large_documents_finish(stage_id uuid,target_user_id uuid,manifest_sha256 text) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);return pjsdas_rows_candidate.large_documents_finish(stage_id,target_user_id,manifest_sha256);end $$;
create function public.pjsdas_rows_v1_large_append(stage_id uuid,target_user_id uuid,parts jsonb) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);return pjsdas_rows_candidate.large_append(stage_id,target_user_id,parts);end $$;
revoke all on function pjsdas_rows_candidate.large_documents_check_reservation(uuid,uuid,uuid,bigint),public.pjsdas_rows_v1_large_documents_check_reservation(uuid,uuid,uuid,bigint),public.pjsdas_rows_v1_large_documents_begin(text,text,uuid),public.pjsdas_rows_v1_large_documents_append(jsonb,uuid),public.pjsdas_rows_v1_large_documents_finish(uuid,uuid,text),public.pjsdas_rows_v1_large_append(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.large_documents_check_reservation(uuid,uuid,uuid,bigint),public.pjsdas_rows_v1_large_documents_check_reservation(uuid,uuid,uuid,bigint),public.pjsdas_rows_v1_large_documents_begin(text,text,uuid),public.pjsdas_rows_v1_large_documents_append(jsonb,uuid),public.pjsdas_rows_v1_large_documents_finish(uuid,uuid,text),public.pjsdas_rows_v1_large_append(uuid,uuid,jsonb) to service_role;

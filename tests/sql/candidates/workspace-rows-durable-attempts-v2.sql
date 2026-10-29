-- LOCAL DEFAULT-OFF OVERLAY; install after original durable/audit/resource RPC.
-- No production migration, reservation mint, capacity/retention extension or reclaim.
alter table pjsdas_rows_candidate.large_command_intent add column protocol text not null default 'workspace-prepared-intent-v1';
alter table pjsdas_rows_candidate.large_command_intent alter column deadline_at drop not null;
alter table pjsdas_rows_candidate.large_command_intent add check(
 (protocol='workspace-prepared-intent-v1' and deadline_at is not null) or (protocol='workspace-prepared-intent-v2' and deadline_at is null));
alter table ta_resource_reservations.reservation add column intent_protocol text not null default 'workspace-prepared-intent-v1';
alter table ta_resource_reservations.reservation alter column deadline_at drop not null;
alter table ta_resource_reservations.reservation add check(
 (intent_protocol='workspace-prepared-intent-v1' and deadline_at is not null) or (intent_protocol='workspace-prepared-intent-v2' and deadline_at is null));
create table pjsdas_rows_candidate.large_command_attempt (
 stage_id uuid primary key references pjsdas_rows_candidate.large_command_intent(stage_id),
 generation bigint not null default 0 check(generation between 0 and 9007199254740991),
 attempt_id uuid, deadline_at bigint, terminal_reason text,
 check((attempt_id is null)=(deadline_at is null)),
 check(terminal_reason is null or attempt_id is null)
);
alter table pjsdas_rows_candidate.large_command_attempt enable row level security;
revoke all on pjsdas_rows_candidate.large_command_attempt from public,anon,authenticated,service_role;
grant select,insert,update on pjsdas_rows_candidate.large_command_attempt to service_role;

-- Exact local catalog patches preserve the original owner/ACL/invoker modes.
create function pjsdas_rows_internal.v2_patch(signature text,needle text,replacement text) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare p record;
begin
 select oid,prosrc into strict p from pg_proc where oid=to_regprocedure(signature);
 if (length(p.prosrc)-length(replace(p.prosrc,needle,'')))/length(needle)<>1 then raise exception 'v2 patch boundary mismatch: %',signature;end if;
 execute replace(pg_get_functiondef(p.oid),p.prosrc,replace(p.prosrc,needle,replacement));
end$$;
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid)',
 'insert into pjsdas_rows_candidate.large_command_intent values',
 'insert into pjsdas_rows_candidate.large_command_intent(user_id,command_id,stage_id,identity,binding,encoded,deadline_at) values');

-- Acquire the same original authority -> global/owner/command -> head boundary
-- used by ALL writers. No receipt absence outside this lock proves noncommit.
create function pjsdas_rows_internal.intent_lock(identity jsonb,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);
 perform ta_resource_reservations.rpc_lock(identity,target_user_id);
 perform 1 from pjsdas_rows_candidate.head where user_id=target_user_id for update;
end$$;

create function pjsdas_rows_candidate.large_v2_intent_read(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;h pjsdas_rows_candidate.head%rowtype;
 r pjsdas_rows_candidate.large_document_reservation%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;
 resource ta_resource_reservations.reservation%rowtype;original jsonb;reason text;
begin
 perform pjsdas_rows_internal.intent_lock(identity,target_user_id);
 select * into i from pjsdas_rows_candidate.large_command_intent x where x.user_id=target_user_id and x.command_id=large_v2_intent_read.identity->>'commandId';
 if not found then
  if exists(select 1 from pjsdas_rows_candidate.large_stage s where s.user_id=target_user_id and s.request->>'commandId'=identity->>'commandId') then raise exception 'legacy partial stage lacks complete bytes' using errcode='PT409';end if;
  return null;
 end if;
 if i.identity->'payloadHash' is distinct from identity->'payloadHash' then raise exception 'command payload reused' using errcode='23505';end if;
 if i.identity is distinct from identity then raise exception 'original immutable authority required' using errcode='42501';end if;
 original:=pjsdas_rows_internal.original_command((i.binding->>'workspaceId')::uuid,target_user_id,i.command_id);
 if original is not null then
  if original->>'payloadHash' is distinct from identity->>'payloadHash' or original#>>'{receipt,operation}' is distinct from identity->>'operation' then raise exception 'original receipt mismatch' using errcode='23505';end if;
  return jsonb_build_object('outcome','ALREADY_APPLIED','commandId',i.command_id,'revision',original->'revision');
 end if;
 select * into a from pjsdas_rows_candidate.large_command_attempt where stage_id=i.stage_id for update;
 if a.terminal_reason is not null then return jsonb_build_object('outcome','TERMINAL_UNCOMMITTED','reason',a.terminal_reason);end if;
 select * into h from pjsdas_rows_candidate.head where user_id=target_user_id;
 select * into r from pjsdas_rows_candidate.large_document_reservation where stage_id=i.stage_id;
 if i.protocol='workspace-prepared-intent-v1' and i.deadline_at<=extract(epoch from clock_timestamp())*1000 then reason:='LEGACY_INTENT_EXPIRED';
 elsif h.id is distinct from (i.binding->>'workspaceId')::uuid or h.epoch is distinct from (i.binding->>'expectedEpoch')::uuid or h.revision is distinct from (i.binding->>'expectedRevision')::bigint then reason:='BASE_CHANGED';
 elsif r.stage_id is null or r.user_id is distinct from target_user_id or r.workspace_id is distinct from h.id or r.reserved_bytes<(i.encoded->>'bytes')::bigint or r.expires_at<=clock_timestamp() then reason:='RESOURCE_EXPIRED_OR_INVALID';
 end if;
 if ta_resource_reservations.rpc_enabled(target_user_id) then
  select * into resource from ta_resource_reservations.reservation where stage_id=i.stage_id::text;
  if not found or resource.binding is distinct from i.binding or resource.intent_protocol is distinct from i.protocol
   or resource.deadline_at is distinct from i.deadline_at or resource.reserved is distinct from r.reserved_bytes
   or resource.expires_at is distinct from floor(extract(epoch from r.expires_at)*1000)::bigint
   or resource.expires_at<=extract(epoch from clock_timestamp())*1000 then reason:=coalesce(reason,'RESOURCE_EXPIRED_OR_INVALID');end if;
 end if;
 if reason is not null then
  insert into pjsdas_rows_candidate.large_command_attempt(stage_id,terminal_reason) values(i.stage_id,reason)
   on conflict(stage_id) do update set generation=large_command_attempt.generation+1,attempt_id=null,deadline_at=null,terminal_reason=excluded.terminal_reason;
  return jsonb_build_object('outcome','TERMINAL_UNCOMMITTED','reason',reason);
 end if;
 if i.binding->>'preparedSha256' is distinct from i.encoded->>'sha256'
 or encode(sha256(decode(i.encoded->>'base64','base64')),'hex') is distinct from i.encoded->>'compressedSha256' then raise exception 'prepared intent digest changed' using errcode='22023';end if;
 return jsonb_build_object('protocol',i.protocol,'encoded',i.encoded,'reservedBytes',r.reserved_bytes,'deadlineAt',i.deadline_at,'binding',i.binding);
end$$;

-- Separate v2 admission. No caller-provided deadline or mutable business bytes.
create function pjsdas_rows_candidate.large_v2_intent_admit(identity jsonb,binding jsonb,encoded jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare h pjsdas_rows_candidate.head%rowtype;r pjsdas_rows_candidate.large_document_reservation%rowtype;existing jsonb;raw bytea;key text;
 p ta_resource_reservations.pool%rowtype;o ta_resource_reservations.owner%rowtype;expiry bigint;
begin
 perform pjsdas_rows_internal.intent_lock(identity,target_user_id);
 existing:=pjsdas_rows_candidate.large_v2_intent_read(identity,target_user_id);
 if existing is not null then return existing;end if;
 select * into h from pjsdas_rows_candidate.head where user_id=target_user_id;
 if h.id is distinct from (binding->>'workspaceId')::uuid or h.epoch is distinct from (binding->>'expectedEpoch')::uuid or h.revision is distinct from (binding->>'expectedRevision')::bigint then raise exception 'original base changed' using errcode='PT409';end if;
 foreach key in array array['userId','commandId','operation','payloadHash','principal','family','authority'] loop
  if binding->key is distinct from identity->key then raise exception 'intent binding mismatch' using errcode='42501';end if;
 end loop;
 if binding->>'preparedSha256' is distinct from encoded->>'sha256' or coalesce(binding->>'manifestSha256','') !~ '^[a-f0-9]{64}$' then raise exception 'complete prepared intent binding required' using errcode='22023';end if;
 if jsonb_typeof(encoded) is distinct from 'object' or (encoded-array['encoding','base64','sha256','bytes','compressedSha256'])<>'{}'::jsonb
 or encoded->>'encoding' is distinct from 'gzip-v1' or jsonb_typeof(encoded->'bytes') is distinct from 'number' or (encoded->>'bytes') !~ '^[1-9][0-9]*$'
 or coalesce(encoded->>'sha256','') !~ '^[a-f0-9]{64}$' or coalesce(encoded->>'compressedSha256','') !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(encoded->'base64') is distinct from 'string'
 or octet_length(jsonb_build_object('identity',identity,'binding',binding,'encoded',encoded,'target_user_id',target_user_id)::text)>2097152
 then raise exception 'unsupported atomic intent transport' using errcode='22023';end if;
 raw:=decode(encoded->>'base64','base64');
 if replace(encode(raw,'base64'),E'\n','') is distinct from encoded->>'base64' or encode(sha256(raw),'hex') is distinct from encoded->>'compressedSha256' then raise exception 'intent compressed digest mismatch' using errcode='22023';end if;
 select * into r from pjsdas_rows_candidate.large_document_reservation where stage_id=(binding->>'stageId')::uuid;
 if not found or r.user_id is distinct from target_user_id or r.workspace_id is distinct from h.id or r.reserved_bytes<(encoded->>'bytes')::bigint or r.expires_at<=clock_timestamp() then raise exception 'prior complete-intent reservation required' using errcode='42501';end if;
 if ta_resource_reservations.rpc_enabled(target_user_id) then
  select * into p from ta_resource_reservations.pool where singleton;
  select * into o from ta_resource_reservations.owner where user_id=target_user_id::text;
  expiry:=floor(extract(epoch from r.expires_at)*1000)::bigint;
  if r.reserved_bytes>p.command_limit or r.reserved_bytes>p.owner_limit-o.held or r.reserved_bytes>p.global_limit-p.held then raise exception 'resource capacity unavailable' using errcode='PT503';end if;
  insert into ta_resource_reservations.reservation(stage_id,user_id,command_id,binding,reserved,expires_at,deadline_at,intent_protocol)
   values(binding->>'stageId',target_user_id::text,identity->>'commandId',binding,r.reserved_bytes,expiry,null,'workspace-prepared-intent-v2');
  update ta_resource_reservations.pool set held=held+r.reserved_bytes,revision=revision+1 where singleton;
  update ta_resource_reservations.owner set held=held+r.reserved_bytes where user_id=target_user_id::text;
 end if;
 insert into pjsdas_rows_candidate.large_command_intent(user_id,command_id,stage_id,identity,binding,encoded,deadline_at,protocol)
 values(target_user_id,identity->>'commandId',(binding->>'stageId')::uuid,identity,binding,encoded,null,'workspace-prepared-intent-v2');
 -- Admission stores immutable bytes only; execution is a separate DB attempt.
 perform ta_resource_reservations.rpc_charge((binding->>'stageId')::uuid,'intent-record','intent-encoded',0,convert_to(jsonb_build_object('identity',identity,'binding',binding,'encoded',encoded)::text,'UTF8'));
 return jsonb_build_object('protocol','workspace-prepared-intent-v2','encoded',encoded,'reservedBytes',r.reserved_bytes,'deadlineAt',null,'binding',binding);
end$$;

create function pjsdas_rows_candidate.large_v2_attempt_begin(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare saved jsonb;i pjsdas_rows_candidate.large_command_intent%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;started bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 -- The execution allowance includes lock waiting in THIS begin transaction.
 saved:=pjsdas_rows_candidate.large_v2_intent_read(identity,target_user_id);
 if saved is null or saved ? 'outcome' then return saved;end if;
 if saved->>'protocol' is distinct from 'workspace-prepared-intent-v2' then raise exception 'v2 attempt requires v2 intent' using errcode='22023';end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where user_id=target_user_id and command_id=large_v2_attempt_begin.identity->>'commandId';
 if ta_resource_reservations.rpc_enabled(target_user_id) and not exists(select 1 from ta_resource_reservations.reservation
  where stage_id=i.stage_id::text and phase='open' and writer_fence is null)
 then raise exception 'resource writer not available for a new attempt' using errcode='PT503';end if;
 select * into a from pjsdas_rows_candidate.large_command_attempt where stage_id=i.stage_id for update;
 -- Concurrent explicit retries share the SAME live attempt, never refresh it.
 if a.attempt_id is not null and a.deadline_at>extract(epoch from clock_timestamp())*1000 then
  return jsonb_build_object('attempt',jsonb_build_object('id',a.attempt_id,'generation',a.generation,'deadlineAt',a.deadline_at),'remainingMs',greatest(0,a.deadline_at-ceil(extract(epoch from clock_timestamp())*1000)::bigint));
 end if;
 if started+10000<=extract(epoch from clock_timestamp())*1000 then raise exception 'attempt begin budget exhausted' using errcode='PT503';end if;
 insert into pjsdas_rows_candidate.large_command_attempt(stage_id,generation,attempt_id,deadline_at)
 values(i.stage_id,1,gen_random_uuid(),started+10000)
 on conflict(stage_id) do update set generation=large_command_attempt.generation+1,attempt_id=excluded.attempt_id,deadline_at=excluded.deadline_at
 where large_command_attempt.terminal_reason is null
 returning * into a;
 if not found then raise exception 'terminal intent cannot restart' using errcode='PT409';end if;
 return jsonb_build_object('attempt',jsonb_build_object('id',a.attempt_id,'generation',a.generation,'deadlineAt',a.deadline_at),'remainingMs',greatest(0,a.deadline_at-ceil(extract(epoch from clock_timestamp())*1000)::bigint));
end$$;

-- Explicit cancellation/known nonretryable resource exhaustion uses the same
-- lock+ledger boundary. It stores a tombstone, never releases resource bytes.
create function pjsdas_rows_internal.terminalize_intent(identity jsonb,target_user_id uuid,reason text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare saved jsonb;i pjsdas_rows_candidate.large_command_intent%rowtype;
begin
 if reason not in ('CANCELLED','RESOURCE_EXHAUSTED') then raise exception 'invalid terminal reason' using errcode='22023';end if;
 saved:=pjsdas_rows_candidate.large_v2_intent_read(identity,target_user_id);
 if saved is null or saved ? 'outcome' then return saved;end if;
 select * into i from pjsdas_rows_candidate.large_command_intent where user_id=target_user_id and command_id=terminalize_intent.identity->>'commandId';
 insert into pjsdas_rows_candidate.large_command_attempt(stage_id,terminal_reason) values(i.stage_id,reason)
  on conflict(stage_id) do update set generation=large_command_attempt.generation+1,attempt_id=null,deadline_at=null,terminal_reason=excluded.terminal_reason;
 return jsonb_build_object('outcome','TERMINAL_UNCOMMITTED','reason',reason);
end$$;
create function public.pjsdas_rows_v1_large_v2_intent_cancel(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,null);
 return pjsdas_rows_internal.terminalize_intent(identity,target_user_id,'CANCELLED');
end$$;
create function pjsdas_rows_internal.exhausted_intent(target_stage uuid,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;
begin
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=target_stage and user_id=target_user_id;
 if not found then raise exception 'original intent required' using errcode='42501';end if;
 return pjsdas_rows_internal.terminalize_intent(i.identity,target_user_id,'RESOURCE_EXHAUSTED');
end$$;

-- Every writer acquires head before reading the current fence. A retry drains
-- in-flight finalizers before replacing it. Late calls cannot borrow new time.
create or replace function pjsdas_rows_internal.require_intent_deadline(stage_id uuid,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;a pjsdas_rows_candidate.large_command_attempt%rowtype;claim jsonb;r pjsdas_rows_candidate.large_document_reservation%rowtype;
begin
 select * into i from pjsdas_rows_candidate.large_command_intent x where x.stage_id=require_intent_deadline.stage_id;
 if not found then return;end if;
 if i.user_id is distinct from target_user_id then raise exception 'intent owner mismatch' using errcode='42501';end if;
 perform pjsdas_rows_internal.intent_lock(i.identity,target_user_id);
 select * into a from pjsdas_rows_candidate.large_command_attempt x where x.stage_id=i.stage_id for update;
 if a.terminal_reason is not null then raise exception 'intent terminal uncommitted' using errcode='PT410';end if;
 if i.protocol='workspace-prepared-intent-v1' then
  if i.deadline_at<=extract(epoch from clock_timestamp())*1000 then raise exception 'original v1 deadline expired; resolve original intent' using errcode='PT503';end if;
 else
  claim:=nullif(current_setting('pjsdas_rows.attempt_v2',true),'')::jsonb;
  if claim is null or (claim-array['id','generation','deadlineAt'])<>'{}'::jsonb or a.attempt_id is null
   or claim->>'id' is distinct from a.attempt_id::text or (claim->>'generation')::bigint is distinct from a.generation or (claim->>'deadlineAt')::bigint is distinct from a.deadline_at
   then raise exception 'stale or absent attempt fence' using errcode='PT409';end if;
  if a.deadline_at<=extract(epoch from clock_timestamp())*1000 then raise exception 'single attempt deadline expired' using errcode='PT503';end if;
 end if;
 select * into r from pjsdas_rows_candidate.large_document_reservation where large_document_reservation.stage_id=i.stage_id;
 if not found or r.expires_at<=clock_timestamp() then raise exception 'real reservation expired; resolve original outcome' using errcode='PT503';end if;
end$$;

-- Legacy intent reads fail closed for v2; no reinterpretation of v1 bytes.
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_intent_read(jsonb,uuid)',
 ' if i.identity->''payloadHash'' is distinct from identity->''payloadHash''',
 E' if i.protocol<>\'workspace-prepared-intent-v1\' then raise exception \'v2 intent requires compatible reader\' using errcode=\'PT409\';end if;\n if i.identity->\'payloadHash\' is distinct from identity->\'payloadHash\'');
select pjsdas_rows_internal.v2_patch('ta_resource_reservations.rpc_stage(uuid,uuid)', 'r.deadline_at<>i.deadline_at', 'r.intent_protocol is distinct from i.protocol or r.deadline_at is distinct from i.deadline_at');
select pjsdas_rows_internal.v2_patch('ta_resource_reservations.rpc_history_lock(uuid,jsonb)', 'r.deadline_at<>i.deadline_at', 'r.intent_protocol is distinct from i.protocol or r.deadline_at is distinct from i.deadline_at');
select pjsdas_rows_internal.v2_patch('ta_resource_reservations.rpc_charge(uuid,text,text,bigint,bytea)',
 'least(r.deadline_at,r.expires_at)<=extract(epoch from clock_timestamp())*1000',
 '(r.expires_at<=extract(epoch from clock_timestamp())*1000 or r.intent_protocol=''workspace-prepared-intent-v1'' and r.deadline_at<=extract(epoch from clock_timestamp())*1000)');
select pjsdas_rows_internal.v2_patch('ta_resource_reservations.rpc_charge(uuid,text,text,bigint,bytea)',
 'if n>r.reserved-r.occupied then raise exception ''resource cumulative representations exceed original reservation'' using errcode=''PT503'';end if;',
 'if n>r.reserved-r.occupied then
  if r.intent_protocol=''workspace-prepared-intent-v2'' then raise exception ''resource cumulative representations exceed original reservation'' using errcode=''PT507'';end if;
  raise exception ''resource cumulative representations exceed original reservation'' using errcode=''PT503'';end if;');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(stage_id,(req->>\'userId\')::uuid);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(stage_id,(req->>\'userId\')::uuid);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_append(uuid,uuid,jsonb)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_finish(uuid,uuid)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_finish_opportunity(uuid,uuid)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline((manifest_wire::jsonb#>>\'{binding,stageId}\')::uuid,target_user_id);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_append(jsonb,uuid)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline((part->>\'stageId\')::uuid,target_user_id);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_finish(uuid,uuid,text)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(target_stage,(req->>\'userId\')::uuid);\n');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text)', E'\nbegin\n', E'\nbegin\n perform pjsdas_rows_internal.require_intent_deadline(target_stage,(req->>\'userId\')::uuid);\n');
create function public.pjsdas_rows_v1_large_v2_append(stage_id uuid,target_user_id uuid,parts jsonb,attempt jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform set_config('pjsdas_rows.attempt_v2',attempt::text,true);
 begin
  result:=public.pjsdas_rows_v1_large_append(stage_id,target_user_id,parts);
 exception when sqlstate 'PT507' then
  return pjsdas_rows_internal.exhausted_intent(stage_id,target_user_id);
 end;
 return result;
end$$;
create function public.pjsdas_rows_v1_large_v2_documents_begin(manifest_wire text,manifest_sha256 text,target_user_id uuid,attempt jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform set_config('pjsdas_rows.attempt_v2',attempt::text,true);
 begin
  result:=public.pjsdas_rows_v1_large_documents_begin(manifest_wire,manifest_sha256,target_user_id);
 exception when sqlstate 'PT507' then
  return pjsdas_rows_internal.exhausted_intent((manifest_wire::jsonb#>>'{binding,stageId}')::uuid,target_user_id);
 end;
 return result;
end$$;
create function public.pjsdas_rows_v1_large_v2_documents_append(part jsonb,target_user_id uuid,attempt jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform set_config('pjsdas_rows.attempt_v2',attempt::text,true);
 begin
  result:=public.pjsdas_rows_v1_large_documents_append(part,target_user_id);
 exception when sqlstate 'PT507' then
  return pjsdas_rows_internal.exhausted_intent((part->>'stageId')::uuid,target_user_id);
 end;
 return result;
end$$;
create function public.pjsdas_rows_v1_large_v2_documents_finish(stage_id uuid,target_user_id uuid,manifest_sha256 text,attempt jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform set_config('pjsdas_rows.attempt_v2',attempt::text,true);
 begin
  result:=public.pjsdas_rows_v1_large_documents_finish(stage_id,target_user_id,manifest_sha256);
 exception when sqlstate 'PT507' then
  return pjsdas_rows_internal.exhausted_intent(stage_id,target_user_id);
 end;
 return result;
end$$;
create function public.pjsdas_rows_v1_large_v2_documents_check_reservation(stage_id uuid,target_user_id uuid,target_workspace_id uuid,required_bytes bigint,attempt jsonb) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare result boolean;
begin
 perform set_config('pjsdas_rows.attempt_v2',attempt::text,true);
 perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 result:=public.pjsdas_rows_v1_large_documents_check_reservation(stage_id,target_user_id,target_workspace_id,required_bytes);
 perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 return result;
end$$;
create function public.pjsdas_rows_v1_large_v2_intent_read(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,null);
 return pjsdas_rows_candidate.large_v2_intent_read(identity,target_user_id);
end$$;
create function public.pjsdas_rows_v1_large_v2_intent_admit(identity jsonb,binding jsonb,encoded jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,null);
 return pjsdas_rows_candidate.large_v2_intent_admit(identity,binding,encoded,target_user_id);
end$$;
create function public.pjsdas_rows_v1_large_v2_attempt_begin(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform pjsdas_rows_internal.require_active_layout(target_user_id,null);
 return pjsdas_rows_candidate.large_v2_attempt_begin(identity,target_user_id);
end$$;
-- Direct candidate/internal mutation entries get an exit guard too.
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text)',' return jsonb_build_object(''nextOrdinal'',s.next_ordinal,''result'',s.result);',' perform pjsdas_rows_internal.require_intent_deadline(stage_id,(req->>''userId'')::uuid);
 return jsonb_build_object(''nextOrdinal'',s.next_ordinal,''result'',s.result);');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text)',' return jsonb_build_object(''nextOrdinal'',s.next_ordinal,''completed'',s.result is not null);',' perform pjsdas_rows_internal.require_intent_deadline(stage_id,(req->>''userId'')::uuid);
 return jsonb_build_object(''nextOrdinal'',s.next_ordinal,''completed'',s.result is not null);');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_append(uuid,uuid,jsonb)',' return jsonb_build_object(''nextOrdinal'',s.next_ordinal);',' perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 return jsonb_build_object(''nextOrdinal'',s.next_ordinal);');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb)',' return jsonb_build_object(''outcome'',''COMMITTED'',''revision'',h.revision+1,''receipt'',r);',' perform pjsdas_rows_internal.require_intent_deadline(target_stage,(req->>''userId'')::uuid);
 return jsonb_build_object(''outcome'',''COMMITTED'',''revision'',h.revision+1,''receipt'',r);');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_finish(uuid,uuid)',' return r;',' perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);
 return r;');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_internal.commit_opportunity_staged(jsonb,uuid,uuid,bigint,text)',' return staged_result;',' perform pjsdas_rows_internal.require_intent_deadline(target_stage,(req->>''userId'')::uuid);
 return staged_result;');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_append(jsonb,uuid)',' return jsonb_build_object(''stageId'',document_stage_id,''manifestSha256'',b.manifest_sha256,''document'',name,''nextOffset'',next_off);',' perform pjsdas_rows_internal.require_intent_deadline(document_stage_id,target_user_id);
 return jsonb_build_object(''stageId'',document_stage_id,''manifestSha256'',b.manifest_sha256,''document'',name,''nextOffset'',next_off);');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)',' return jsonb_build_object(''stageId'',document_stage_id,',' perform pjsdas_rows_internal.require_intent_deadline(document_stage_id,target_user_id);
 return jsonb_build_object(''stageId'',document_stage_id,');

-- Alias-stage attempts cannot evade a command-bound intent/tombstone, even
-- with resource scope OFF or a changed epoch that yields another stage UUID.
create function pjsdas_rows_internal.require_original_intent_stage(req jsonb,target_stage uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if exists(select 1 from pjsdas_rows_candidate.large_command_intent i where i.user_id=(req->>'userId')::uuid
  and i.command_id=req->>'commandId' and i.stage_id is distinct from target_stage)
 then raise exception 'original command has a different immutable stage' using errcode='PT409';end if;
end$$;
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_begin(uuid,jsonb,integer,text)','
begin
','
begin
 perform pjsdas_rows_internal.require_original_intent_stage(req,stage_id);
');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_begin_opportunity(uuid,jsonb,integer,text,uuid,bigint,text)','
begin
','
begin
 perform pjsdas_rows_internal.require_original_intent_stage(req,stage_id);
');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)','
begin
','
begin
 perform pjsdas_rows_internal.require_original_intent_stage(manifest_wire::jsonb->''binding'',(manifest_wire::jsonb#>>''{binding,stageId}'')::uuid);
');
select pjsdas_rows_internal.v2_patch('pjsdas_rows_internal.apply_staged_rows(jsonb,uuid,jsonb)',' if h.revision is distinct from (req->>''expectedRevision'')::bigint or h.epoch is distinct from (req->>''expectedEpoch'')::uuid then',' perform pjsdas_rows_internal.require_original_intent_stage(req,target_stage);
 if h.revision is distinct from (req->>''expectedRevision'')::bigint or h.epoch is distinct from (req->>''expectedEpoch'')::uuid then');

-- Immutable document identity is independent of resource-accounting enrollment.
create function pjsdas_rows_internal.require_original_intent_document(manifest_wire text,manifest_sha256 text,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;b jsonb:=manifest_wire::jsonb->'binding';
begin
 select * into i from pjsdas_rows_candidate.large_command_intent where stage_id=(b->>'stageId')::uuid;
 if not found then return;end if;
 if i.user_id is distinct from target_user_id or b is distinct from i.binding-array['preparedSha256','manifestSha256']
  or manifest_sha256 is distinct from i.binding->>'manifestSha256'
 then raise exception 'original immutable intent manifest required' using errcode='42501';end if;
end$$;
select pjsdas_rows_internal.v2_patch('pjsdas_rows_candidate.large_documents_begin(text,text,uuid)','
begin
','
begin
 perform pjsdas_rows_internal.require_original_intent_document(manifest_wire,manifest_sha256,target_user_id);
');

-- The small-path writer cannot re-evaluate an admitted intent into different
-- bytes. It already owns head, so this is a read-only rejection and NEVER takes
-- grant/global/resource locks in reverse order. Its original committed replay
-- stays above this check and preserves the original ledger.
select pjsdas_rows_internal.v2_patch('pjsdas_rows_internal.apply_rows(jsonb,jsonb)',
 ' if h.revision is distinct from (req->>''expectedRevision'')::bigint or h.epoch is distinct from (req->>''expectedEpoch'')::uuid then',
 E' if exists(select 1 from pjsdas_rows_candidate.large_command_intent i where i.user_id=h.user_id and i.command_id=req->>\'commandId\') then raise exception \'admitted immutable intent requires original staged recovery\' using errcode=\'PT409\';end if;\n if h.revision is distinct from (req->>\'expectedRevision\')::bigint or h.epoch is distinct from (req->>\'expectedEpoch\')::uuid then');

-- Service-only versioned transport. Existing authority functions stay invoker.
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where
 (pronamespace='public'::regnamespace and proname like 'pjsdas_rows_v1_large_v2_%')
 or (pronamespace='pjsdas_rows_candidate'::regnamespace and proname like 'large_v2_%')
 or (pronamespace='pjsdas_rows_internal'::regnamespace and proname in ('intent_lock','terminalize_intent','exhausted_intent','require_original_intent_stage','require_original_intent_document')) loop
  execute 'revoke all on function '||p.signature||' from public,anon,authenticated';
  execute 'grant execute on function '||p.signature||' to service_role';
 end loop;
end$$;
drop function pjsdas_rows_internal.v2_patch(text,text,text);

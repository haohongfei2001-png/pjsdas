-- LOCAL DEFAULT-OFF CAPABILITY. Uses the existing database and prior reservation.
-- Atomic compressed transport is NOT arbitrary large-payload admission, a quota,
-- a retention policy, or permission to enable this candidate in production.
create table pjsdas_rows_candidate.large_command_intent (
 user_id uuid not null, command_id text not null, stage_id uuid not null unique,
 identity jsonb not null, binding jsonb not null, encoded jsonb not null,
 deadline_at bigint not null, primary key(user_id,command_id),
 foreign key(stage_id) references pjsdas_rows_candidate.large_document_reservation(stage_id)
);
alter table pjsdas_rows_candidate.large_command_intent enable row level security;
revoke all on pjsdas_rows_candidate.large_command_intent from public,anon,authenticated,service_role;
grant select,insert on pjsdas_rows_candidate.large_command_intent to service_role;

-- Principal identity is server supplied, as on the original finalizers. Never
-- release a prepared bundle before checking CURRENT original family authority.
create function pjsdas_rows_internal.authorize_intent(identity jsonb,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if jsonb_typeof(identity) is distinct from 'object' or (identity-array['userId','commandId','operation','payloadHash','principal','family','authority'])<>'{}'::jsonb
 or (identity->>'userId')::uuid is distinct from target_user_id or nullif(identity->>'commandId','') is null
 or coalesce(identity->>'payloadHash','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid intent identity' using errcode='42501';end if;
 if identity->>'family'='first_party_abandon' then
  if identity->>'principal' is distinct from 'first_party_web' or identity->'authority' is distinct from '{}'::jsonb
  or coalesce(identity->>'operation','') not in ('abandon_opportunity','domain:abandon_opportunity','undo_command') then raise exception 'original first-party identity required' using errcode='42501';end if;
 elsif identity->>'family'='opportunity_v3' then
  if identity->>'principal' is distinct from 'delegated_mcp' or coalesce(identity->>'operation','') not in ('opportunity_management','undo_command')
  or jsonb_typeof(identity->'authority') is distinct from 'object' or ((identity->'authority')-array['grantId','grantRevision','clientId'])<>'{}'::jsonb
  then raise exception 'original v3 identity required' using errcode='42501';end if;
  perform 1 from public.pjsdas_business_management_grants g where g.id=(identity#>>'{authority,grantId}')::uuid and g.user_id=target_user_id
   and g.client_id::text=identity#>>'{authority,clientId}' and g.revision=(identity#>>'{authority,grantRevision}')::bigint
   and g.capability='workspace.opportunity.manage' and g.consent_version=3 and g.revoked_at is null and g.granted_at<=now() for share;
  if not found then raise exception 'original intent grant absent or stale' using errcode='42501';end if;
 else raise exception 'unsupported intent family' using errcode='42501';end if;
end$$;

create function pjsdas_rows_candidate.large_intent_read(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;h pjsdas_rows_candidate.head%rowtype;r pjsdas_rows_candidate.large_document_reservation%rowtype;
begin
 perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);
 select * into h from pjsdas_rows_candidate.head where user_id=target_user_id for share;
 select * into i from pjsdas_rows_candidate.large_command_intent x where x.user_id=target_user_id and x.command_id=large_intent_read.identity->>'commandId';
 if not found then
  if exists(select 1 from pjsdas_rows_candidate.large_stage s where s.user_id=target_user_id and s.request->>'commandId'=large_intent_read.identity->>'commandId') then raise exception 'legacy partial stage has no complete admitted intent' using errcode='PT409';end if;
  return null;end if;
 if i.identity->'payloadHash' is distinct from identity->'payloadHash' then raise exception 'intent command payload reused' using errcode='23505';end if;
 if i.identity is distinct from identity then raise exception 'original intent authority required' using errcode='42501';end if;
 if h.id is distinct from (i.binding->>'workspaceId')::uuid or h.epoch is distinct from (i.binding->>'expectedEpoch')::uuid or h.revision is distinct from (i.binding->>'expectedRevision')::bigint
 then raise exception 'original intent generation/revision changed' using errcode='PT409';end if;
 select * into r from pjsdas_rows_candidate.large_document_reservation where stage_id=i.stage_id;
 if not found or r.user_id is distinct from target_user_id or r.workspace_id is distinct from h.id or r.reserved_bytes<(i.encoded->>'bytes')::bigint
 or r.expires_at<=clock_timestamp() then raise exception 'original intent reservation unavailable' using errcode='42501';end if;
 if i.binding->>'preparedSha256' is distinct from i.encoded->>'sha256'
 or encode(sha256(decode(i.encoded->>'base64','base64')),'hex') is distinct from i.encoded->>'compressedSha256'
 then raise exception 'stored prepared intent digest changed' using errcode='22023';end if;
 if i.deadline_at<=extract(epoch from clock_timestamp())*1000 then raise exception 'original intent deadline expired; resolve ledger' using errcode='PT503';end if;
 return jsonb_build_object('encoded',i.encoded,'reservedBytes',r.reserved_bytes,'deadlineAt',i.deadline_at,'binding',i.binding);
end$$;

create function pjsdas_rows_candidate.large_intent_admit(identity jsonb,binding jsonb,encoded jsonb,deadline_at bigint,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare h pjsdas_rows_candidate.head%rowtype;r pjsdas_rows_candidate.large_document_reservation%rowtype;raw bytea;existing jsonb;key text;
begin
 perform pjsdas_rows_internal.authorize_intent(identity,target_user_id);
 select * into h from pjsdas_rows_candidate.head where id=(binding->>'workspaceId')::uuid and user_id=target_user_id for update;
 if not found or h.epoch is distinct from (binding->>'expectedEpoch')::uuid or h.revision is distinct from (binding->>'expectedRevision')::bigint then raise exception 'original intent base changed' using errcode='PT409';end if;
 existing:=pjsdas_rows_candidate.large_intent_read(identity,target_user_id);
 if existing is not null then return existing;end if;
 if exists(select 1 from pjsdas_rows_candidate.large_stage s where s.user_id=target_user_id and s.request->>'commandId'=identity->>'commandId') then raise exception 'legacy partial stage has no complete admitted intent' using errcode='PT409';end if;
 foreach key in array array['userId','commandId','operation','payloadHash','principal','family','authority'] loop
  if binding->key is distinct from identity->key then raise exception 'intent binding mismatch' using errcode='42501';end if;
 end loop;
 if binding->>'preparedSha256' is distinct from encoded->>'sha256' or coalesce(binding->>'manifestSha256','') !~ '^[a-f0-9]{64}$' then raise exception 'complete prepared intent binding required' using errcode='22023';end if;
 if jsonb_typeof(encoded) is distinct from 'object' or (encoded-array['encoding','base64','sha256','bytes','compressedSha256'])<>'{}'::jsonb
 or encoded->>'encoding' is distinct from 'gzip-v1' or jsonb_typeof(encoded->'bytes') is distinct from 'number' or (encoded->>'bytes') !~ '^[1-9][0-9]*$'
 or coalesce(encoded->>'sha256','') !~ '^[a-f0-9]{64}$' or coalesce(encoded->>'compressedSha256','') !~ '^[a-f0-9]{64}$'
 or jsonb_typeof(encoded->'base64') is distinct from 'string'
 or octet_length(jsonb_build_object('identity',identity,'binding',binding,'encoded',encoded,'deadline_at',deadline_at,'target_user_id',target_user_id)::text)>2097152
 then raise exception 'unsupported atomic intent transport' using errcode='22023';end if;
 raw:=decode(encoded->>'base64','base64');
 if replace(encode(raw,'base64'),E'\n','') is distinct from encoded->>'base64' or encode(sha256(raw),'hex') is distinct from encoded->>'compressedSha256' then raise exception 'intent compressed digest mismatch' using errcode='22023';end if;
 select * into r from pjsdas_rows_candidate.large_document_reservation where stage_id=(binding->>'stageId')::uuid;
 if not found or r.user_id is distinct from target_user_id or r.workspace_id is distinct from h.id
 or r.reserved_bytes<(encoded->>'bytes')::bigint or r.expires_at<=clock_timestamp() then raise exception 'prior complete-intent byte reservation required' using errcode='42501';end if;
 if deadline_at<=extract(epoch from clock_timestamp())*1000 or deadline_at>extract(epoch from clock_timestamp())*1000+10000 then raise exception 'original intent budget required' using errcode='PT503';end if;
 insert into pjsdas_rows_candidate.large_command_intent values(target_user_id,identity->>'commandId',(binding->>'stageId')::uuid,identity,binding,encoded,deadline_at);
 return jsonb_build_object('encoded',encoded,'reservedBytes',r.reserved_bytes,'deadlineAt',deadline_at,'binding',binding);
end$$;

create function pjsdas_rows_internal.require_intent_deadline(stage_id uuid,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare i pjsdas_rows_candidate.large_command_intent%rowtype;
begin
 select * into i from pjsdas_rows_candidate.large_command_intent x where x.stage_id=require_intent_deadline.stage_id;
 if not found then return;end if;
 if i.user_id is distinct from target_user_id then raise exception 'intent owner mismatch' using errcode='42501';end if;
 perform pjsdas_rows_internal.authorize_intent(i.identity,target_user_id);
 if i.deadline_at<=extract(epoch from clock_timestamp())*1000 then raise exception 'original intent deadline expired; resolve ledger' using errcode='PT503';end if;
end$$;
create function public.pjsdas_rows_v1_large_intent_read(identity jsonb,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);return pjsdas_rows_candidate.large_intent_read(identity,target_user_id);end$$;
create function public.pjsdas_rows_v1_large_intent_admit(identity jsonb,binding jsonb,encoded jsonb,deadline_at bigint,target_user_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$begin perform pjsdas_rows_internal.require_active_layout(target_user_id,(binding->>'expectedEpoch')::uuid);return pjsdas_rows_candidate.large_intent_admit(identity,binding,encoded,deadline_at,target_user_id);end$$;
revoke all on function pjsdas_rows_internal.authorize_intent(jsonb,uuid),pjsdas_rows_candidate.large_intent_read(jsonb,uuid),pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid),pjsdas_rows_internal.require_intent_deadline(uuid,uuid),public.pjsdas_rows_v1_large_intent_read(jsonb,uuid),public.pjsdas_rows_v1_large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.authorize_intent(jsonb,uuid),pjsdas_rows_candidate.large_intent_read(jsonb,uuid),pjsdas_rows_candidate.large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid),pjsdas_rows_internal.require_intent_deadline(uuid,uuid),public.pjsdas_rows_v1_large_intent_read(jsonb,uuid),public.pjsdas_rows_v1_large_intent_admit(jsonb,jsonb,jsonb,bigint,uuid) to service_role;
-- Preserve the original bounded public routes and original final family guards.
create or replace function public.pjsdas_rows_v1_large_documents_begin(manifest_wire text,manifest_sha256 text,target_user_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ declare result jsonb;begin perform pjsdas_rows_internal.require_active_layout(target_user_id,(manifest_wire::jsonb#>>'{binding,expectedEpoch}')::uuid);perform pjsdas_rows_internal.require_intent_deadline((manifest_wire::jsonb#>>'{binding,stageId}')::uuid,target_user_id);result:=pjsdas_rows_candidate.large_documents_begin(manifest_wire,manifest_sha256,target_user_id);perform pjsdas_rows_internal.require_intent_deadline((manifest_wire::jsonb#>>'{binding,stageId}')::uuid,target_user_id);return result;end $$;
create or replace function public.pjsdas_rows_v1_large_documents_append(part jsonb,target_user_id uuid) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ declare result jsonb;begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);perform pjsdas_rows_internal.require_intent_deadline((part->>'stageId')::uuid,target_user_id);result:=pjsdas_rows_candidate.large_documents_append(part,target_user_id);perform pjsdas_rows_internal.require_intent_deadline((part->>'stageId')::uuid,target_user_id);return result;end $$;
create or replace function public.pjsdas_rows_v1_large_documents_finish(stage_id uuid,target_user_id uuid,manifest_sha256 text) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ declare result jsonb;begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);result:=pjsdas_rows_candidate.large_documents_finish(stage_id,target_user_id,manifest_sha256);perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);return result;end $$;
create or replace function public.pjsdas_rows_v1_large_append(stage_id uuid,target_user_id uuid,parts jsonb) returns jsonb
language plpgsql volatile security invoker set search_path=pg_catalog as $$ declare result jsonb;begin perform pjsdas_rows_internal.require_active_layout(target_user_id,null);perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);result:=pjsdas_rows_candidate.large_append(stage_id,target_user_id,parts);perform pjsdas_rows_internal.require_intent_deadline(stage_id,target_user_id);return result;end $$;

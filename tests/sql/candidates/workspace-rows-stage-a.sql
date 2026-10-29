-- STAGE A / NOT A MIGRATION. Only isolated synthetic DB harness may execute this file.
-- No product public functions, active layout or grants are changed by this candidate.
-- SYNTHETIC EXPERIMENT ONLY. Not a product migration or production authorization implementation.
create schema pjsdas_rows_candidate;
create schema pjsdas_rows_internal;
revoke all on schema pjsdas_rows_internal from public;
grant usage on schema pjsdas_rows_internal to service_role;
revoke all on schema pjsdas_rows_candidate from public;
create table pjsdas_rows_candidate.head (
 id uuid primary key, user_id uuid not null unique, revision bigint not null default 0,
 epoch uuid not null default gen_random_uuid(), format text not null default 'workspace-rows-v1',
 envelope jsonb not null, manifest jsonb not null, legacy_snapshot jsonb not null,
 schema_version integer not null default 4 check(schema_version>0),
 unique(id,user_id),check(revision>=0)
);
create table pjsdas_rows_candidate.item (
 workspace_id uuid not null,user_id uuid not null,collection text collate "C" not null,id text not null,
 ordinal bigint not null check(ordinal>=0),value jsonb not null,updated_revision bigint not null,
 primary key(workspace_id,collection,id),
 unique(workspace_id,collection,ordinal) deferrable initially deferred,
 foreign key(workspace_id,user_id) references pjsdas_rows_candidate.head(id,user_id),
 check(collection=any(array['opportunities','opportunityAliases','processes','processEvents','scheduleNodes','actions','prep','applicationGroups','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox','discoveryInbox','timeline','changeSets'])),
 check(jsonb_typeof(value) is not distinct from 'object' and jsonb_typeof(value->'id') is not distinct from 'string' and value->>'id' is not distinct from id and length(id)>0)
);
create table pjsdas_rows_candidate.ledger (
 workspace_id uuid not null,user_id uuid not null,command_id text not null,payload_hash text not null,
 resulting_revision bigint not null,receipt jsonb not null,compensation jsonb not null,effect_digest text not null,
 principal_kind text,client_id text,provenance jsonb not null default '{}'::jsonb,expected_revision bigint,effective_time timestamptz,created_at timestamptz not null default now(),
 primary key(workspace_id,command_id),unique(workspace_id,resulting_revision),
 foreign key(workspace_id,user_id) references pjsdas_rows_candidate.head(id,user_id)
);
alter table pjsdas_rows_candidate.head enable row level security;
alter table pjsdas_rows_candidate.item enable row level security;
alter table pjsdas_rows_candidate.ledger enable row level security;
create function pjsdas_rows_candidate.freeze_ledger() returns trigger language plpgsql as $$begin raise exception 'immutable receipt' using errcode='42501';end$$;
create trigger freeze_ledger before update or delete on pjsdas_rows_candidate.ledger for each row execute function pjsdas_rows_candidate.freeze_ledger();
create function pjsdas_rows_candidate.reject_raw_overwrite() returns trigger language plpgsql as $$begin
 if old.format='workspace-rows-v1' and new.format='workspace-rows-v1' and new.legacy_snapshot is distinct from old.legacy_snapshot then
  raise exception 'raw legacy writer lacks row-layout awareness' using errcode='PT409';end if;
 return new;end$$;
create trigger reject_raw before update on pjsdas_rows_candidate.head for each row execute function pjsdas_rows_candidate.reject_raw_overwrite();
create function pjsdas_rows_candidate.valid_state(w uuid) returns boolean language sql stable security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
 select exists(select 1 from pjsdas_rows_candidate.head where id=w)
 and not exists(select 1 from pjsdas_rows_candidate.head h where h.id=w and octet_length(h.envelope::text)>1048576)
 and (select count(*)<=65024 and coalesce(max(n),0)<=1048574 and coalesce(sum(n+2),0)<=33554432 from
   (select octet_length(jsonb_build_object('collection',collection,'id',id,'ordinal',ordinal,'value',value)::text) n
    from pjsdas_rows_candidate.item where workspace_id=w) sizes)
 and not exists(select 1 from pjsdas_rows_candidate.head h where h.id=w and
 (jsonb_typeof(h.envelope) is distinct from 'object' or jsonb_typeof(h.envelope->'data') is distinct from 'object' or jsonb_typeof(h.manifest) is distinct from 'array'))
 and not exists(select 1 from pjsdas_rows_candidate.head h cross join lateral jsonb_array_elements(h.manifest) m where h.id=w and
 (jsonb_typeof(m) is distinct from 'object' or not (m ?& array['collection','count']) or (m-array['collection','count'])<>'{}'::jsonb
  or jsonb_typeof(m->'collection') is distinct from 'string' or not ((m->>'collection')=any(array['opportunities','opportunityAliases','processes','processEvents','scheduleNodes','actions','prep','applicationGroups','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox','discoveryInbox','timeline','changeSets']))
  or jsonb_typeof(m->'count') is distinct from 'number' or not (m->>'count' ~ '^(0|[1-9][0-9]*)$')
  or h.envelope->'data' ? (m->>'collection')))
 and not exists(select 1 from pjsdas_rows_candidate.head h cross join lateral jsonb_array_elements(h.manifest) m where h.id=w group by m->>'collection' having count(*)<>1)
 and not exists(select 1 from pjsdas_rows_candidate.head h cross join lateral unnest(array['opportunities','opportunityAliases','processes','processEvents','scheduleNodes','actions','prep','applicationGroups','decisionRequests','semanticReceipts','reminderIntents','reminderOutbox','discoveryInbox','timeline','changeSets']) k where h.id=w and h.envelope->'data' ? k)
 and not exists(select 1 from pjsdas_rows_candidate.item i where i.workspace_id=w and not exists(select 1 from pjsdas_rows_candidate.head h cross join lateral jsonb_array_elements(h.manifest) m where h.id=w and m->>'collection'=i.collection))
 and not exists(select 1 from pjsdas_rows_candidate.head h cross join lateral jsonb_array_elements(h.manifest) m
  left join lateral (select count(*) n,count(distinct ordinal) nd,min(ordinal) lo,max(ordinal) hi from pjsdas_rows_candidate.item i where i.workspace_id=w and i.collection=m->>'collection') c on true
  where h.id=w and (c.n<>(m->>'count')::bigint or c.nd<>c.n or (c.n>0 and (c.lo<>0 or c.hi<>c.n-1))))
$$;
-- Original command identity spans retained and current history. A cutover must
-- never make an old committed command look new. Conflicting duplicates fail
-- closed; neither store silently wins an ambiguous import.
create function pjsdas_rows_internal.original_command(target_workspace_id uuid,target_user_id uuid,target_command_id text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare old public.pjsdas_command_ledger%rowtype;fresh pjsdas_rows_candidate.ledger%rowtype;has_old boolean;has_fresh boolean;
begin
 select * into old from public.pjsdas_command_ledger where user_id=target_user_id and command_id=target_command_id;has_old:=found;
 select * into fresh from pjsdas_rows_candidate.ledger where user_id=target_user_id and command_id=target_command_id;has_fresh:=found;
 if has_old and (old.workspace_id is distinct from target_workspace_id or old.status is distinct from 'COMMITTED')
 or has_fresh and (fresh.workspace_id is distinct from target_workspace_id or fresh.receipt->>'status' is distinct from 'COMMITTED') then
 raise exception 'invalid original command identity' using errcode='42501';end if;
 if has_old and has_fresh and (
 old.operation is distinct from fresh.receipt->>'operation' or old.payload_hash is distinct from fresh.payload_hash
 or old.expected_revision is distinct from fresh.expected_revision or old.principal_kind is distinct from fresh.principal_kind
 or old.client_id is distinct from fresh.client_id or old.provenance is distinct from fresh.provenance
 or old.compensation is distinct from nullif(fresh.compensation,'null'::jsonb) or old.effective_time is distinct from fresh.effective_time
 or old.resulting_revision is distinct from fresh.resulting_revision or (old.receipt-'committedAt') is distinct from (fresh.receipt-'committedAt')
 ) then raise exception 'ambiguous original command identity' using errcode='42501';end if;
 if has_old then return jsonb_build_object('payloadHash',old.payload_hash,'receipt',old.receipt,'revision',old.resulting_revision);end if;
 if has_fresh then return jsonb_build_object('payloadHash',fresh.payload_hash,'receipt',fresh.receipt,'revision',fresh.resulting_revision);end if;
 return null;
end$$;
revoke all on function pjsdas_rows_internal.original_command(uuid,uuid,text) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.original_command(uuid,uuid,text) to service_role;
create function pjsdas_rows_internal.apply_rows(req jsonb,trusted_receipt_context jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare h pjsdas_rows_candidate.head%rowtype;original jsonb;c jsonb;oldrow pjsdas_rows_candidate.item%rowtype;foundrow boolean;n integer:=0;r jsonb;
begin
 if req->>'contract' is distinct from 'workspace-rows-v1'
 or jsonb_typeof(req->'commandId') is distinct from 'string' or nullif(req->>'commandId','') is null or coalesce(req->>'payloadHash','') !~ '^[0-9a-f]{64}$'
 or octet_length(req::text)>2097152 or jsonb_typeof(req->'changes') is distinct from 'array'
 or jsonb_array_length(req->'changes')>2000 then raise exception 'invalid narrow request' using errcode='22023';end if;
 if (req ? 'receiptContext' and req->'receiptContext' is distinct from 'null'::jsonb and jsonb_typeof(req->'receiptContext') is distinct from 'object')
 or (req ? 'provenance' and req->'provenance' is distinct from 'null'::jsonb and jsonb_typeof(req->'provenance') is distinct from 'object')
 or jsonb_typeof(trusted_receipt_context) is distinct from 'object' then
 raise exception 'invalid command audit metadata' using errcode='22023';end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid for update;
 if not found or h.user_id is distinct from (req->>'userId')::uuid then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'unsupported generation' using errcode='PT409';end if;
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
 if exists(select 1 from jsonb_array_elements(req->'changes') x group by x->>'collection',x->>'id' having count(*)>1) then raise exception 'duplicate effect key' using errcode='22023';end if;
 for c in select value from jsonb_array_elements(req->'changes') loop
  if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'collection') is distinct from 'string' or jsonb_typeof(c->'id') is distinct from 'string' or (c-array['collection','id','before','after'])<>'{}'::jsonb or not (c ?& array['collection','id','before','after']) then raise exception 'invalid effect' using errcode='22023';end if;
  select * into oldrow from pjsdas_rows_candidate.item where workspace_id=h.id and collection=c->>'collection' and id=c->>'id';foundrow:=found;
  if (case when foundrow then jsonb_build_object('collection',oldrow.collection,'id',oldrow.id,'ordinal',oldrow.ordinal,'value',oldrow.value) else 'null'::jsonb end) is distinct from c->'before' then raise exception 'row preimage mismatch' using errcode='PT409';end if;
  if c->'after'='null'::jsonb then
   delete from pjsdas_rows_candidate.item where workspace_id=h.id and collection=c->>'collection' and id=c->>'id';
  else
   if jsonb_typeof(c->'after') is distinct from 'object' or jsonb_typeof(c#>'{after,id}') is distinct from 'string' or jsonb_typeof(c#>'{after,collection}') is distinct from 'string' or ((c->'after')-array['collection','id','ordinal','value'])<>'{}'::jsonb
    or c#>>'{after,collection}' is distinct from c->>'collection' or c#>>'{after,id}' is distinct from c->>'id'
    or jsonb_typeof(c#>'{after,ordinal}') is distinct from 'number' or not (c#>>'{after,ordinal}' ~ '^(0|[1-9][0-9]*)$') then raise exception 'invalid after row' using errcode='22023';end if;
   insert into pjsdas_rows_candidate.item(workspace_id,user_id,collection,id,ordinal,value,updated_revision)
    values(h.id,h.user_id,c->>'collection',c->>'id',(c#>>'{after,ordinal}')::bigint,c#>'{after,value}',h.revision+1)
    on conflict(workspace_id,collection,id) do update set ordinal=excluded.ordinal,value=excluded.value,updated_revision=excluded.updated_revision;
  end if;
  n:=n+1;
 end loop;
 update pjsdas_rows_candidate.head set revision=h.revision+1,envelope=req->'afterEnvelope',manifest=req->'afterManifest',schema_version=(req#>>'{afterEnvelope,version}')::integer where id=h.id;
 if pjsdas_rows_candidate.valid_state(h.id) is not true then raise exception 'incomplete collection manifest' using errcode='22023';end if;
 r:=coalesce(nullif(req->'receiptContext','null'::jsonb),'{}'::jsonb) || trusted_receipt_context || jsonb_build_object('commandId',req->>'commandId','receiptId','command-receipt:'||(req->>'commandId'),'status','COMMITTED','operation',req->>'operation','revision',h.revision+1,'committedAt',now(),'undoAvailable',req->'compensation' is not null and req->'compensation' is distinct from 'null'::jsonb);
 insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest,principal_kind,client_id,provenance,expected_revision,effective_time)
 values(h.id,h.user_id,req->>'commandId',req->>'payloadHash',h.revision+1,r,coalesce(req->'compensation','null'::jsonb),md5((req->'changes')::text),req->>'principal',req->>'clientId',coalesce(nullif(req->'provenance','null'::jsonb),'{}'::jsonb),(req->>'expectedRevision')::bigint,(req->>'effectiveTime')::timestamptz);
 -- Never commit an immutable audit row that the bounded logical history reader
 -- cannot later return. Projection overhead is conservatively included.
 if (select octet_length((to_jsonb(l)-'effect_digest')::text)+octet_length(to_jsonb(l.receipt->>'operation')::text)+64>2097150
     from pjsdas_rows_candidate.ledger l where l.workspace_id=h.id and l.command_id=req->>'commandId') then
  raise exception 'audit record exceeds candidate read eligibility' using errcode='22023';end if;
 return jsonb_build_object('outcome','COMMITTED','revision',h.revision+1,'receipt',r);
end$$;
-- A private-schema primitive is not exposed by PostgREST's candidate schema.
revoke all on function pjsdas_rows_internal.apply_rows(jsonb,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.apply_rows(jsonb,jsonb) to service_role;
create function pjsdas_rows_candidate.commit_rows(req jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
begin
 if req->>'operation' is distinct from 'gmail_semantic_intake' or req->>'principal' is distinct from 'automation'
 or req->>'sourceId' is distinct from 'gmail:primary' or req ?| array['managementAuthorization','aiCaptureAuthorization','discoveryAuthorization'] then
 raise exception 'unsupported writer family' using errcode='42501';end if;
 return pjsdas_rows_internal.apply_rows(req,'{}'::jsonb);
end$$;

-- STAGE A CANDIDATE ONLY: one statement snapshot binds each page to its head.
create function pjsdas_rows_candidate.read_head(target_user_id uuid) returns jsonb
language sql stable security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
 select jsonb_build_object('workspaceId',id,'userId',user_id,'revision',revision,'epoch',epoch,'format',format,'schemaVersion',schema_version,'envelope',envelope,'manifest',manifest)
 from pjsdas_rows_candidate.head where user_id=target_user_id
$$;
create function pjsdas_rows_candidate.read_page(target_user_id uuid,target_workspace_id uuid,target_epoch uuid,target_revision bigint,after_collection text default null,after_ordinal bigint default null,max_rows integer default 127) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare h record; item record; row_json jsonb; result_rows jsonb[]:='{}'::jsonb[]; size_bytes bigint:=2; n integer:=0; ended boolean:=true; row_bytes bigint;
begin
 select id,epoch,revision,format into h from pjsdas_rows_candidate.head where id=target_workspace_id and user_id=target_user_id;
 if not found then return jsonb_build_object('outcome','NOT_FOUND');end if;
 if max_rows is null or max_rows<1 or max_rows>127 or (after_collection is null)<>(after_ordinal is null) or after_ordinal<0 then return jsonb_build_object('outcome','INVALID_CURSOR');end if;
 if h.epoch is distinct from target_epoch or h.revision is distinct from target_revision or h.format<>'workspace-rows-v1' then return jsonb_build_object('outcome','CONFLICT');end if;
 -- Ordered index cursor; never aggregate 127 arbitrarily large entity values.
 for item in select collection,id,ordinal,value from pjsdas_rows_candidate.item
  where workspace_id=target_workspace_id and (after_collection is null or (collection,ordinal)>(after_collection,after_ordinal))
  order by collection,ordinal limit max_rows+1 loop
  row_json:=to_jsonb(item);row_bytes:=octet_length(row_json::text);
  if n=max_rows or size_bytes+row_bytes+(case when n>0 then 2 else 0 end)>1048576 then
   if n=0 then return jsonb_build_object('outcome','PAGE_TOO_LARGE');end if;
   ended:=false;exit;
  end if;
  result_rows:=array_append(result_rows,row_json);size_bytes:=size_bytes+row_bytes+(case when n>0 then 2 else 0 end);n:=n+1;
 end loop;
 return jsonb_build_object('outcome','PAGE','workspaceId',target_workspace_id,'epoch',target_epoch,'revision',target_revision,'rows',result_rows,'end',ended);
end$$;
revoke all on all tables in schema pjsdas_rows_candidate from public,anon,authenticated;
revoke all on all functions in schema pjsdas_rows_candidate from public,anon,authenticated;
grant usage on schema pjsdas_rows_candidate to service_role;
grant select,insert,update,delete on all tables in schema pjsdas_rows_candidate to service_role;
grant execute on all functions in schema pjsdas_rows_candidate to service_role;

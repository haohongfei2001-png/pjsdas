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
 select not exists(select 1 from pjsdas_rows_candidate.head h where h.id=w and
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
create function pjsdas_rows_internal.apply_rows(req jsonb,trusted_receipt_context jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare h pjsdas_rows_candidate.head%rowtype;l pjsdas_rows_candidate.ledger%rowtype;c jsonb;oldrow pjsdas_rows_candidate.item%rowtype;foundrow boolean;n integer:=0;r jsonb;
begin
 if req->>'contract' is distinct from 'workspace-rows-v1'
 or jsonb_typeof(req->'commandId') is distinct from 'string' or nullif(req->>'commandId','') is null or coalesce(req->>'payloadHash','') !~ '^[0-9a-f]{64}$'
 or octet_length(req::text)>2097152 or jsonb_typeof(req->'changes') is distinct from 'array'
 or jsonb_array_length(req->'changes')>2000 then raise exception 'invalid narrow request' using errcode='22023';end if;
 select * into h from pjsdas_rows_candidate.head where id=(req->>'workspaceId')::uuid for update;
 if not found or h.user_id is distinct from (req->>'userId')::uuid then raise exception 'workspace owner mismatch' using errcode='42501';end if;
 if h.epoch is distinct from (req->>'expectedEpoch')::uuid or h.format is distinct from 'workspace-rows-v1' then raise exception 'unsupported generation' using errcode='PT409';end if;
 select * into l from pjsdas_rows_candidate.ledger where workspace_id=h.id and command_id=req->>'commandId';
 if found then
  if l.payload_hash is distinct from req->>'payloadHash' then raise exception 'command payload differs' using errcode='23505';end if;
  return jsonb_build_object('outcome','ALREADY_APPLIED','revision',l.resulting_revision,'receipt',l.receipt);
 end if;
 if h.revision is distinct from (req->>'expectedRevision')::bigint or h.epoch is distinct from (req->>'expectedEpoch')::uuid then
  return jsonb_build_object('outcome','CONFLICT','revision',h.revision);end if;
 if h.format is distinct from 'workspace-rows-v1' then raise exception 'unsupported layout' using errcode='PT409';end if;
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
 update pjsdas_rows_candidate.head set revision=h.revision+1,envelope=req->'afterEnvelope',manifest=req->'afterManifest' where id=h.id;
 if pjsdas_rows_candidate.valid_state(h.id) is not true then raise exception 'incomplete collection manifest' using errcode='22023';end if;
 r:=jsonb_build_object('commandId',req->>'commandId','receiptId','command-receipt:'||(req->>'commandId'),'status','COMMITTED','operation',req->>'operation','revision',h.revision+1,'committedAt',now()) || trusted_receipt_context;
 insert into pjsdas_rows_candidate.ledger values(h.id,h.user_id,req->>'commandId',req->>'payloadHash',h.revision+1,r,req->'compensation',md5((req->'changes')::text));
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
 select jsonb_build_object('workspaceId',id,'userId',user_id,'revision',revision,'epoch',epoch,'format',format,'envelope',envelope,'manifest',manifest)
 from pjsdas_rows_candidate.head where user_id=target_user_id
$$;
create function pjsdas_rows_candidate.read_page(target_user_id uuid,target_workspace_id uuid,target_epoch uuid,target_revision bigint,after_collection text default null,after_ordinal bigint default null) returns jsonb
language sql stable security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
 with h as (select * from pjsdas_rows_candidate.head where id=target_workspace_id and user_id=target_user_id),
 page as (select i.collection,i.id,i.ordinal,i.value from pjsdas_rows_candidate.item i join h on h.id=i.workspace_id
 where h.epoch=target_epoch and h.revision=target_revision and h.format='workspace-rows-v1'
 and ((after_collection is null and after_ordinal is null) or (after_collection is not null and after_ordinal>=0 and (i.collection,i.ordinal)>(after_collection,after_ordinal)))
 order by i.collection,i.ordinal limit 127),
 data as (select coalesce(jsonb_agg(to_jsonb(page) order by collection,ordinal),'[]'::jsonb) rows,count(*) n from page)
 select case when not exists(select 1 from h) then jsonb_build_object('outcome','NOT_FOUND')
 when (after_collection is null)<>(after_ordinal is null) or after_ordinal<0 then jsonb_build_object('outcome','INVALID_CURSOR')
 when not exists(select 1 from h where epoch=target_epoch and revision=target_revision and format='workspace-rows-v1') then jsonb_build_object('outcome','CONFLICT')
 when octet_length(data.rows::text)>1048576 then jsonb_build_object('outcome','PAGE_TOO_LARGE')
 else jsonb_build_object('outcome','PAGE','workspaceId',target_workspace_id,'epoch',target_epoch,'revision',target_revision,'rows',data.rows,'end',n<127) end from data
$$;
revoke all on all tables in schema pjsdas_rows_candidate from public,anon,authenticated;
revoke all on all functions in schema pjsdas_rows_candidate from public,anon,authenticated;
grant usage on schema pjsdas_rows_candidate to service_role;
grant select,insert,update,delete on all tables in schema pjsdas_rows_candidate to service_role;
grant execute on all functions in schema pjsdas_rows_candidate to service_role;

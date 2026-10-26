-- ISOLATED LOCAL CANDIDATE, NOT A PRODUCTION MIGRATION OR ACTIVATION.
-- No new authority family, exposed schema, SECURITY DEFINER, or public client
-- EXECUTE. First-party proof is attested by the existing authenticated backend;
-- v3 proof is the original current grant, checked BEFORE any document bytes.
create function pjsdas_rows_internal.authorize_audit_read(proof jsonb,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if jsonb_typeof(proof) is distinct from 'object' or proof->>'userId' is distinct from target_user_id::text then
  raise exception 'audit owner authority absent' using errcode='42501';end if;
 if proof->>'principal'='first_party_web' then
  if (proof-array['userId','principal'])<>'{}'::jsonb then raise exception 'invalid first party read authority' using errcode='42501';end if;
 elsif proof->>'principal'='delegated_mcp' and proof->>'family'='opportunity_v3' then
  if (proof-array['userId','principal','family','grantId','grantRevision','clientId'])<>'{}'::jsonb then raise exception 'invalid v3 read authority' using errcode='42501';end if;
  perform 1 from public.pjsdas_business_management_grants g where g.id=(proof->>'grantId')::uuid and g.user_id=target_user_id
   and g.client_id::text=proof->>'clientId' and g.revision=(proof->>'grantRevision')::bigint
   and g.capability='workspace.opportunity.manage' and g.consent_version=3 and g.revoked_at is null and g.granted_at<=now() for share;
  if not found then raise exception 'original audit grant absent or changed' using errcode='42501';end if;
 else raise exception 'unsupported audit read authority' using errcode='42501';end if;
end$$;

create function pjsdas_rows_internal.audit_descriptor(doc jsonb,target_epoch uuid,target_revision bigint,raw_bytes bytea default null) returns jsonb
language sql immutable security invoker set search_path=pg_catalog as $$
 with bytes as materialized(select coalesce(raw_bytes,convert_to(doc::text,'UTF8')) value)
 select jsonb_build_object('protocol','workspace-audit-bytes-v1','workspaceId',doc->'workspace_id','userId',doc->'user_id',
  'epoch',target_epoch,'revision',target_revision,'commandId',doc->'command_id','resultingRevision',doc->'resulting_revision',
  'totalBytes',octet_length(bytes.value),'sha256',encode(sha256(bytes.value),'hex')) from bytes
$$;

create function pjsdas_rows_internal.audit_reference(doc jsonb,target_epoch uuid,target_revision bigint,proof jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare descriptor jsonb;ref jsonb;
begin
 perform pjsdas_rows_internal.authorize_audit_read(proof,(doc->>'user_id')::uuid);
 -- Scoped v3 does not acquire a universal large command-family reader.
 if proof->>'principal'='delegated_mcp' and (doc->>'principal_kind' is distinct from 'delegated_mcp'
  or doc#>>'{receipt,managementAuthorization,consentVersion}' is distinct from '3'
  or coalesce(doc->>'operation','') not in ('opportunity_management','undo_command')) then raise exception 'audit outside original v3 family' using errcode='42501';end if;
 descriptor:=pjsdas_rows_internal.audit_descriptor(doc,target_epoch,target_revision);
 ref:=jsonb_build_object('user_id',doc->'user_id','workspace_id',doc->'workspace_id','command_id',doc->'command_id','resulting_revision',doc->'resulting_revision','created_at',doc->'created_at','auditDocument',descriptor);
 -- This is the unchanged complete-history reader capability, not a quota.
 if octet_length(jsonb_build_object('outcome','HISTORY','workspaceId',doc->'workspace_id','userId',doc->'user_id','epoch',target_epoch,'revision',target_revision,'rows',jsonb_build_array(ref),'hasMore',false,'auditProtocol','workspace-audit-bytes-v1')::text)>2097152
 or octet_length((descriptor||jsonb_build_object('documentKey',doc->'command_id','offset',0,'base64',repeat('A',87384)))::text)>2097152
 or (descriptor->>'totalBytes')::bigint+octet_length(ref::text)+2>33554432 then raise exception 'complete audit exceeds existing materialization capability' using errcode='22023';end if;
 return ref;
end$$;

create function pjsdas_rows_candidate.read_audit_fragment(document jsonb,byte_offset bigint,proof jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare h pjsdas_rows_candidate.head%rowtype;doc jsonb;descriptor jsonb;bytes bytea;ref jsonb;
begin
 perform pjsdas_rows_internal.authorize_audit_read(proof,(document->>'userId')::uuid);
 perform pjsdas_rows_internal.require_active_layout((document->>'userId')::uuid,(document->>'epoch')::uuid);
 select * into h from pjsdas_rows_candidate.head where id=(document->>'workspaceId')::uuid and user_id=(document->>'userId')::uuid;
 if not found or h.epoch is distinct from (document->>'epoch')::uuid or h.revision is distinct from (document->>'revision')::bigint or h.format is distinct from 'workspace-rows-v1' then
  return jsonb_build_object('outcome','CONFLICT');end if;
 perform pjsdas_rows_internal.assert_discovery_history(h.user_id);
 select to_jsonb(l) into doc from pjsdas_rows_internal.discovery_history l where l.workspace_id=h.id and l.user_id=h.user_id
  and l.command_id=document->>'commandId' and l.status='COMMITTED' and l.resulting_revision<=h.revision;
 if doc is null then raise exception 'original audit absent' using errcode='42501';end if;
 if proof->>'principal'='delegated_mcp' and (doc->>'principal_kind' is distinct from 'delegated_mcp'
  or doc#>>'{receipt,managementAuthorization,consentVersion}' is distinct from '3'
  or coalesce(doc->>'operation','') not in ('opportunity_management','undo_command')) then raise exception 'audit outside original v3 family' using errcode='42501';end if;
 bytes:=convert_to(doc::text,'UTF8');descriptor:=pjsdas_rows_internal.audit_descriptor(doc,h.epoch,h.revision,bytes);
 if octet_length(bytes)>33554432 then raise exception 'complete audit exceeds existing materialization capability' using errcode='22023';end if;
 if descriptor is distinct from document then raise exception 'audit binding or digest differs' using errcode='PT409';end if;
 if byte_offset is null or byte_offset<0 or byte_offset>=octet_length(bytes) or byte_offset%65536<>0 then raise exception 'invalid audit byte offset' using errcode='22023';end if;
 return descriptor||jsonb_build_object('documentKey',document->'commandId','offset',byte_offset,'base64',replace(encode(substring(bytes from (byte_offset+1)::integer for 65536),'base64'),E'\n',''));
end$$;

-- Pure bounded wire packing, without database reads or authority. Only the
-- authorized page endpoint below supplies stored bytes to this helper.
create function pjsdas_rows_internal.pack_audit_page(descriptor jsonb,byte_offset bigint,bytes bytea) returns jsonb
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare page jsonb;part jsonb;parts jsonb[]:='{}'::jsonb[];page_bytes bigint;part_bytes bigint;at bigint;n integer:=0;
begin
 if octet_length(bytes)>33554432 then raise exception 'complete audit exceeds existing materialization capability' using errcode='22023';end if;
 if byte_offset is null or byte_offset<0 or byte_offset>=octet_length(bytes) or byte_offset%65536<>0 then raise exception 'invalid audit byte offset' using errcode='22023';end if;
 -- Authorization/grant lock and the generation proof cover this single
 -- page transaction, not 16 independently reauthorized HTTP requests. The
 -- client keeps every byte provisional until the original final fences.
 page:=jsonb_build_object('protocol','workspace-audit-page-v1','document',descriptor,'offset',byte_offset,'fragments','[]'::jsonb);
 page_bytes:=octet_length(page::text);at:=byte_offset;
 while at<octet_length(bytes) and n<16 loop
  part:=jsonb_build_object('offset',at,'base64',replace(encode(substring(bytes from (at+1)::integer for 65536),'base64'),E'\n',''));
  part_bytes:=octet_length(part::text)+case when n>0 then 2 else 0 end;
  -- No larger fragment, response page, history capability or time budget.
  if page_bytes+part_bytes>2097152 then exit;end if;
  parts:=array_append(parts,part);page_bytes:=page_bytes+part_bytes;n:=n+1;at:=at+65536;
 end loop;
 if n=0 then raise exception 'complete audit page exceeds existing body capability' using errcode='22023';end if;
 page:=page||jsonb_build_object('fragments',parts);
 if octet_length(page::text)>2097152 then raise exception 'audit page body capability exceeded' using errcode='22023';end if;
 return page;
end$$;

-- Optional request aggregation only; original fragment RPC stays unchanged.
create function pjsdas_rows_candidate.read_audit_page(document jsonb,byte_offset bigint,proof jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare h pjsdas_rows_candidate.head%rowtype;doc jsonb;descriptor jsonb;bytes bytea;ref jsonb;
begin
 perform pjsdas_rows_internal.authorize_audit_read(proof,(document->>'userId')::uuid);
 perform pjsdas_rows_internal.require_active_layout((document->>'userId')::uuid,(document->>'epoch')::uuid);
 select * into h from pjsdas_rows_candidate.head where id=(document->>'workspaceId')::uuid and user_id=(document->>'userId')::uuid;
 if not found or h.epoch is distinct from (document->>'epoch')::uuid or h.revision is distinct from (document->>'revision')::bigint or h.format is distinct from 'workspace-rows-v1' then
  return jsonb_build_object('outcome','CONFLICT');end if;
 perform pjsdas_rows_internal.assert_discovery_history(h.user_id);
 select to_jsonb(l) into doc from pjsdas_rows_internal.discovery_history l where l.workspace_id=h.id and l.user_id=h.user_id
  and l.command_id=document->>'commandId' and l.status='COMMITTED' and l.resulting_revision<=h.revision;
 if doc is null then raise exception 'original audit absent' using errcode='42501';end if;
 if proof->>'principal'='delegated_mcp' and (doc->>'principal_kind' is distinct from 'delegated_mcp'
  or doc#>>'{receipt,managementAuthorization,consentVersion}' is distinct from '3'
  or coalesce(doc->>'operation','') not in ('opportunity_management','undo_command')) then raise exception 'audit outside original v3 family' using errcode='42501';end if;
 bytes:=convert_to(doc::text,'UTF8');descriptor:=pjsdas_rows_internal.audit_descriptor(doc,h.epoch,h.revision,bytes);
 if octet_length(bytes)>33554432 then raise exception 'complete audit exceeds existing materialization capability' using errcode='22023';end if;
 if descriptor is distinct from document then raise exception 'audit binding or digest differs' using errcode='PT409';end if;
 if byte_offset is null or byte_offset<0 or byte_offset>=octet_length(bytes) or byte_offset%65536<>0 then raise exception 'invalid audit byte offset' using errcode='22023';end if;
 return pjsdas_rows_internal.pack_audit_page(descriptor,byte_offset,bytes);
end$$;

create function pjsdas_rows_candidate.read_audit_fence(target_user_id uuid,target_workspace_id uuid,target_epoch uuid,target_revision bigint,proof jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare h pjsdas_rows_candidate.head%rowtype;
begin
 -- Same original grant -> head order; readers never lock a stage or upgrade
 -- a shared head lock into a write. A concurrent writer is merely serialized.
 perform pjsdas_rows_internal.authorize_audit_read(proof,target_user_id);
 perform pjsdas_rows_internal.require_active_layout(target_user_id,target_epoch);
 select * into h from pjsdas_rows_candidate.head where id=target_workspace_id and user_id=target_user_id for share;
 if not found or h.epoch is distinct from target_epoch or h.revision is distinct from target_revision then return jsonb_build_object('outcome','CONFLICT');end if;
 perform pjsdas_rows_internal.assert_discovery_history(target_user_id);
 return jsonb_build_object('outcome','FENCED','userId',h.user_id,'workspaceId',h.id,'epoch',h.epoch,'revision',h.revision);
end$$;

-- Called within the original staged finalizer AFTER insertion, in that SAME
-- transaction. Missing capability or any unreadable result aborts the commit.
create function pjsdas_rows_internal.assert_large_audit_readable(req jsonb,target_workspace_id uuid,target_user_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare doc jsonb;h pjsdas_rows_candidate.head%rowtype;ref jsonb;probe jsonb;owner_proof jsonb;fragment jsonb;i integer;probe_bytes bytea;
begin
 if to_regprocedure('public.pjsdas_rows_v1_read_history(uuid,uuid,bigint,jsonb)') is null
 or to_regprocedure('public.pjsdas_rows_v1_read_audit_fragment(jsonb,bigint,jsonb)') is null
 or to_regprocedure('public.pjsdas_rows_v1_read_audit_fence(uuid,uuid,uuid,bigint,jsonb)') is null
 or to_regprocedure('pjsdas_rows_candidate.read_audit_fragment(jsonb,bigint,jsonb)') is null
 or to_regprocedure('pjsdas_rows_candidate.read_audit_fence(uuid,uuid,uuid,bigint,jsonb)') is null
 then raise exception 'complete audit reader capability absent' using errcode='22023';end if;
 if not has_function_privilege('service_role','public.pjsdas_rows_v1_read_history(uuid,uuid,bigint,jsonb)','EXECUTE')
 or not has_function_privilege('service_role','public.pjsdas_rows_v1_read_audit_fragment(jsonb,bigint,jsonb)','EXECUTE')
 or not has_function_privilege('service_role','public.pjsdas_rows_v1_read_audit_fence(uuid,uuid,uuid,bigint,jsonb)','EXECUTE')
 or not has_function_privilege('service_role','pjsdas_rows_candidate.read_audit_fragment(jsonb,bigint,jsonb)','EXECUTE')
 or not has_function_privilege('service_role','pjsdas_rows_candidate.read_audit_fence(uuid,uuid,uuid,bigint,jsonb)','EXECUTE')
 then raise exception 'complete audit reader execute absent' using errcode='22023';end if;
 if req->>'auditReadProtocol' is distinct from 'workspace-audit-bytes-v1' then raise exception 'audit reader not negotiated' using errcode='22023';end if;
 select * into h from pjsdas_rows_candidate.head where id=target_workspace_id and user_id=target_user_id;
 select to_jsonb(l) into doc from pjsdas_rows_internal.discovery_history l where l.workspace_id=h.id and l.user_id=h.user_id and l.command_id=req->>'commandId' and l.status='COMMITTED';
 if doc is null then raise exception 'audit result not readable' using errcode='22023';end if;
 -- This only tests complete reader eligibility under the already-authorized
-- original finalizer. It grants no externally callable owner authority.
 owner_proof:=jsonb_build_object('userId',target_user_id,'principal','first_party_web');
 ref:=pjsdas_rows_internal.audit_reference(doc,h.epoch,h.revision,owner_proof);
 -- Exercise the actual public history entry, not a local version flag or a
 -- function-name existence proxy. Old readers that ignore negotiation refuse.
 if req ? 'auditReadPageProtocol' and req->>'auditReadPageProtocol' is distinct from 'workspace-audit-page-v1' then raise exception 'audit page reader not negotiated' using errcode='22023';end if;
 probe:=public.pjsdas_rows_v1_read_history(target_user_id,h.epoch,h.revision,jsonb_build_object('mode','command','commandId',req->>'commandId','auditProtocol','workspace-audit-bytes-v1','auditAuthorization',owner_proof)||case when req ? 'auditReadPageProtocol' then jsonb_build_object('auditPageProtocol',req->'auditReadPageProtocol') else '{}'::jsonb end);
 if req ? 'auditReadPageProtocol' and probe->>'auditPageProtocol' is distinct from req->>'auditReadPageProtocol' then raise exception 'installed public history lacks audit page protocol' using errcode='22023';end if;
 if probe->>'auditProtocol' is distinct from 'workspace-audit-bytes-v1' or probe->>'outcome' is distinct from 'HISTORY'
 or probe->'rows' is distinct from jsonb_build_array(ref) then raise exception 'installed public history lacks complete audit protocol' using errcode='22023';end if;
 probe:=public.pjsdas_rows_v1_read_audit_fragment(ref->'auditDocument',0,owner_proof);
 if probe->>'sha256' is distinct from ref#>>'{auditDocument,sha256}' or probe->'totalBytes' is distinct from ref#>'{auditDocument,totalBytes}'
 or probe->'base64' is distinct from to_jsonb(replace(encode(substring(convert_to(doc::text,'UTF8') from 1 for 65536),'base64'),E'\n',''))
 then raise exception 'installed public fragment lacks complete audit protocol' using errcode='22023';end if;
 if req ? 'auditReadPageProtocol' then
  probe:=public.pjsdas_rows_v1_read_audit_page(ref->'auditDocument',0,owner_proof);
  if probe->>'protocol' is distinct from 'workspace-audit-page-v1' or probe->'document' is distinct from ref->'auditDocument'
   or probe->'offset' is distinct from '0'::jsonb or jsonb_typeof(probe->'fragments') is distinct from 'array'
   or octet_length(probe::text)>2097152 then raise exception 'installed public page lacks complete audit protocol' using errcode='22023';end if;
  if jsonb_array_length(probe->'fragments') not between 1 and 16 then raise exception 'installed public page fragment count invalid' using errcode='22023';end if;
  probe_bytes:=convert_to(doc::text,'UTF8');
  for i in 0..jsonb_array_length(probe->'fragments')-1 loop
   fragment:=probe->'fragments'->i;
   if i::bigint*65536>=(ref#>>'{auditDocument,totalBytes}')::bigint
    or fragment is distinct from jsonb_build_object('offset',i::bigint*65536,'base64',replace(encode(substring(probe_bytes from i*65536+1 for 65536),'base64'),E'\n',''))
    then raise exception 'installed public page fragment differs' using errcode='22023';end if;
  end loop;
 end if;
end$$;

create function public.pjsdas_rows_v1_read_audit_fragment(document jsonb,byte_offset bigint,proof jsonb) returns jsonb
language sql security invoker set search_path=pg_catalog as $$ select pjsdas_rows_candidate.read_audit_fragment($1,$2,$3) $$;
create function public.pjsdas_rows_v1_read_audit_page(document jsonb,byte_offset bigint,proof jsonb) returns jsonb
language sql security invoker set search_path=pg_catalog as $$ select pjsdas_rows_candidate.read_audit_page($1,$2,$3) $$;
create function public.pjsdas_rows_v1_read_audit_fence(target_user_id uuid,target_workspace_id uuid,target_epoch uuid,target_revision bigint,proof jsonb) returns jsonb
language sql security invoker set search_path=pg_catalog as $$ select pjsdas_rows_candidate.read_audit_fence($1,$2,$3,$4,$5) $$;

revoke all on function pjsdas_rows_internal.authorize_audit_read(jsonb,uuid),pjsdas_rows_internal.audit_descriptor(jsonb,uuid,bigint,bytea),pjsdas_rows_internal.audit_reference(jsonb,uuid,bigint,jsonb),pjsdas_rows_internal.assert_large_audit_readable(jsonb,uuid,uuid),pjsdas_rows_candidate.read_audit_fragment(jsonb,bigint,jsonb),pjsdas_rows_candidate.read_audit_fence(uuid,uuid,uuid,bigint,jsonb),public.pjsdas_rows_v1_read_audit_fragment(jsonb,bigint,jsonb),public.pjsdas_rows_v1_read_audit_fence(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.authorize_audit_read(jsonb,uuid),pjsdas_rows_internal.audit_descriptor(jsonb,uuid,bigint,bytea),pjsdas_rows_internal.audit_reference(jsonb,uuid,bigint,jsonb),pjsdas_rows_internal.assert_large_audit_readable(jsonb,uuid,uuid),pjsdas_rows_candidate.read_audit_fragment(jsonb,bigint,jsonb),pjsdas_rows_candidate.read_audit_fence(uuid,uuid,uuid,bigint,jsonb),public.pjsdas_rows_v1_read_audit_fragment(jsonb,bigint,jsonb),public.pjsdas_rows_v1_read_audit_fence(uuid,uuid,uuid,bigint,jsonb) to service_role;

revoke all on function pjsdas_rows_candidate.read_audit_page(jsonb,bigint,jsonb),public.pjsdas_rows_v1_read_audit_page(jsonb,bigint,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.read_audit_page(jsonb,bigint,jsonb),public.pjsdas_rows_v1_read_audit_page(jsonb,bigint,jsonb) to service_role;

revoke all on function pjsdas_rows_internal.pack_audit_page(jsonb,bigint,bytea) from public,anon,authenticated;
grant execute on function pjsdas_rows_internal.pack_audit_page(jsonb,bigint,bytea) to service_role;

-- Isolated reader contract. No public production entry or grant is changed.
-- Retained and new history form one logical command namespace after cutover.
create function pjsdas_rows_candidate.read_history(target_user_id uuid,target_epoch uuid,target_revision bigint,query jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,pjsdas_rows_candidate as $$
declare h pjsdas_rows_candidate.head%rowtype;mode text:=query->>'mode';result jsonb[]:='{}'::jsonb[];maximum integer;history_row record;row_json jsonb;bytes bigint:=2;n integer:=0;more boolean:=false;cycle_page boolean;wire_overhead bigint:=0;response jsonb;
begin
 if query ? 'auditPageProtocol' then
  if query->>'auditProtocol' is distinct from 'workspace-audit-bytes-v1' or query->>'auditPageProtocol' is distinct from 'workspace-audit-page-v1'
   then raise exception 'unsupported audit page protocol' using errcode='22023';end if;
  if to_regprocedure('public.pjsdas_rows_v1_read_audit_page(jsonb,bigint,jsonb)') is null
   or to_regprocedure('pjsdas_rows_candidate.read_audit_page(jsonb,bigint,jsonb)') is null then raise exception 'audit page capability absent' using errcode='22023';end if;
  if not has_function_privilege('service_role','public.pjsdas_rows_v1_read_audit_page(jsonb,bigint,jsonb)','EXECUTE')
   or not has_function_privilege('service_role','pjsdas_rows_candidate.read_audit_page(jsonb,bigint,jsonb)','EXECUTE') then raise exception 'audit page execute absent' using errcode='22023';end if;
 end if;
 if query ? 'auditProtocol' then
  if query->>'auditProtocol' is distinct from 'workspace-audit-bytes-v1' then raise exception 'unsupported audit protocol' using errcode='22023';end if;
  perform pjsdas_rows_internal.authorize_audit_read(query->'auditAuthorization',target_user_id);
 end if;
 select * into h from pjsdas_rows_candidate.head where user_id=target_user_id;
 if not found or h.epoch is distinct from target_epoch or h.revision is distinct from target_revision then
 return jsonb_build_object('outcome','CONFLICT');end if;
 if jsonb_typeof(query) is distinct from 'object' or mode is null or mode not in ('command','after','latest_discovery','discovery_scope') then raise exception 'unsupported history query' using errcode='22023';end if;
 if mode='command' and (jsonb_typeof(query->'commandId') is distinct from 'string' or nullif(query->>'commandId','') is null) then raise exception 'command identity missing' using errcode='22023';end if;
 if mode='after' and (coalesce(query->>'afterRevision','') !~ '^(0|[1-9][0-9]*)$' or (query->>'afterRevision')::numeric>h.revision
 or coalesce(query->>'cursorRevision','') !~ '^(0|[1-9][0-9]*)$' or jsonb_typeof(query->'cursorCommand') is distinct from 'string') then raise exception 'history cursor invalid' using errcode='22023';end if;
 if mode in ('latest_discovery','discovery_scope') and (nullif(query->>'sourceId','') is null or length(query->>'sourceId')>180 or coalesce(query->>'scopeFingerprint','') !~ '^[a-f0-9]{64}$') then raise exception 'search history scope invalid' using errcode='22023';end if;
 if mode='discovery_scope' and (coalesce(query->>'planFingerprint','') !~ '^[a-f0-9]{64}$' or (query ? 'cycleId' and coalesce(query->>'cycleId','') !~ '^[a-f0-9]{64}$')) then raise exception 'search cycle invalid' using errcode='22023';end if;
 cycle_page:=mode='discovery_scope' and query ? 'cycleId';
 if cycle_page and (query ?| array['cursorCreatedAt','cursorCount','cursorCommand','cursorRevision']) and not (query ?& array['cursorCreatedAt','cursorCount','cursorCommand','cursorRevision']) then raise exception 'partial history cursor' using errcode='22023';end if;
 if cycle_page and query ? 'cursorCreatedAt' and (jsonb_typeof(query->'cursorCreatedAt') is distinct from 'string'
  or coalesce(query->>'cursorRevision','') !~ '^(0|[1-9][0-9]*)$' or jsonb_typeof(query->'cursorCommand') is distinct from 'string'
  or coalesce(query->>'cursorCount','') !~ '^(0|[1-9][0-9]*)$' or (query->>'cursorCount')::numeric>=161) then
  raise exception 'history cycle cursor invalid' using errcode='22023';end if;
 perform pjsdas_rows_internal.assert_discovery_history(target_user_id);
 if query ? 'auditProtocol' then wire_overhead:=octet_length(jsonb_build_object('outcome','HISTORY','workspaceId',h.id,'userId',h.user_id,'epoch',h.epoch,'revision',h.revision,'rows','[]'::jsonb,'hasMore',false,'auditProtocol','workspace-audit-bytes-v1')::text)-2;
  if query ? 'auditPageProtocol' then wire_overhead:=wire_overhead+octet_length(jsonb_build_object('auditPageProtocol','workspace-audit-page-v1')::text);end if;end if;
 maximum:=case when mode='after' then 128 when cycle_page then 161-coalesce((query->>'cursorCount')::integer,0) else 1 end;
 for history_row in select l.* from pjsdas_rows_internal.discovery_history l
  where l.user_id=target_user_id and l.workspace_id=h.id and l.status='COMMITTED' and l.resulting_revision<=h.revision
  and case mode
   when 'command' then l.command_id=query->>'commandId'
   when 'after' then l.resulting_revision>(query->>'afterRevision')::bigint and (l.resulting_revision,l.command_id collate "C")>((query->>'cursorRevision')::bigint,(query->>'cursorCommand') collate "C")
   else l.principal_kind='automation' and l.provenance->>'sourceId'=query->>'sourceId' and l.provenance->>'scopeFingerprint'=query->>'scopeFingerprint'
    and l.provenance->>'producer'='server_scheduler'
    and case when mode='latest_discovery' then l.operation='ingest_verified_discovery'
      else l.provenance->>'searchPlanFingerprint'=query->>'planFingerprint' and case when query ? 'cycleId' then l.provenance->>'searchCycleId'=query->>'cycleId'
        else l.operation='checkpoint_discovery_search' and l.provenance->>'searchPhase'='claimed' and l.provenance->>'searchBatchIndex'='0' end end
   end
  and (not cycle_page or not (query ? 'cursorCreatedAt') or (l.created_at,l.resulting_revision,l.command_id collate "C")<((query->>'cursorCreatedAt')::timestamptz,(query->>'cursorRevision')::bigint,(query->>'cursorCommand') collate "C"))
  order by case when mode='after' then l.resulting_revision end asc,
    case when mode='after' then l.command_id end collate "C" asc,
    case when mode<>'after' then l.created_at end desc,l.resulting_revision desc,l.command_id collate "C" desc
  limit maximum loop
   row_json:=to_jsonb(history_row);
   if octet_length(row_json::text)+2+wire_overhead>2097152 then
    if query->>'auditProtocol' is distinct from 'workspace-audit-bytes-v1' then raise exception 'history row exceeds candidate read eligibility' using errcode='22023';end if;
    row_json:=pjsdas_rows_internal.audit_reference(row_json,h.epoch,h.revision,query->'auditAuthorization');
   end if;
   if query ? 'auditProtocol' and wire_overhead+2+octet_length(row_json::text)>2097152 then raise exception 'complete history row exceeds existing body capability' using errcode='22023';end if;
   if (mode='after' and n=127) or wire_overhead+bytes+octet_length(row_json::text)+(case when n>0 then 2 else 0 end)>2097152 then more:=true;exit;end if;
   result:=array_append(result,row_json);bytes:=bytes+octet_length(row_json::text)+(case when n>0 then 2 else 0 end);n:=n+1;
  end loop;
 response:=jsonb_build_object('outcome','HISTORY','workspaceId',h.id,'userId',h.user_id,'epoch',h.epoch,'revision',h.revision,'rows',result,'hasMore',more)||case when query ? 'auditProtocol' then jsonb_build_object('auditProtocol','workspace-audit-bytes-v1') else '{}'::jsonb end||case when query ? 'auditPageProtocol' then jsonb_build_object('auditPageProtocol','workspace-audit-page-v1') else '{}'::jsonb end;
 if query ? 'auditProtocol' and octet_length(response::text)>2097152 then raise exception 'history body capability exceeded' using errcode='22023';end if;
 return response;
end$$;
revoke all on function pjsdas_rows_candidate.read_history(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function pjsdas_rows_candidate.read_history(uuid,uuid,bigint,jsonb) to service_role;

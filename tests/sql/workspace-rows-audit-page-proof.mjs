/** Additional page-only counterexamples. Synthetic existing-loopback resources;
 * no cache, compression transport, persistent storage, provider or raised cap. */
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {gzipSync} from 'node:zlib'
import {stagedOpportunityFixture} from '../fixtures/workspaceRowsStagedOpportunity.ts'
import {applyOpportunityManagement,readOpportunityManagement,restoreOpportunityManagement} from '../../src/opportunityManagement.ts'
import {createTransactionalWorkspaceStore} from '../../gateway/transactionalWorkspaceStore.ts'
import {PJSDAS_SUPABASE_URL} from '../../gateway/supabaseProject.ts'
import {createAuditMeasure} from './workspace-rows-audit-measure.mjs'
const wire=x=>JSON.parse(JSON.stringify(x))
const names=async()=>(await readdir(tmpdir())).filter(x=>x.startsWith('ta-audit-read-')).sort()
// Deterministic synthetic entropy, deliberately not compressed by transport.
const entropy=n=>Array.from({length:Math.ceil(n/64)},(_,i)=>createHash('sha512').update('synthetic-audit-entropy-'+i).digest('base64')).join('').slice(0,n)
export async function runAuditPageCounterexamples(h){
 const {db,seed,scopedFixture,reserve,current,count,cold,coldPost,post,rpc,serviceToken,jwt,calls,auditHooks,x,record,total,authorization,initialSpools}=h,measure=createAuditMeasure(db,calls)
 const proof={userId:x.vIds.userId,principal:'first_party_web'}
 const reference=await rpc('pjsdas_rows_v1_read_history',{target_user_id:x.vIds.userId,target_epoch:x.vIds.epoch,target_revision:2,query:{mode:'command',commandId:x.vf.commandId,auditProtocol:'workspace-audit-bytes-v1',auditPageProtocol:'workspace-audit-page-v1',auditAuthorization:proof}})
 assert.equal(reference.status,200);assert.equal(reference.body.auditPageProtocol,'workspace-audit-page-v1');const document=reference.body.rows[0].auditDocument
 let assembled=[],pageBytes=[],fragments=0
 for(let offset=0;offset<total;){
  const result=await rpc('pjsdas_rows_v1_read_audit_page',{document,byte_offset:offset,proof});assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.body.document,document)
  const size=Buffer.byteLength(JSON.stringify(result.body));assert(size<=2097152);pageBytes.push(size);assert(result.body.fragments.length<=16&&result.body.fragments.length>0)
  for(const part of result.body.fragments){assert.equal(part.offset,offset);const bytes=Buffer.from(part.base64,'base64');assert.equal(bytes.length,Math.min(65536,total-offset));assembled.push(bytes);offset+=bytes.length;fragments++}
 }
 const raw=Buffer.concat(assembled);assert.equal(fragments,33);assert.equal(pageBytes.length,3);assert.equal(createHash('sha256').update(raw).digest('hex'),document.sha256);assert.deepEqual(JSON.parse(raw),record)
 console.log('PASS AUDIT_PAGES_EXACT original33 unchanged64KiB fragments in3 bounded pages; exact original2106241bytes/SHA/V5',JSON.stringify({pageBytes,total,fragments,pageAuthorizationTransactions:3,finalFencesRequired:2}))
 for(const [field,value] of [['userId',randomUUID()],['workspaceId',randomUUID()],['epoch',randomUUID()],['revision',1],['commandId','synthetic-foreign'],['sha256','f'.repeat(64)],['totalBytes',total-1],['resultingRevision',0]]){
  const bad=await rpc('pjsdas_rows_v1_read_audit_page',{document:{...document,[field]:value},byte_offset:0,proof});assert([403,409].includes(bad.status)||bad.status===200&&bad.body.outcome==='CONFLICT',JSON.stringify({field,bad}));assert.equal(bad.body.fragments,undefined)
 }
 for(const offset of [-1,1,total,Number.MAX_SAFE_INTEGER])assert.equal((await rpc('pjsdas_rows_v1_read_audit_page',{document,byte_offset:offset,proof})).status,400)
 for(const role of ['anon','authenticated'])assert([401,403].includes((await rpc('pjsdas_rows_v1_read_audit_page',{document,byte_offset:0,proof},jwt({role}))).status))
 for(const badProof of [{...authorization,grantRevision:authorization.grantRevision+1},{...authorization,clientId:'foreign'},{...authorization,family:'planning_v3'}])assert.equal((await rpc('pjsdas_rows_v1_read_audit_page',{document,byte_offset:0,proof:badProof})).status,403)
 console.log('PASS AUDIT_PAGE_BINDING unchanged owner/workspace/epoch/revision/resultingRevision/command/size/SHA/offset/authority and public ACL deny before page bytes')
 // Corrupt an interior fragment, including an extra tail AFTER all valid bytes.
 for(const kind of ['duplicate','reordered','gap','empty','extra-tail','interior-bytes','descriptor','protocol']){
  auditHooks.push({match:(path,body)=>path.endsWith('read_audit_page')&&(kind==='extra-tail'?body.byte_offset+16*65536>=total:body.byte_offset===0),run:async({body})=>{
   const p=JSON.parse(Buffer.from(body).toString())
   if(kind==='duplicate')p.fragments[1].offset=p.fragments[0].offset
   if(kind==='reordered')p.fragments.reverse()
   if(kind==='gap')p.fragments[1].offset++
   if(kind==='empty')p.fragments=[]
   if(kind==='extra-tail')p.fragments.push({offset:Math.ceil(total/65536)*65536,base64:'YQ=='})
   if(kind==='interior-bytes'){const b=Buffer.from(p.fragments[7].base64,'base64');b[0]^=1;p.fragments[7].base64=b.toString('base64')}
   if(kind==='descriptor')p.document.resultingRevision++
   if(kind==='protocol')p.protocol='unnegotiated'
   return Buffer.from(JSON.stringify(p))
  }})
  const bad=await post(x.vIds,{action:'receipt',commandId:x.vf.commandId});assert.notEqual(bad.status,200,kind);assert.equal(auditHooks.length,0,JSON.stringify({kind,bad}));assert.deepEqual(await names(),initialSpools)
 }
 // Exact ACK is required on the real entry, even on empty lookups; no retry
 // of an unavailable page endpoint through the old fragment endpoint.
 for(const missing of [false,true]){
  const offset=calls.length
  auditHooks.push({match:path=>path.endsWith('read_history'),run:async({body})=>{const p=JSON.parse(Buffer.from(body).toString());delete p.auditPageProtocol;return Buffer.from(JSON.stringify(p))}})
  const bad=await post(x.vIds,{action:'receipt',commandId:missing?'synthetic-missing-page-command':x.vf.commandId});assert.notEqual(bad.status,200);assert(!calls.slice(offset).some(c=>c.path.endsWith('read_audit_page')||c.path.endsWith('read_audit_fragment')))
 }
 const signature='public.pjsdas_rows_v1_read_audit_page(jsonb,bigint,jsonb)',definition=(await db.query('select pg_get_functiondef($1::regprocedure) body',[signature])).rows[0].body
 await db.query('drop function '+signature);const missing=await coldPost(x.vIds,{action:'receipt',commandId:x.vf.commandId});assert.equal(missing.status,400)
 await db.query(definition);await db.query('revoke all on function '+signature+' from public,anon,authenticated;grant execute on function '+signature+' to service_role')
 console.log('PASS AUDIT_PAGE_FAULTS interior/extra-tail page corruption, empty/missing ACK and missing endpoint reject without fallback or leftover spools')
 // Existing function name/ACL cannot stand in for actual selected capability.
 for(const fault of ['wrong-protocol','wrong-fragment','oversized-envelope']){
  const fake=fault==='wrong-protocol'?"'{}'::jsonb":fault==='wrong-fragment'?"jsonb_set(pjsdas_rows_candidate.read_audit_page($1,$2,$3),'{fragments,0,base64}','\"YQ==\"'::jsonb)":"pjsdas_rows_candidate.read_audit_page($1,$2,$3)||jsonb_build_object('unknown',repeat('x',2097152))"
  await db.query('create or replace function public.pjsdas_rows_v1_read_audit_page(document jsonb,byte_offset bigint,proof jsonb) returns jsonb language sql security invoker set search_path=pg_catalog as $$select '+fake+'$$')
  const bad=await scopedFixture(2050),result=await bad.scoped.opportunity.invoke('execute_opportunity_management',{commandId:bad.vf.commandId,baseRevision:0,change:bad.vf.input})
  assert.equal(result.isError,true,JSON.stringify({fault,result}));assert.equal(result.structuredContent.code,'WORKSPACE_INVALID');assert.equal(await count(bad.vIds.userId),0);assert.equal((await current(bad.vIds)).revision,0)
  await db.query(definition)
 }
 console.log('PASS AUDIT_PAGE_ATOMIC_CAPABILITY wrong implementation/protocol/fragment or oversized envelope refuses original complete immutable publication inside finalizer')
 // Exact same original receipt, alternating selected transport. This is a
 // loopback paired micro/end-to-end read sample, never a remote RTT proof.
 for(const pages of [false,true]){
  process.env.PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES=pages?'1':'0'
  const token=await measure.start('paired-original-api-receipt-'+(pages?'pages':'fragments')),result=await coldPost(x.vIds,{action:'receipt',commandId:x.vf.commandId,projection:'delta-v1'});await measure.end(token)
  assert.equal(result.status,200);assert.deepEqual({...result.body.receipt,projectionDelta:result.body.delta},record.receipt)
 }
 const phases={jsonb_rebuild:'pg_column_size(value)',utf8_serialize:"octet_length(convert_to(value::text,'UTF8'))",sha256:"encode(sha256(convert_to(value::text,'UTF8')),'hex')"},plans=[]
 for(const [phase,expression] of Object.entries(phases))for(let sample=0;sample<3;sample++){
  const plan=(await db.query('explain(analyze,buffers,settings,format json) with doc as materialized(select to_jsonb(l) value from pjsdas_rows_internal.discovery_history l where user_id=$1 and command_id=$2) select '+expression+' from doc',[x.vIds.userId,x.vf.commandId])).rows[0]['QUERY PLAN'][0]
  plans.push({phase,sample,plan})
 }
 console.log('AUDIT_SQL_PHASE_PLANS',JSON.stringify({localOnly:true,notEndToEnd:true,plans}))
 // A real large indexed command ID may stop before the wire packer. Retain
 // that existing database boundary instead of dropping/widening an index.
 const giantId='synthetic-giant-'+('未来😀"\\'.repeat(90000));let giantBoundary
 try{await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt) values($1,$2,$3,'opportunity_management',repeat('b',64),'first_party_web','COMMITTED',1,'{}')",[x.vIds.workspaceId,x.vIds.userId,giantId]);giantBoundary='stored';await db.query('delete from public.pjsdas_command_ledger where user_id=$1 and command_id=$2',[x.vIds.userId,giantId])}catch(error){assert(['54000','54001'].includes(error.code),error.message);giantBoundary={code:error.code,message:error.message}}
 console.log('AUDIT_GIANT_INDEX_BOUNDARY',JSON.stringify({syntheticCommandIdBytes:Buffer.byteLength(giantId),result:giantBoundary,capChanged:false}))
 // Pure packer can exercise otherwise unstoreable envelope shapes in real
 // PostgreSQL, but this is NOT giant-ID endpoint eligibility or capacity proof.
 const synthetic=Buffer.alloc(16*65536,7)
 for(const keyBytes of [0,700000,1200000,1900000,1980000]){
  const d={...document,commandId:'未来😀"\\'.repeat(Math.ceil(keyBytes/14)),totalBytes:synthetic.length,sha256:createHash('sha256').update(synthetic).digest('hex')}
  const packed=(await db.query('select pjsdas_rows_internal.pack_audit_page($1,0,$2) value',[d,synthetic])).rows[0].value
  assert(Buffer.byteLength(JSON.stringify(packed))<=2097152);assert(packed.fragments.length>0&&packed.fragments.length<=16);if(keyBytes>=1200000)assert(packed.fragments.length<16)
  assert.equal(packed.fragments.at(-1).offset,(packed.fragments.length-1)*65536);console.log('AUDIT_PACKED_ENVELOPE',JSON.stringify({requestedKeyBytes:keyBytes,actualCommandBytes:Buffer.byteLength(d.commandId),jsonBytes:Buffer.byteLength(JSON.stringify(packed)),fragments:packed.fragments.length,syntheticPurePackerOnly:true}))
 }
 const huge={...document,commandId:'未来😀"\\'.repeat(210000)}
 await assert.rejects(db.query('select pjsdas_rows_internal.pack_audit_page($1,0,$2)',[huge,synthetic]),error=>error.code==='22023')
 const exact=(await db.query('select pjsdas_rows_internal.pack_audit_page($1,0,$2) value',[{...document,totalBytes:synthetic.length},synthetic])).rows[0].value
 assert.equal(exact.fragments.length,16);assert.equal(Buffer.from(exact.fragments.at(-1).base64,'base64').length,65536)
 console.log('PASS AUDIT_PAGE_PACKING realPG pure UTF8/escaped envelope dynamic1..16 packing, exact16-fragment ending and zero-fit rejection; giant indexed command remains separate capability boundary')

 // Real grant wait, not a mocked authority branch. Reader is blocked before
 // head and no page bytes are returned after revocation wins the grant lock.
 authorization.grantRevision=Number((await db.query('select revision from pjsdas_business_management_grants where id=$1',[x.grantId])).rows[0].revision)
 await db.query('begin');await db.query('select 1 from pjsdas_business_management_grants where id=$1 for update',[x.grantId])
 const waiting=rpc('pjsdas_rows_v1_read_audit_page',{document,byte_offset:0,proof:authorization});let observed=false
 try{
  for(let n=0;n<100;n++){await db.query('select pg_stat_clear_snapshot()');if((await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pjsdas_rows_v1_read_audit_page%' and pid<>pg_backend_pid()")).rows[0].n){observed=true;break}await new Promise(r=>setTimeout(r,10))}
  assert(observed);await db.query('select 1 from pjsdas_rows_candidate.head where id=$1 for update nowait',[x.vIds.workspaceId]);await db.query('update pjsdas_business_management_grants set revoked_at=clock_timestamp() where id=$1',[x.grantId]);await db.query('commit')
 }finally{await db.query('rollback')}
 assert.equal((await waiting).status,403);await db.query('update pjsdas_business_management_grants set revoked_at=null where id=$1',[x.grantId])
 console.log('PASS AUDIT_PAGE_LOCK original grant-before-head lock observed; winning revoke releases no page bytes')
 process.env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT='1'
 const durable=await scopedFixture(2050),durableInput={commandId:durable.vf.commandId,baseRevision:0,change:durable.vf.input}
 auditHooks.push({match:path=>path.endsWith('large_intent_admit'),run:async()=> 'disconnect'})
 const interrupted=await durable.scoped.opportunity.invoke('execute_opportunity_management',durableInput);assert.equal(interrupted.isError,true);assert.equal(await count(durable.vIds.userId),0)
 process.env.PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES='0'
 const originalIntent=(await db.query('select * from pjsdas_rows_candidate.large_command_intent where user_id=$1',[durable.vIds.userId])).rows[0]
 const beforeResume=calls.length
 const switched=await cold({mode:'scoped',userId:durable.vIds.userId,clientId:durable.clientId,tool:'execute_opportunity_management',body:durableInput});assert.equal(switched.isError,undefined,JSON.stringify(switched));assert.equal(switched.structuredContent.outcome,'COMMITTED');assert.equal(await count(durable.vIds.userId),1)
 assert.deepEqual((await db.query('select * from pjsdas_rows_candidate.large_command_intent where user_id=$1',[durable.vIds.userId])).rows[0],originalIntent)
 assert(!calls.slice(beforeResume).some(call=>call.path.endsWith('large_intent_admit')))
 const selected=(await db.query("select b.manifest_sha256,s.request->>'auditReadPageProtocol' page_protocol from pjsdas_rows_candidate.large_document_bundle b join pjsdas_rows_candidate.large_stage s on s.id=b.stage_id where b.stage_id=$1",[originalIntent.stage_id])).rows[0]
 assert.equal(selected.manifest_sha256,originalIntent.binding.manifestSha256);assert.equal(selected.page_protocol,'workspace-audit-page-v1')
 process.env.PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES='1'
 const recovered=await cold({mode:'scoped',userId:durable.vIds.userId,clientId:durable.clientId,tool:'execute_opportunity_management',body:durableInput});assert.equal(recovered.isError,undefined,JSON.stringify(recovered));assert.equal(recovered.structuredContent.outcome,'ALREADY_APPLIED');assert.equal(await count(durable.vIds.userId),1)
 process.env.PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT='0'
 console.log('PASS AUDIT_PAGE_DURABLE cold original admitted intent preserves selected page protocol/manifest/deadline; flag-switch recovers the original exact page manifest without re-evaluation; original-mode retry replays its single commit')

 // Independently recomputed real-core fixture; never replaces the retained
 // original long-ID identity proof above. Unknown action fields survive Undo.
 const vf=await stagedOpportunityFixture(2050),noise=entropy(2050*96)
 for(let i=0;i<vf.before.data.actions.length;i++){vf.before.data.actions[i].title=noise.slice(i*96,i*96+48);vf.before.data.actions[i].unknownForward={utf8:'未来😀"\\',entropy:noise.slice(i*96+48,(i+1)*96),optional:null}}
 const review=await readOpportunityManagement(vf.before,vf.before.data.opportunities[0].id);vf.input.operations[0].expectedFingerprint=review.archive.fingerprint;vf.input.operations[0].dependencies=review.archive.dependencies
 vf.result=await applyOpportunityManagement(vf.before,vf.input,vf.commandId,new Date(vf.at));assert.equal(vf.result.status,'APPLIED')
 const high=await scopedFixture(2050,false,vf),input={commandId:vf.commandId,baseRevision:0,change:vf.input}
 const commitM=await measure.start('high-entropy-2050-v3-archive'),saved=await high.scoped.opportunity.invoke('execute_opportunity_management',input);await measure.end(commitM);assert.equal(saved.isError,undefined,JSON.stringify(saved));assert.equal(await count(high.vIds.userId),1)
 const stored=(await db.query('select to_jsonb(l) row from pjsdas_rows_internal.discovery_history l where user_id=$1',[high.vIds.userId])).rows[0].row,after=await current(high.vIds)
 const replayM=await measure.start('high-entropy-2050-v3-cold-replay'),replay=await cold({mode:'scoped',userId:high.vIds.userId,clientId:high.clientId,tool:'execute_opportunity_management',body:input});await measure.end(replayM);assert.equal(replay.structuredContent.outcome,'ALREADY_APPLIED');assert.deepEqual(replay.structuredContent.result,saved.structuredContent.result)
 const beforeUndo=await coldPost(high.vIds,{action:'receipt',commandId:vf.commandId,projection:'delta-v1'});assert.equal(beforeUndo.status,200);assert.deepEqual({...beforeUndo.body.receipt,projectionDelta:beforeUndo.body.delta},stored.receipt)
 const undo='synthetic-high-entropy-undo';await reserve(high.vIds,undo,'opportunity_v3')
 const undoM=await measure.start('high-entropy-2050-v3-cold-undo'),undone=await cold({mode:'scoped',userId:high.vIds.userId,clientId:high.clientId,tool:'restore_opportunity_management',body:{commandId:undo,targetCommandId:vf.commandId,expectedCompensationFingerprint:stored.receipt.result.compensationFingerprint}});await measure.end(undoM)
 assert.equal(undone.isError,undefined,JSON.stringify(undone));assert.equal(await count(high.vIds.userId),2);const restored=await current(high.vIds);assert.deepEqual(restored.snapshot,wire(restoreOpportunityManagement(after.snapshot,stored.compensation,new Date(restored.snapshot.exportedAt))));assert.deepEqual(restored.snapshot.data.actions,vf.before.data.actions)
 console.log('PASS AUDIT_PAGE_HIGH_ENTROPY actual2050-long-ID archive/cold replay/API receipt/original protected Undo preserve random-looking unknown fields and full V5',JSON.stringify({logicalJsonBytes:Buffer.byteLength(JSON.stringify(stored)),transportCompression:false}))
 // High-entropy retained receipt is deliberately mostly incompressible; this
 // tests transport rather than a tiny compressed synthetic intent fixture.
 const entropyId='synthetic-high-entropy-retained',entropyReceipt={...record.receipt,commandId:entropyId,unknownForward:{utf8:'未来😀"\\',entropy:entropy(3*1024*1024)}}
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt,compensation) values($1,$2,$3,'opportunity_management',$4,'delegated_mcp','COMMITTED',1,$5,$6)",[high.vIds.workspaceId,high.vIds.userId,entropyId,'9'.repeat(64),entropyReceipt,stored.compensation])
 const entropyM=await measure.start('mostly-incompressible-retained-api-receipt'),large=await coldPost(high.vIds,{action:'receipt',commandId:entropyId,projection:'delta-v1'});await measure.end(entropyM);assert.equal(large.status,200,JSON.stringify(large).slice(0,200));assert.deepEqual({...large.body.receipt,projectionDelta:large.body.delta},entropyReceipt)
 const entropyBytes=Buffer.from(entropyReceipt.unknownForward.entropy);console.log('PASS AUDIT_PAGE_INCOMPRESSIBLE complete high-entropy unknown receipt fields without truncation or compressed transport',JSON.stringify({entropyBytes:entropyBytes.length,gzipBytes:gzipSync(entropyBytes).length,transportCompression:false}))
 // Multiple owners, deep retained history and non-target collision checks.
 const foreign=await seed(vf.before,true),foreignReceipt={...record.receipt,unknownForward:'foreign-owner-only'}
 await db.query('update pjsdas_rows_candidate.head set revision=1 where id=$1',[foreign.workspaceId])
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt,compensation) values($1,$2,$3,'opportunity_management',$4,'delegated_mcp','COMMITTED',1,$5,$6)",[foreign.workspaceId,foreign.userId,x.vf.commandId,'a'.repeat(64),foreignReceipt,record.compensation])
 const foreignResult=await coldPost(foreign,{action:'receipt',commandId:x.vf.commandId,projection:'delta-v1'});assert.equal(foreignResult.status,200);assert.deepEqual({...foreignResult.body.receipt,projectionDelta:foreignResult.body.delta},foreignReceipt)
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt) select $1,$2,'synthetic-deep-'||n,'opportunity_management',repeat('d',64),'first_party_web','COMMITTED',n+2,jsonb_build_object('commandId','synthetic-deep-'||n,'operation','opportunity_management','status','COMMITTED','contractVersion',5,'unknownForward',jsonb_build_array(n,'未来😀')) from generate_series(1,255) n",[x.vIds.workspaceId,x.vIds.userId])
 await db.query('update pjsdas_rows_candidate.head set revision=257 where id=$1',[x.vIds.workspaceId])
 const store=createTransactionalWorkspaceStore({supabaseUrl:PJSDAS_SUPABASE_URL,serviceRoleKey:serviceToken,auditReadAuthorization:proof}),deepM=await measure.start('multi-owner-deep-history'),history=await store.readCommandsAfterRevision(x.vIds.userId,0);await measure.end(deepM)
 const expected=(await db.query('select to_jsonb(l) row from pjsdas_rows_internal.discovery_history l where user_id=$1 order by resulting_revision,command_id collate "C"',[x.vIds.userId])).rows.map(x=>x.row)
 assert.equal(history.length,expected.length);for(let i=0;i<history.length;i++){assert.equal(history[i].commandId,expected[i].command_id);assert.deepEqual(history[i].receipt,expected[i].receipt);assert.deepEqual(history[i].compensation,expected[i].compensation??undefined)}
 const collisionId='synthetic-nontarget-history-collision'
 await db.query("insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest) values($1,$2,$3,repeat('e',64),258,'{\"operation\":\"opportunity_management\",\"status\":\"COMMITTED\"}','null',repeat('f',64))",[foreign.workspaceId,foreign.userId,collisionId])
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt) values($1,$2,$3,'planning_management',repeat('e',64),'delegated_mcp','COMMITTED',258,'{}')",[foreign.workspaceId,foreign.userId,collisionId])
 assert.equal((await coldPost(x.vIds,{action:'receipt',commandId:x.vf.commandId})).status,200,'foreign-owner collision is isolated')
 await db.query("insert into pjsdas_rows_candidate.ledger(workspace_id,user_id,command_id,payload_hash,resulting_revision,receipt,compensation,effect_digest) values($1,$2,$3,repeat('e',64),258,'{\"operation\":\"opportunity_management\",\"status\":\"COMMITTED\"}','null',repeat('f',64))",[x.vIds.workspaceId,x.vIds.userId,collisionId])
 await db.query("insert into public.pjsdas_command_ledger(workspace_id,user_id,command_id,operation,payload_hash,principal_kind,status,resulting_revision,receipt) values($1,$2,$3,'planning_management',repeat('e',64),'delegated_mcp','COMMITTED',258,'{}')",[x.vIds.workspaceId,x.vIds.userId,collisionId])
 assert.equal((await coldPost(x.vIds,{action:'receipt',commandId:x.vf.commandId})).status,403,'same-owner non-target collision still denies target audit')
 assert.deepEqual(await names(),initialSpools)
 console.log('PASS AUDIT_PAGE_DEEP_MULTI_OWNER exact complete multi-page history, same command IDs isolated by owner, non-target same-owner collision refuses without weakening full-history check',JSON.stringify({historyRows:history.length,foreignOwners:2}))
}

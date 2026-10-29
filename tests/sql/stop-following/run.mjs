#!/usr/bin/env node
/** Portable, no-fallback runner. Requires an already-owned local PG service. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync} from 'node:fs'
import {resolve,join,relative,dirname,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {root,sha,createManifest,verifyManifest,safeError} from '../workspace-rows-durable-v2-source.mjs'
const [destination]=process.argv.slice(2)
const mode='api'
assert(process.argv.length===3,'Expected run.mjs UNIQUE_ABSOLUTE_EVIDENCE_DIRECTORY')
assert(destination&&destination===resolve(destination),'Absolute evidence path required')
const parent=realpathSync(dirname(destination)),evidence=join(parent,relative(dirname(destination),destination))
assert(!evidence.startsWith(root+sep)&&evidence!==root,'Evidence must be outside the checkout')
assert(!existsSync(evidence),'Never reuse or overwrite an evidence run')
assert(!Object.keys(process.env).some(k=>k.startsWith('PJSDAS_')),'No inherited runtime feature/authority overrides')
const url=new URL(process.env.TA_ROW_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/postgres');assert.equal(url.username,'postgres')
assert.equal(process.env.TA_V2_VALIDATION_WINDOW,'synthetic-owned-fixture')
mkdirSync(evidence,{mode:0o700})
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim()
const commit=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),prHeadSha=process.env.TA_V2_PR_HEAD_SHA||null
function tracked(){const records=execFileSync('git',['-C',root,'ls-tree','-rz','--full-tree','HEAD']).toString().split('\0').filter(Boolean);return records.map(record=>{const split=record.indexOf('\t'),[mode,type,blob]=record.slice(0,split).split(' '),path=record.slice(split+1);assert.equal(type,'blob');const f=join(root,path);assert(lstatSync(f).isFile()&&!lstatSync(f).isSymbolicLink());const b=readFileSync(f),actual=createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');assert.equal(actual,blob,'Tracked source differs from frozen commit: '+path);return{path,mode,blob,sha256:sha(b)}})}
const initial=tracked(),native=createManifest({commit,tree,prHeadSha}),nativeRaw=JSON.stringify(native,null,2)+'\n'
writeFileSync(join(evidence,'tracked-source-before.json'),JSON.stringify({commit,tree,files:initial},null,2)+'\n',{flag:'wx'})
writeFileSync(join(evidence,'native-source.json'),nativeRaw,{flag:'wx',mode:0o600})
const env={...process.env,TA_V2_SOURCE_COMMIT:commit,TA_V2_SOURCE_TREE:tree,TA_V2_PR_HEAD_SHA:prHeadSha??'',TA_V2_SOURCE_MANIFEST:join(evidence,'native-source.json'),TA_V2_SOURCE_MANIFEST_SHA256:sha(nativeRaw),TA_STOP_EVIDENCE:evidence}
const labels=['small-direct-save-original-undo','shared-governance-refused','large-without-reservation-refused']
const state={contract:'stop-following-api-gate-v1',mode,commit,tree,prHeadSha,status:'RUNNING',actualBrowser:false,uiCreatedCommands:false,largeRecoveryCertified:false,sourceBefore:'PASS',sourceAfter:'NOT_RUN',childExit:null,childSignal:null,cases:labels.map(label=>({label,status:'NOT_RUN',cleanup:'NOT_RUN'})),ownsParentPostgres:false}
writeFileSync(join(evidence,'gate-state.json'),JSON.stringify(state,null,2)+'\n',{flag:'wx'})
const args=['--import','tsx','tests/sql/stop-following/api-proof.mjs']
let code=1
try{
 const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','inherit','inherit']})
 const exit=await new Promise((ok,no)=>{child.once('error',no);child.once('exit',(code,signal)=>ok({code,signal}))});state.childExit=exit.code;state.childSignal=exit.signal;code=exit.code??1
 for(const item of state.cases){const result=join(evidence,item.label,'result.json'),cleanup=join(evidence,item.label,'cleanup.json');if(existsSync(result)){const r=JSON.parse(readFileSync(result));assert.equal(r.sourceCommit,commit);assert.equal(r.sourceTree,tree);item.status=r.status;if(mode==='browser'){state.actualBrowser ||= r.actualConsumerUI===true;state.uiCreatedCommands ||= r.uiCreatedCommand===true}}if(existsSync(cleanup))item.cleanup=JSON.parse(readFileSync(cleanup)).status}
 verifyManifest(JSON.parse(readFileSync(env.TA_V2_SOURCE_MANIFEST)),{commit,tree,prHeadSha});assert.deepEqual(tracked(),initial);assert.equal(git('rev-parse','HEAD'),commit)
 const after={commit,tree,status:'PASS',files:initial};writeFileSync(join(evidence,'tracked-source-after.json'),JSON.stringify(after,null,2)+'\n',{flag:'wx'});state.sourceAfter='PASS'
 const expected=mode==='api'?'PASS_API_ONLY':'PASS';if(code===0&&state.cases.every(x=>x.status===expected&&x.cleanup==='PASS'))state.status=mode==='api'?'PASS_API_ONLY':'PASS_UI_REACHABILITY_BOUNDARY_ONLY';else{state.status='FAIL_OR_BLOCKED';code||=1}
}catch(error){state.status='FAIL';state.error=safeError(error);code=1}finally{writeFileSync(join(evidence,'gate-state.json'),JSON.stringify(state,null,2)+'\n')}
process.exitCode=code

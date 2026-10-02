// Isolated in-memory SQL fixture. No production endpoint or credentials.
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const db=new PGlite()
const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',client='00000000-0000-4000-8000-000000000003'
const request=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
async function decide({user=owner,clientId=client,id=10,hash='a',decision='approve',proof=null,firstParty=true,provider=true,version=2}={}){
 return (await db.query('select * from public.pjsdas_decide_management_consent_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[user,clientId,request(id),hash.repeat(64),decision,version,'b'.repeat(64),proof?.grant_id??null,proof?.grant_revision??null,firstParty,provider])).rows[0]
}
async function rejects(input,code){await assert.rejects(()=>decide(input),error=>error.code===code)}
try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;')
 for(const file of ['2026091901_ai_operated_mutation_foundation.sql','2026091903_controlled_audience.sql','20260923030000_cgr01_authoritative_commands.sql','20261002123812_consumer_management_atomic_grants.sql','20261002143625_owner_management_consent_audit.sql'])await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8'))
 await db.query('insert into auth.users(id) values($1),($2)',[owner,other])
 await db.query("insert into public.pjsdas_access_grants(user_id,role) values($1,'owner'),($2,'beta')",[owner,other])
 const signature='public.pjsdas_decide_management_consent_v1(uuid,uuid,uuid,text,text,integer,text,uuid,bigint,boolean,boolean)'
 for(const role of ['anon','authenticated']){
  assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,signature])).rows[0].allowed,false)
  assert.equal((await db.query("select has_table_privilege($1,'public.pjsdas_management_consent_events','SELECT') as allowed",[role])).rows[0].allowed,false)
 }
 for(const privilege of ['UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query("select has_table_privilege('service_role','public.pjsdas_management_consent_events',$1) as allowed",[privilege])).rows[0].allowed,false)
 await db.exec('set role service_role')
 for(const input of [{user:other},{firstParty:false},{provider:false},{version:1}])await rejects(input,'42501')
 const approved=await decide();assert.equal(approved.outcome,'APPROVED');assert.equal(Number(approved.grant_revision),1)
 assert.deepEqual(await decide(),approved)
 await rejects({hash:'c'},'23505')
 await rejects({id:11},'40001')
 await rejects({id:11,proof:{...approved,grant_id:other}},'40001')
 await rejects({id:11,clientId:other,proof:approved},'40001')
 const revoked=await decide({id:12,decision:'revoke',proof:approved,provider:false});assert.equal(revoked.outcome,'REVOKED');assert.equal(Number(revoked.grant_revision),2)
 // Replaying the original approved request returns a historical receipt only;
 // it cannot un-revoke or bump the newer grant.
 assert.deepEqual(await decide(),approved)
 let actual=(await db.query('select revision,revoked_at from public.pjsdas_business_management_grants where user_id=$1',[owner])).rows[0]
 assert.equal(Number(actual.revision),2);assert.notEqual(actual.revoked_at,null)
 const reapproved=await decide({id:13,proof:revoked});assert.equal(Number(reapproved.grant_revision),3)
 await rejects({id:14,decision:'revoke',proof:revoked},'40001')
 assert.equal(Number((await db.query('select count(*) as n from public.pjsdas_management_consent_events')).rows[0].n),3)
 // Foreign-user and revoked-owner decisions cannot change grants or append audit.
 await rejects({id:15,user:other,proof:reapproved},'42501')
 await db.query('update public.pjsdas_access_grants set revoked_at=now() where user_id=$1',[owner])
 await rejects({id:16,proof:reapproved},'42501')
 assert.equal(Number((await db.query('select count(*) as n from public.pjsdas_management_consent_events')).rows[0].n),3)
 console.log('PASS: consent SQL role privileges, owner/provider/first-party gates, CAS, append-only decision audit, idempotency, revoke/regrant and stale-proof rejection. No live grant.')
}finally{await db.close()}

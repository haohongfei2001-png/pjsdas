// Read-only production capture. No migrations, role changes, account writes or restore.
// Invocation: node .../capture-private-backup.mjs <private config dir> <PG bin dir> <new private backup dir>
import { readFile,writeFile,mkdir,stat,realpath,mkdtemp,rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve,join,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { sealBackup,openBackup,sha256 } from '../../tests/sql/backup-archive.mjs'
import { backupInventory } from '../../tests/sql/backup-inventory.mjs'
import { openFixedTunnel,DATABASE_HOST,CA_SHA256 } from './fixed-db-transport.mjs'
const require=createRequire(new URL('../../tests/sql/package.json',import.meta.url)),{Client}=require('pg')
const PROJECT='yyrzwpoxlxpafdlbkdtg',root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const [configArg,binArg,outArg]=process.argv.slice(2)
let client,tunnel,temporaryConfig
async function privateFile(path){const s=await stat(path);assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o077,0);return readFile(path,'utf8')}
function parsePass(text){const fields=[''];let escaped=false;for(const c of text.replace(/\n$/,'')){if(escaped){fields[fields.length-1]+=c;escaped=false}else if(c==='\\')escaped=true;else if(c===':')fields.push('');else fields[fields.length-1]+=c}assert.equal(fields.length,5);assert.equal(escaped,false);return fields}
function command(tool,args,env){return new Promise((res,rej)=>{const child=spawn(tool,args,{env,stdio:['ignore','pipe','pipe']}),out=[],err=[];let size=0;child.stdout.on('data',b=>{size+=b.length;if(size>128*1024*1024){child.kill();rej(Error('ARCHIVE_SIZE_LIMIT'))}else out.push(b)});child.stderr.on('data',b=>err.push(b));child.on('error',()=>rej(Error('BACKUP_TOOL_UNAVAILABLE')));child.on('close',code=>code===0?res(Buffer.concat(out)):rej(Error('BACKUP_TOOL_FAILED_'+code)));})}
try{
 assert.ok(configArg&&binArg&&outArg,'Three paths required')
 process.umask(0o077)
 const config=await realpath(configArg),bin=await realpath(binArg),out=resolve(outArg)
 assert.ok(!out.startsWith(root+'/'),'Backup must be outside Git checkout')
 assert.ok(!out.includes('/outputs/'),'Backup must not enter deliverable attachments')
 const service=await privateFile(join(config,'pg_service.conf'))
 const settings=Object.fromEntries(service.split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)]}))
 assert.equal(settings.dbname,'postgres');assert.equal(settings.port,'5432');assert.equal(settings.sslmode,'verify-full')
 let ca
 if(settings.sslrootcert!=='system'){
  assert.equal(settings.sslrootcert,join(config,'supabase-ca.crt'))
  ca=await privateFile(settings.sslrootcert);assert.equal(sha256(Buffer.from(ca)),CA_SHA256)
 }
 const direct=settings.host==='db.'+PROJECT+'.supabase.co'&&settings.user==='postgres'
 const pooled=/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(settings.host)&&settings.user==='postgres.'+PROJECT
 assert.ok(direct||pooled,'Unexpected project connection')
 assert.equal(settings.passfile,join(config,'pgpass'))
 const [host,port,database,user,password]=parsePass(await privateFile(settings.passfile))
 assert.deepEqual([host,port,database,user],[settings.host,'5432','postgres',settings.user])
 let connectionHost=host,connectionPort=5432,serviceFile=join(config,'pg_service.conf')
 const transportText=await privateFile(join(config,'transport.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error})
 if(transportText){
  assert.deepEqual(JSON.parse(transportText),{type:'existing-local-proxy',destination:DATABASE_HOST,port:5432})
  assert.equal(host,DATABASE_HOST);assert.equal(user,'postgres');assert.ok(ca)
  tunnel=await openFixedTunnel();connectionHost='127.0.0.1';connectionPort=tunnel.port
  temporaryConfig=await mkdtemp(join(config,'native-session-'))
  const passfile=join(temporaryConfig,'pgpass'),escape=s=>String(s).replaceAll('\\','\\\\').replaceAll(':','\\:')
  await writeFile(passfile,[host,connectionPort,database,user,password].map(escape).join(':')+'\n',{mode:0o600,flag:'wx'})
  serviceFile=join(temporaryConfig,'pg_service.conf')
  await writeFile(serviceFile,`[todayaction_migration]\nhost=${host}\nhostaddr=127.0.0.1\nport=${connectionPort}\ndbname=postgres\nuser=postgres\npassfile=${passfile}\nsslmode=verify-full\nsslrootcert=${settings.sslrootcert}\nconnect_timeout=5\n`,{mode:0o600,flag:'wx'})
 }
 client=new Client({host:connectionHost,port:connectionPort,database,user,password,ssl:{rejectUnauthorized:true,servername:host,...(ca?{ca}:{})},connectionTimeoutMillis:5000,statement_timeout:15000,application_name:'todayaction-readonly-backup'})
 await client.connect()
 await client.query("begin isolation level repeatable read read only;set local lock_timeout='2s';set local statement_timeout='15s';set local timezone='UTC'")
 const identity=(await client.query("select current_database() database,current_user role,current_setting('server_version_num') version,transaction_timestamp() captured_at,pg_export_snapshot() snapshot")).rows[0]
 assert.equal(identity.database,'postgres');assert.equal(identity.role,'postgres');assert.equal(Math.floor(Number(identity.version)/10000),17)
 const inventory=await backupInventory(client)
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG'))),PGSERVICEFILE:serviceFile,PGSERVICE:'todayaction_migration',PGOPTIONS:'-c default_transaction_read_only=on -c lock_timeout=2s -c statement_timeout=15s -c timezone=UTC'}
 for(const key of ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGPASSFILE','PGSSLMODE','PGSSLROOTCERT'])delete env[key]
 const dump=await command(join(bin,'pg_dump'),['-w','--format=custom','--strict-names','--schema=public','--schema=auth','--schema=supabase_migrations','--lock-wait-timeout=2s','--snapshot='+identity.snapshot],env)
 await client.query('rollback');await client.end();client=null
 const metadata={project:PROJECT,identity,...inventory,archiveSha256:sha256(dump),scope:['public','auth','supabase_migrations'],notIncluded:['storage object bytes','platform settings','OAuth/JWT secrets','role passwords'],restoreStatus:'NOT_YET_VERIFIED',migrationPermission:'BLOCKED_UNTIL_ACTUAL_RESTORE_AND_FULL_PREFLIGHT_PASS'}
 const payload=Buffer.from(JSON.stringify({metadata,archive:dump.toString('base64')})),key=randomBytes(32),sealed=sealBackup(payload,key)
 assert.deepEqual(openBackup(sealed,key),payload)
 await mkdir(out,{mode:0o700}) // exclusive: never overwrite an earlier recovery point
 await writeFile(join(out,'recovery.key'),key,{flag:'wx',mode:0o600})
 await writeFile(join(out,'snapshot.aesgcm'),sealed,{flag:'wx',mode:0o600})
 await writeFile(join(out,'capture-receipt.json'),JSON.stringify({project:PROJECT,capturedAt:identity.captured_at,encryptedSha256:sha256(sealed),archiveSha256:sha256(dump),tableCount:inventory.tables.length,restoreVerified:false,productionMigrationsApplied:0},null,2)+'\n',{flag:'wx',mode:0o600})
 key.fill(0);payload.fill(0);dump.fill(0)
 console.log('Private backup captured and encryption checked. Restore is NOT yet verified; migration remains blocked.')
}catch(error){console.error('Backup preparation stopped safely:',/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:'VALIDATION_OR_CAPTURE_FAILED');process.exitCode=1}
finally{if(client){await client.query('rollback').catch(()=>{});await client.end().catch(()=>{})}await tunnel?.close();if(temporaryConfig)await rm(temporaryConfig,{recursive:true,force:true})}

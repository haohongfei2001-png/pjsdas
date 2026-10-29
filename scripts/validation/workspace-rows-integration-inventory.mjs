/** Fixed owned loopback cluster only, invoked under the shared gate lock. */
import assert from 'node:assert/strict'
import pg from '../../tests/sql/node_modules/pg/lib/index.js'
import {readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
const [mode,port]=process.argv.slice(2);assert(['init','inventory'].includes(mode));assert(['55634','55439','55776'].includes(port))
const root=fileURLToPath(new URL('../..',import.meta.url)),client=new pg.Client({connectionString:'postgres://postgres@127.0.0.1:'+port+'/postgres'})
try{
 await client.connect()
 if(mode==='init')await client.query(`DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS;END IF;
 END$$;`)
 else{
  const databases=(await client.query("select datname from pg_database where datname not in ('postgres','template0','template1') order by datname")).rows
  const roles=(await client.query("select rolname from pg_roles where rolname not like 'pg_%' and rolname not in ('postgres','anon','authenticated','service_role') order by rolname")).rows
  const auditSpools=readdirSync(tmpdir()).filter(x=>x.startsWith('ta-audit-read-')).sort()
  const coldFiles=readdirSync(root+'/tests/sql').filter(x=>/^(\.(intent-cold-|audit-cold-|integration-r0p-cold-|integrated-pair-|rollback-)|integrated-pair-tmp-)/.test(x)).sort()
  console.log(JSON.stringify({databases,roles,auditSpools,coldFiles,clean:!databases.length&&!roles.length&&!auditSpools.length&&!coldFiles.length}))
  assert.equal(databases.length+roles.length+auditSpools.length+coldFiles.length,0)
 }
}finally{await client.end()}

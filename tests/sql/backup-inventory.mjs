// Metadata and hashes only; call inside the same read-only snapshot used by pg_dump.
export async function backupInventory(client){
 const tables=(await client.query("select n.nspname,c.relname,pg_get_userbyid(c.relowner) owner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','supabase_migrations') and c.relkind in ('r','p') order by n.nspname,c.relname")).rows
 const quote=s=>'"'+s.replaceAll('"','""')+'"'
 for(const table of tables){
  const hash="encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')"
  const result=(await client.query(`select count(*)::text count,encode(sha256(convert_to(coalesce(string_agg(${hash},'' order by ${hash}),''),'UTF8')),'hex') fingerprint from ${quote(table.nspname)}.${quote(table.relname)} t`)).rows[0]
  Object.assign(table,result)
 }
 const roles=(await client.query('select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles order by rolname')).rows
 const memberships=(await client.query('select pg_get_userbyid(roleid) role,pg_get_userbyid(member) member,pg_get_userbyid(grantor) grantor,admin_option,inherit_option,set_option from pg_auth_members order by role,member,grantor')).rows
 const extensions=(await client.query('select e.extname,e.extversion,n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname')).rows
 const history=(await client.query('select * from supabase_migrations.schema_migrations order by version')).rows
 return {tables,roles,memberships,extensions,history}
}

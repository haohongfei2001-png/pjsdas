// Pure renderer: no connection or execution. Run each result with psql -X -w -1
// -v ON_ERROR_STOP=1 -f <file>, only after the production recovery/preflight gates.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function migrationEnvelope(entry, source) {
 assert.match(entry.file, /^\d{14}_[a-z0-9_]+\.sql$/)
 assert.equal(createHash('sha256').update(source).digest('hex'), entry.sha256)
 const version=entry.file.split('_')[0], name=entry.file.slice(version.length+1,-4)
 const quote=`$ta_${entry.sha256}$`
 assert.equal(source.includes(quote), false)
 return `-- Requires psql --single-transaction --set ON_ERROR_STOP=1; never run as autocommit.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
 IF current_setting('lock_timeout') <> '2s' OR current_setting('statement_timeout') <> '15s' THEN
  RAISE EXCEPTION 'Migration must run inside the bounded explicit transaction';
 END IF;
 IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${version}' OR name='${name}') THEN
  RAISE EXCEPTION 'Migration history already present; stop without replay';
 END IF;
END $guard$;
${source}
INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES ('${version}','${name}',ARRAY[${quote}${source}${quote}]::text[]);
`
}

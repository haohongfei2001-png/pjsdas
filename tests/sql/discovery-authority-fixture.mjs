// Rebuilt B2 fixtures: only synthetic identities, tokens and database state.
// This is a test prerequisite chain, not the production migration manifest.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

export const authorityMigration = '20261007184232_discovery_atomic_authority.sql'
export const owner = '00000000-0000-4000-8000-000000001701'
export const other = '00000000-0000-4000-8000-000000001702'
export const absent = '00000000-0000-4000-8000-000000001703'
export const client = 'fixture-discovery-client'
export const source = 'discovery:fixture-approved'
export const subject = 'fixture-google-subject'
export const workerToken = 'fixture-only-discovery-worker'
export const state = {
  schema: 'pjsdas-local-snapshot', version: 4, exportedAt: '2026-10-08T00:00:00Z',
  data: { opportunities: [], processes: [], processEvents: [], actions: [], prep: [],
    applicationGroups: [], scheduleNodes: [], decisionRequests: [], semanticReceipts: [],
    reminderIntents: [], reminderOutbox: [] },
}
export const commitSignature = 'public.pjsdas_commit_discovery_workspace_v1(uuid,text,text,text,bigint,jsonb,integer,text,text,jsonb,jsonb,timestamptz,jsonb,jsonb)'
export const claimSignature = 'public.pjsdas_claim_enabled_discovery_automation_bindings_v2(text)'
export const commitQuery = 'select * from public.pjsdas_commit_discovery_workspace_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)'
export const migration = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
export const exec = (db, sql) => typeof db.exec === 'function' ? db.exec(sql) : db.query(sql)

export function fixtureUrl(input = process.env.TA_MANAGEMENT_SQL_TEST_URL) {
  const url = new URL(input ?? 'http://missing.invalid')
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/ta_management_fixture' || url.username !== 'postgres'
    || url.password !== 'fixture-only' || url.search || url.hash) {
    throw new Error('Only the isolated loopback fixture database and synthetic credentials are accepted.')
  }
  return url
}

export async function installBase(db, { createRoles = false } = {}) {
  if (createRoles) await exec(db, 'create role anon; create role authenticated; create role service_role bypassrls;')
  await exec(db, `
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to authenticated;
    create schema vault;
    create table vault.decrypted_secrets(name text, decrypted_secret text);
    create view vault.secrets as select name from vault.decrypted_secrets;
    insert into vault.decrypted_secrets values
      ('pjsdas_gmail_automation_worker_token','fixture-only-gmail-worker'),
      ('pjsdas_discovery_automation_worker_token','${workerToken}');
    create table public.google_drive_connections (
      user_id uuid primary key references auth.users(id), google_subject text, google_email text,
      refresh_token_ciphertext text, granted_scopes text[], revoked_at timestamptz,
      updated_at timestamptz default now()
    );
  `)
  // Same prerequisite approach as google-refresh-lifecycle.mjs. The connection
  // table/Vault stand-ins are fixture-only; actual functions and triggers come
  // from the checked-in migrations. No secrets, extensions or cron are created.
  const chain = [
    '2026091501_gmail_automation_worker.sql', '2026091502_discovery_automation_worker.sql',
    '2026091503_tighten_discovery_worker_rpc_grants.sql', '2026091504_discovery_automation_opt_in.sql',
    '2026091901_ai_operated_mutation_foundation.sql', '2026091902_gmail_complete_consumption.sql',
    '2026091904_activate_automation_scheduler.sql', '2026092002_semantic_intake_policy.sql',
    '20260921040454_gmail_uu06_explicit_consent.sql', '20260921045732_gmail_execution_controls.sql',
    '20260921114500_gmail_push_watch_state.sql', '20260923030000_cgr01_authoritative_commands.sql',
    '20260925131500_gmail_failure_telemetry.sql', '20260926180000_gmail_reconciliation_continuation.sql',
    '20261005211006_google_refresh_lifecycle.sql',
  ]
  for (const name of chain) {
    let sql = await migration(name)
    if (name === '2026091904_activate_automation_scheduler.sql') {
      const start = sql.indexOf('-- Gmail v1 scheduler RPCs')
      const end = sql.indexOf('do $$\ndeclare')
      assert.ok(start >= 0 && end > start, 'known scheduler-only fixture boundary')
      sql = sql.slice(start, end)
    }
    sql = sql.replace(/^create extension if not exists pg_(cron|net)( with schema extensions)?;$/gm, '')
    if (name === '20260926180000_gmail_reconciliation_continuation.sql') {
      const end = sql.indexOf('do $migration$')
      assert.ok(end > 0, 'known reconciliation scheduler-only fixture boundary')
      sql = sql.slice(0, end)
    }
    await exec(db, sql)
  }
  // Model already provisioned privileges before applying B2. Tests compare the
  // complete baseline ACL/RLS catalogs and prove B2 does not grant missing ACLs.
  await exec(db, `grant select, update on public.google_drive_connections, public.gmail_automation_execution_state to service_role;
    alter table public.google_drive_connections enable row level security;`)
}

export async function seedExistingAuthority(db) {
  await db.query('insert into auth.users(id) values($1),($2)', [owner, other])
  await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$3,4),($2,$3,4)', [owner, other, JSON.stringify(state)])
  await db.query(`insert into public.pjsdas_authorization_grants(user_id,client_id,source_id,capability)
    values($1,$3,$4,'ingest_discovery_run'),($2,$3,$4,'ingest_discovery_run'),($1,$3,'gmail:fixture','ingest_gmail_run')`,
  [owner, other, client, source])
  await db.query(`insert into public.google_drive_connections(user_id,google_subject,google_email,refresh_token_ciphertext,granted_scopes,discovery_automation_enabled)
    values($1,$3,'fixture@example.invalid','v1.fixture-only','{}',true),($2,'fixture-other-subject','other@example.invalid','v1.fixture-other','{}',false)`,
  [owner, other, subject])
}

export async function proof(db, kind = 'delegated_mcp', user = owner) {
  if (kind === 'automation') {
    const row = (await db.query('select google_subject,discovery_consent_generation from public.google_drive_connections where user_id=$1', [user])).rows[0]
    return { kind, userId: user, googleSubject: row.google_subject, consentGeneration: row.discovery_consent_generation }
  }
  const row = (await db.query(`select id,revision from public.pjsdas_authorization_grants
    where user_id=$1 and client_id=$2 and source_id=$3 and capability='ingest_discovery_run'`, [user, client, source])).rows[0]
  return { kind, userId: user, clientId: client, sourceId: source, grantId: row.id, grantRevision: Number(row.revision) }
}

export function args(authority, options = {}) {
  const { command = 'fixture-discovery-command', user = owner, operation = 'ingest_verified_discovery',
    hash = `hash:${command}`, revision = 0, snapshot = state, principal = authority?.kind ?? 'delegated_mcp',
    clientId = principal === 'automation' ? null : client, provenance = { sourceId: source },
    compensation = null, effectiveTime = null, receiptContext = {}, authorization = authority } = options
  return [user, command, operation, hash, revision, JSON.stringify(snapshot), 4, principal, clientId,
    JSON.stringify(provenance), compensation == null ? null : JSON.stringify(compensation), effectiveTime,
    JSON.stringify(receiptContext), authorization == null ? null : JSON.stringify(authorization)]
}

export async function commit(db, authority, options) {
  return (await db.query(commitQuery, args(authority, options))).rows[0]
}

export async function asRole(db, role, work) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role))
  await exec(db, `set role ${role}`)
  try { return await work() } finally { await exec(db, 'reset role') }
}

export async function durableState(db) {
  return {
    workspaces: (await db.query('select * from public.pjsdas_workspaces order by user_id')).rows,
    ledger: (await db.query('select * from public.pjsdas_command_ledger order by id')).rows,
  }
}

export async function securityCatalog(db) {
  return {
    relations: (await db.query(`select c.relname,c.relkind,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','vault','auth') and c.relkind in ('r','p','S','v') order by n.nspname,c.relname`)).rows,
    policies: (await db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
    columnAcl: (await db.query(`select c.relname,a.attname,a.attacl::text from pg_attribute a
      join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and a.attnum>0 and not a.attisdropped and a.attacl is not null order by c.relname,a.attname`)).rows,
  }
}

export async function functionCatalog(db) {
  return (await db.query(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,
    p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' order by p.oid::regprocedure::text`)).rows
}

export function receiptProof(authority) {
  if (authority.kind === 'automation') {
    return { kind: authority.kind, userId: authority.userId, consentGeneration: authority.consentGeneration }
  }
  return { kind: authority.kind, userId: authority.userId, clientId: authority.clientId,
    sourceId: authority.sourceId, grantId: authority.grantId, grantRevision: authority.grantRevision }
}

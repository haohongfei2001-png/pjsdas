import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026091901_ai_operated_mutation_foundation.sql', import.meta.url),
  'utf8',
)

describe('AI-operated mutation foundation migration', () => {
  it('keeps connected workspace and command ledger server-owned', () => {
    expect(migration).toContain('create table if not exists public.pjsdas_workspaces')
    expect(migration).toContain('create table if not exists public.pjsdas_command_ledger')
    expect(migration).toContain('revoke all on table public.pjsdas_workspaces from anon, authenticated')
    expect(migration).toContain('revoke all on table public.pjsdas_command_ledger from anon, authenticated')
    expect(migration).toContain('grant execute on function public.pjsdas_commit_workspace')
    expect(migration).toContain('to service_role')
  })

  it('models delegated trust as user × client × source × capability', () => {
    expect(migration).toContain('create table if not exists public.pjsdas_authorization_grants')
    expect(migration).toContain('primary key (user_id, client_id, source_id, capability)')
    expect(migration).toContain("capability in ('ingest_discovery_run', 'ingest_gmail_run')")
    expect(migration).toContain('auth.uid() = user_id')
  })

  it('serializes the workspace before checking command idempotency', () => {
    const lock = migration.indexOf('where user_id = target_user_id\n  for update;')
    const ledger = migration.indexOf('from public.pjsdas_command_ledger', lock)
    expect(lock).toBeGreaterThan(0)
    expect(ledger).toBeGreaterThan(lock)
    expect(migration).toContain("outcome := 'ALREADY_APPLIED'")
    expect(migration).toContain("raise exception 'PJSDAS command id was reused with a different payload.'")
  })

  it('stores compensation metadata without erasing the original command receipt', () => {
    expect(migration).toContain('compensation jsonb')
    expect(migration).toContain("'undoAvailable', target_compensation is not null")
    expect(migration).toContain('target_compensation')
  })
})

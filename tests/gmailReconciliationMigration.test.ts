import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260926163000_gmail_reconciliation_safety_net.sql',
  'utf8',
)
const continuationMigration = readFileSync(
  'supabase/migrations/20260926180000_gmail_reconciliation_continuation.sql',
  'utf8',
)

describe('Gmail reconciliation safety-net migration', () => {
  it('derives the existing authenticated scheduler command and adds the two Shanghai-time runs', () => {
    expect(migration).toContain("where jobname='pjsdas-gmail-automation-hourly'")
    expect(migration).toContain("'/api/automation-gmail?mode=reconcile'")
    expect(migration).toContain("'todayaction-gmail-reconciliation-0830'")
    expect(migration).toContain("'30 0 * * *'")
    expect(migration).toContain("'todayaction-gmail-reconciliation-1730'")
    expect(migration).toContain("'30 9 * * *'")
  })

  it('does not rewrite Gmail cursor state or embed a second credential contract', () => {
    expect(migration).not.toContain('update public.google_drive_connections')
    expect(migration).not.toContain('gmail_history_id=')
    expect(migration).not.toContain('decrypted_secret')
    expect(migration).not.toContain('worker_token')
  })

  it('adds private continuation state, a dedicated finalizer, and an offset continuation cron', () => {
    expect(continuationMigration).toContain('gmail_reconciliation_state jsonb')
    expect(continuationMigration).toContain('pjsdas_claim_gmail_automation_bindings_v5')
    expect(continuationMigration).toContain('pjsdas_finish_gmail_reconciliation')
    expect(continuationMigration).toContain("'todayaction-gmail-reconciliation-continuation'")
    expect(continuationMigration).toContain("'5,15,25,35,45,55 * * * *'")
    expect(continuationMigration).toContain('gmail_reconciliation_requested_at')
  })

  it('keeps reconciliation continuation separate from the primary Gmail cursor contract', () => {
    expect(continuationMigration).not.toContain('set gmail_history_id=')
    expect(continuationMigration).not.toContain('gmail_last_success_at=')
    expect(continuationMigration).not.toContain('gmail_last_error=')
    expect(continuationMigration).toContain("where jobname='pjsdas-gmail-automation-hourly'")
  })
})

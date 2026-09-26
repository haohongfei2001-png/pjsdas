import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260926230000_ingestion_debt_reconciliation_scheduler.sql',
  'utf8',
)

describe('R02 ingestion debt reconciliation scheduler migration', () => {
  it('reuses the existing worker secret and schedules the bounded automation route hourly', () => {
    expect(migration).toContain('pjsdas_claim_ingestion_reconciliation_users')
    expect(migration).toContain("'todayaction-ingestion-debt-reconciliation-hourly'")
    expect(migration).toContain("'42 * * * *'")
    expect(migration).toContain("'/api/automation-ingestion-reconciliation'")
    expect(migration).toContain("name='pjsdas_gmail_automation_worker_token'")
  })

  it('does not rewrite ingestion history or Gmail cursor state', () => {
    expect(migration).toContain('cron.alter_job(reconciliation_job_id, active := false)')
    expect(migration).not.toContain('update public.pjsdas_workspaces')
    expect(migration).not.toContain('gmail_history_id=')
    expect(migration).not.toContain('gmail_last_success_at=')
    expect(migration).not.toContain('delete from')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026091904_activate_automation_scheduler.sql', import.meta.url),
  'utf8',
)

describe('Round 5 automation scheduler activation', () => {
  it('stores backend routing and worker credentials in Vault instead of cron literals', () => {
    expect(migration).toContain("pjsdas_automation_backend_origin")
    expect(migration).toContain("vault.decrypted_secrets")
    expect(migration).toContain("pjsdas_gmail_automation_worker_token")
    expect(migration).toContain("pjsdas_discovery_automation_worker_token")
    expect(migration).not.toContain("Authorization', 'Bearer ")
  })

  it('schedules staggered hourly Gmail and Discovery workers', () => {
    expect(migration).toContain("'pjsdas-gmail-automation-hourly'")
    expect(migration).toContain("'5 * * * *'")
    expect(migration).toContain("'/api/automation-gmail'")
    expect(migration).toContain("'pjsdas-discovery-automation-hourly'")
    expect(migration).toContain("'20 * * * *'")
    expect(migration).toContain("'/api/automation-discovery'")
  })

  it('retires obsolete Gmail v1 scheduler RPC access and denies authenticated v2 execution', () => {
    expect(migration).toContain('pjsdas_claim_gmail_automation_bindings(text) from anon')
    expect(migration).toContain('pjsdas_claim_gmail_automation_bindings_v2(text) from authenticated')
    expect(migration).toContain('pjsdas_update_gmail_automation_state_v2')
  })
})

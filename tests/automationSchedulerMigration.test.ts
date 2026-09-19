import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026091904_activate_automation_scheduler.sql', import.meta.url),
  'utf8',
)

describe('production automation scheduler activation', () => {
  it('requires HTTPS backend origin and both independent Vault tokens', () => {
    expect(migration).toContain("name = 'pjsdas_automation_backend_origin'")
    expect(migration).toContain("decrypted_secret ~ '^https://'")
    expect(migration).toContain("name = 'pjsdas_gmail_automation_worker_token'")
    expect(migration).toContain("name = 'pjsdas_discovery_automation_worker_token'")
  })

  it('schedules Gmail and Discovery through pg_cron + pg_net without embedding secrets', () => {
    expect(migration).toContain("'pjsdas-gmail-automation-hourly'")
    expect(migration).toContain("'pjsdas-discovery-automation-hourly'")
    expect(migration).toContain("'/api/automation-gmail'")
    expect(migration).toContain("'/api/automation-discovery'")
    expect(migration).toContain('net.http_post')
    expect(migration).toContain("'Authorization', 'Bearer ' ||")
    expect(migration).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/)
  })

  it('retires obsolete Gmail v1 RPC grants and removes authenticated access from v2 RPCs', () => {
    expect(migration).toContain('pjsdas_claim_gmail_automation_bindings(text)')
    expect(migration).toContain('pjsdas_update_gmail_automation_state(')
    expect(migration).toContain('from anon, authenticated')
    expect(migration).toContain('pjsdas_claim_gmail_automation_bindings_v2(text)')
    expect(migration).toContain('from authenticated')
  })
})

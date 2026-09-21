import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(
  new URL('../supabase/migrations/20260921114500_gmail_push_watch_state.sql', import.meta.url),
  'utf8',
)
const scheduler = readFileSync(
  new URL('../supabase/migrations/20260921114501_gmail_push_compensation_scheduler.sql', import.meta.url),
  'utf8',
)

describe('UU06 Gmail push infrastructure migrations', () => {
  it('keeps push state operational and the push enqueue RPC service-role only', () => {
    expect(schema).toContain('gmail_watch_history_id')
    expect(schema).toContain('gmail_watch_expires_at')
    expect(schema).toContain('pjsdas_claim_gmail_automation_bindings_v4')
    expect(schema).toContain('pjsdas_update_gmail_watch_state')
    expect(schema).toContain('pjsdas_enqueue_gmail_push_worker')
    expect(schema).toContain('from public, anon, authenticated')
    expect(schema).toContain('to service_role')
    expect(schema).toContain("gmail_intake_consent_version = 'uu06-v1'")
    expect(schema).not.toContain('gmail.modify')
    expect(schema).not.toContain('gmail.send')
  })

  it('uses a ten-minute compensation cadence and a daily watch renewal without touching Discovery', () => {
    expect(scheduler).toContain("'*/10 * * * *'")
    expect(scheduler).toContain("'pjsdas-gmail-watch-renewal-daily'")
    expect(scheduler).toContain("'17 3 * * *'")
    expect(scheduler).toContain("'/api/automation-gmail-watch'")
    expect(scheduler).toContain("gmail_intake_consent_version = 'uu06-v1'")
    expect(scheduler).not.toContain('pjsdas-discovery-automation-hourly')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/20260922163000_gmail_polling_10m_owner_mode.sql', import.meta.url),
  'utf8',
)

describe('UU06 polling-only owner mode', () => {
  it('changes only Gmail cadence to ten minutes and keeps Push/watch dormant', () => {
    expect(migration).toContain("'pjsdas-gmail-automation-hourly'")
    expect(migration).toContain("'*/10 * * * *'")
    expect(migration).toContain("cron.alter_job")
    expect(migration).toContain("'pjsdas-gmail-watch-renewal-daily'")
    expect(migration).toContain("watch_count <> 0")
    expect(migration).not.toContain("cron.schedule(")
    expect(migration).not.toContain("pjsdas-discovery-automation-hourly")
    expect(migration).not.toContain("/api/automation-gmail-watch")
  })
})

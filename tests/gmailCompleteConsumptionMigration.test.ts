import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026091902_gmail_complete_consumption.sql', import.meta.url),
  'utf8',
)

describe('Gmail complete-consumption migration', () => {
  it('persists continuation separately from the durable completed watermark', () => {
    for (const column of [
      'gmail_sync_mode',
      'gmail_page_token',
      'gmail_pending_history_id',
      'gmail_pending_message_ids',
    ]) expect(migration).toContain(column)
    expect(migration).toContain('pjsdas_claim_gmail_automation_bindings_v2')
    expect(migration).toContain('pjsdas_update_gmail_automation_state_v2')
  })

  it('promotes history and continuation through separate explicit flags', () => {
    expect(migration).toContain('set_history_id boolean')
    expect(migration).toContain('set_continuation boolean')
    expect(migration).toContain('clear_continuation boolean')
    expect(migration).toContain('when set_history_id then next_history_id')
    expect(migration).toContain("when clear_continuation then '{}'::text[]")
  })

  it('keeps the worker token gate on both new RPCs', () => {
    const tokenChecks = migration.match(/Invalid PJSDAS automation worker token\./g) ?? []
    expect(tokenChecks).toHaveLength(2)
    expect(migration).toContain('vault.decrypted_secrets')
  })
})

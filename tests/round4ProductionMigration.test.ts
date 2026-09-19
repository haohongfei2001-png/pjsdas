import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026091903_controlled_audience.sql', import.meta.url),
  'utf8',
)
const service = readFileSync(
  new URL('../src/cloud/connectedMigrationService.ts', import.meta.url),
  'utf8',
)

describe('Round 4 production migration contracts', () => {
  it('keeps controlled audience grants server-owned and revocable', () => {
    expect(migration).toContain('create table if not exists public.pjsdas_access_grants')
    expect(migration).toContain("role in ('owner', 'beta')")
    expect(migration).toContain('revoked_at timestamptz')
    expect(migration).toContain('revoke all on table public.pjsdas_access_grants from anon, authenticated')
    expect(migration).toContain('to service_role')
  })

  it('downloads a recovery bundle before connected bootstrap and verifies the resulting fingerprint', () => {
    const recovery = service.indexOf('downloadRecoveryBundle(inspection)')
    const bootstrap = service.indexOf('await bootstrapConnectedWorkspace')
    const verify = service.indexOf("CONNECTED_MIGRATION_VERIFY_FAILED")
    expect(recovery).toBeGreaterThan(0)
    expect(bootstrap).toBeGreaterThan(recovery)
    expect(verify).toBeGreaterThan(bootstrap)
  })

  it('does not auto-enable production authority during migration', () => {
    expect(service).not.toContain('VITE_PJSDAS_CONNECTED_AUTHORITY=')
    expect(service).not.toContain('PJSDAS_CONNECTED_AUTHORITY=')
  })
})

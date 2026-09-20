import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026092002_semantic_intake_policy.sql', import.meta.url),
  'utf8',
)

describe('UU-02 Semantic Intake authorization migration', () => {
  it('extends the delegated capability vocabulary without granting any source automatically', () => {
    expect(migration).toContain('pjsdas_authorization_grants_capability_check')
    expect(migration).toContain("'semantic_intake'")
    expect(migration).toContain("'ingest_discovery_run'")
    expect(migration).toContain("'ingest_gmail_run'")
    expect(migration).not.toMatch(/insert\s+into\s+public\.pjsdas_authorization_grants/i)
  })
})

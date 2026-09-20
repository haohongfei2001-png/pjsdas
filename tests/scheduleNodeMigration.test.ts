import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../supabase/migrations/2026092001_schedule_node_snapshot_v2.sql', import.meta.url),
  'utf8',
)

describe('UU-01 ScheduleNode snapshot-v2 migration', () => {
  it('prevents a stale client from downgrading a newer authoritative workspace snapshot', () => {
    expect(migration).toContain('pjsdas_prevent_workspace_schema_downgrade')
    expect(migration).toContain('new.schema_version < old.schema_version')
    expect(migration).toContain('before update of schema_version on public.pjsdas_workspaces')
    expect(migration).toContain('schema downgrade is not allowed')
  })
})

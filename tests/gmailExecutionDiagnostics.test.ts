import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createGmailExecutionDiagnostics, GMAIL_EXECUTION_PHASES } from '../gateway/gmailExecutionDiagnostics.js'

const previous = readFileSync('supabase/migrations/20261005211006_google_refresh_lifecycle.sql', 'utf8')
const migration = readFileSync('supabase/migrations/20261012145000_gmail_execution_diagnostics.sql', 'utf8')
const rollback = readFileSync('docs/GMAIL_EXECUTION_DIAGNOSTICS_ROLLBACK.sql', 'utf8')
function body(source: string, name: string) {
  const start = source.indexOf(`create or replace function public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf('\n$$;', start) + 4)
}
describe('bounded content-free Gmail execution diagnostics', () => {
  it('accumulates repeated phases and freezes a sampled failure before cleanup', () => {
    let now = 0
    const collector = createGmailExecutionDiagnostics(() => now)
    now = 20; collector.observer.phase('workspace_read')
    now = 120; collector.observer.phase('message_parse'); collector.observer.processed()
    now = 150; collector.observer.phase('workspace_read')
    now = 190
    const failed = collector.snapshot()
    expect(failed).toEqual({ version: 1, phase: 'workspace_read', processedCount: 1,
      durationsMs: { claim: 20, workspace_read: 140, message_parse: 30 } })
    now = 250; collector.observer.phase('checkpoint')
    expect(failed.durationsMs.workspace_read).toBe(140)
  })
  it('bounds timings/counts, rejects non-enum runtime values and never retains arbitrary content', () => {
    let now = 0
    const collector = createGmailExecutionDiagnostics(() => now)
    collector.observer.phase('https://synthetic.invalid/private-id' as never)
    for (let i = 0; i < 150; i++) collector.observer.processed()
    now = 100_000
    expect(collector.snapshot()).toEqual({ version: 1, phase: 'claim', processedCount: 100, durationsMs: { claim: 25_000 } })
    expect(JSON.stringify(collector.snapshot())).not.toContain('private-id')
  })
  it('retains complete as a valid bounded duration matching the SQL contract', () => {
    let now = 0
    const collector = createGmailExecutionDiagnostics(() => now)
    now = 10; collector.observer.phase('complete')
    now = 35
    expect(collector.snapshot()).toEqual({ version: 1, phase: 'complete', processedCount: 0,
      durationsMs: { claim: 10, complete: 25 } })
  })
  it('samples checkpoint time before the finish request without inventing future response duration', () => {
    let now = 0
    const collector = createGmailExecutionDiagnostics(() => now)
    now = 50; collector.observer.phase('checkpoint')
    const request = collector.snapshot()
    now = 500
    expect(request.durationsMs.checkpoint).toBe(0)
    expect(collector.snapshot().durationsMs.checkpoint).toBe(450)
  })
  for (const name of ['pjsdas_finish_gmail_execution', 'pjsdas_finish_gmail_reconciliation']) {
    it(`${name}: changes only the diagnostic allowlist and has a byte-exact rollback`, () => {
      const before = body(previous, name)
      const after = body(migration, name)
      const start = after.indexOf('  -- Diagnostics contain')
      const end = after.indexOf('\n  end if;\n\n', start) + '\n  end if;\n\n'.length
      expect(start).toBeGreaterThanOrEqual(0)
      expect(after.slice(0, start) + after.slice(end)).toBe(before)
      expect(body(rollback, name)).toBe(before)
      const added = after.slice(start, end)
      expect(added).toContain("jsonb_typeof(metrics->'diagnostics') = 'object'")
      expect(added).toContain("metrics#>'{diagnostics,version}' = '1'::jsonb")
      for (const phase of GMAIL_EXECUTION_PHASES) {
        expect(added).toContain(`'${phase}'`)
        expect(added).toContain(`{diagnostics,durationsMs,${phase}}`)
      }
      expect(added).toContain('least(25000,')
      expect(added).toContain('least(100,')
      expect(added).not.toMatch(/state_patch|worker_token|target_user_id|execution_token|update public|execute|grant|revoke/i)
    })
  }
  it('does not add tables, columns, privileges, search paths, policies, scheduler or dynamic SQL', () => {
    expect(migration).not.toMatch(/\b(create table|alter table|grant|revoke|create policy|alter policy|cron\.|execute\s+format)\b/i)
    expect((migration.match(/security definer/g) ?? []).length).toBe(2)
    expect((migration.match(/set search_path = public, vault, pg_temp/g) ?? []).length).toBe(2)
  })
})

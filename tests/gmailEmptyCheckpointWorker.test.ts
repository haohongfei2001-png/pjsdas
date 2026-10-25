import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runControlledGmailExecutions } from '../gateway/gmailControlledExecution.js'
import { createSnapshot } from '../src/snapshot.js'
import { emptyGmailRun } from '../gateway/emptyGmailCheckpoint.js'
import { hashMutationPayload } from '../gateway/mutationKernel.js'
const state = vi.hoisted(() => ({ snapshot: undefined as any, writes: [] as any[] }))
vi.mock('../gateway/transactionalWorkspaceSource.js', () => ({ createTransactionalWorkspaceSource: () => ({
  read: async () => ({ snapshot: structuredClone(state.snapshot), context: { workspaceVersion: 'txn:7', timezone: 'UTC' } }),
  write: async (input: any) => { state.writes.push(input); return { snapshot: input.snapshot, context: { workspaceVersion: 'txn:8' } } },
}) }))
vi.mock('../gateway/tokenCrypto.js', () => ({ decryptSecret: async () => 'synthetic-refresh' }))
vi.mock('../gateway/googleOAuthTokens.js', () => ({ refreshGoogleAccessToken: async () => 'synthetic-access' }))
const checkedAt = '2026-10-25T00:00:00.000Z'
beforeEach(() => {
  vi.stubEnv('PJSDAS_CONNECTED_AUTHORITY', 'transactional'); vi.stubEnv('PJSDAS_GMAIL_EMPTY_CHECKPOINTS', '1'); vi.stubEnv('PJSDAS_GMAIL_EMPTY_CHECKPOINT_READS', '1')
  state.writes = []; state.snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [{ id: 'boundary', kind: 'baseline_backfill', category: 'data', source: 'system', occurredAt: checkedAt, recordedAt: checkedAt, title: 'Synthetic boundary', ingestion: { version: 1, sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: 'coverage-boundary:uu06-90-days', runId: 'boundary', recordType: 'recruiting_message', outcome: 'ignored', fingerprint: 'synthetic', receivedAt: checkedAt, accountedAt: checkedAt } } as any] })
})
afterEach(() => vi.unstubAllEnvs())
function harness(outcome = 'COMMITTED', nextHistoryId = '1234') {
  const calls: { rpc: string; body: any }[] = []
  const binding = { user_id: 'owner', google_subject: 'synthetic', refresh_token_ciphertext: 'synthetic', granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'], gmail_history_id: '1234', gmail_intake_consent_version: 'uu06-v1', gmail_pending_message_ids: [] }
  const fetchImpl: typeof fetch = async (url, init) => {
    const rpc = new URL(String(url)).pathname.split('/').at(-1)!, body = JSON.parse(String(init?.body ?? '{}')); calls.push({ rpc, body })
    if (rpc === 'pjsdas_claim_gmail_automation_bindings_v5') return Response.json([binding])
    if (rpc === 'pjsdas_begin_gmail_execution') return Response.json(binding)
    if (rpc === 'pjsdas_assert_gmail_execution' || rpc === 'pjsdas_finish_gmail_execution') return Response.json(true)
    if (rpc === 'profile' || rpc === 'history') return Response.json({ historyId: nextHistoryId })
    if (rpc === 'pjsdas_checkpoint_empty_gmail_poll_v1') {
      if (outcome === 'lost') throw new Error('Synthetic lost response after possible commit')
      return Response.json([{ outcome, workspace_id: 'workspace', revision: 8, receipt: { commandId: body.target_command_id, receiptId: `command-receipt:${body.target_command_id}`, status: 'COMMITTED', operation: 'gmail_semantic_intake', revision: 8, contractVersion: 2, storageContract: 'gmail-empty-poll-v1', affectedObjects: [{ type: 'timeline', id: emptyGmailRun(body.target_command_id, checkedAt, '1234').id }], undoDependencyObjects: [{ type: 'timeline', id: emptyGmailRun(body.target_command_id, checkedAt, '1234').id }] } }])
    }
    throw new Error('Unexpected synthetic endpoint '+rpc)
  }
  return { calls, run: () => runControlledGmailExecutions({ supabaseUrl: 'https://synthetic.invalid', supabasePublishableKey: 'synthetic', supabaseServiceRoleKey: 'synthetic', tokenEncryptionKey: 'synthetic', googleClientId: 'synthetic', googleClientSecret: 'synthetic', fetchImpl, now: () => new Date(checkedAt) }, 'synthetic-worker') }
}
it.each(['COMMITTED', 'ALREADY_APPLIED'])('uses original lease/user, canonical payload hash, and no snapshot for %s', async outcome => {
  const h = harness(outcome); expect(await h.run()).toMatchObject({ successfulUsers: 1 })
  expect(state.writes).toHaveLength(0)
  const begin = h.calls.find(c => c.rpc === 'pjsdas_begin_gmail_execution')!, commit = h.calls.find(c => c.rpc === 'pjsdas_checkpoint_empty_gmail_poll_v1')!, finish = h.calls.find(c => c.rpc === 'pjsdas_finish_gmail_execution')!
  expect(commit.body.target_execution_token).toBe(begin.body.execution_token); expect(commit.body.target_user_id).toBe('owner'); expect(commit.body.target_expected_revision).toBe(7)
  expect(commit.body.target_payload_hash).toBe(await hashMutationPayload('gmail_semantic_intake', { sourceId: 'gmail:primary', recordIds: [] }))
  expect(JSON.stringify(commit.body)).not.toContain('target_snapshot'); expect(finish.body.state_patch).toMatchObject({ historyId: '1234', successAt: checkedAt })
})
it('falls back once only after definitive NOT_ELIGIBLE', async () => {
  const h = harness('NOT_ELIGIBLE'); expect(await h.run()).toMatchObject({ successfulUsers: 1 }); expect(state.writes).toHaveLength(1); expect(state.writes[0].snapshot.data.timeline).toHaveLength(2)
})
it.each(['lost', 'CONFLICT'])('never full-writes or advances cursor after %s', async outcome => {
  const h = harness(outcome); expect(await h.run()).toMatchObject({ failedUsers: 1 }); expect(state.writes).toHaveLength(0); expect(h.calls.filter(c => c.rpc === 'pjsdas_checkpoint_empty_gmail_poll_v1')).toHaveLength(1)
  expect(h.calls.find(c => c.rpc === 'pjsdas_finish_gmail_execution')!.body.state_patch).toEqual({})
})
it.each(['off', 'cursor', 'backfill'])('preserves original path for unsupported %s', async kind => {
  if (kind === 'off') vi.stubEnv('PJSDAS_GMAIL_EMPTY_CHECKPOINTS', '')
  if (kind === 'backfill') state.snapshot.data.timeline = []
  const h = harness('COMMITTED', kind === 'cursor' ? '1235' : '1234'); expect(await h.run()).toMatchObject({ successfulUsers: 1 }); expect(state.writes).toHaveLength(1); expect(h.calls.some(c => c.rpc === 'pjsdas_checkpoint_empty_gmail_poll_v1')).toBe(false)
})

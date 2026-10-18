import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage, gmailObservationFromMessage, fetchGmailSemanticRecordsByIds, reconciliationRecordVersion } from '../gateway/gmailAutomation.js'
import { reprocessVersion } from '../gateway/gmailFragmentReprocessDryRunHandler.js'
import { createTransactionalWorkspaceSource } from '../gateway/transactionalWorkspaceSource.js'
import { createSnapshot, upgradeSnapshotToLatest } from '../src/snapshot.js'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { applySemanticIntake } from '../src/semanticIntake.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { applyGmailIngestionHardened } from '../src/ingestionHardening.js'
import { bootstrapPolicyFor } from '../src/sourceRegistry.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'

const now = new Date('2026-09-21T00:00:00Z')
const notice = '京东 AI产品经理 面试通知：2026年9月25日14:30'
const baseline = (timezone?: string) => createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')],
  processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  ...(timezone ? { timePlanning: { version: 1, timezone, updatedAt: now.toISOString() } } : {}) })
const message = (text = notice, id = 'synthetic-zone', received = now.toISOString()) => ({ id, threadId: 'synthetic-thread',
  internalDate: String(Date.parse(received)), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '京东 AI产品经理 招聘进展' }],
    body: { data: Buffer.from(text).toString('base64url') } } })
const parse = (text: string, timezone?: string, id = 'synthetic-zone', received = now.toISOString()) =>
  gmailSemanticRecordFromMessage(message(text, id, received), baseline().data.opportunities, now, timezone)!
const apply = (record: ReturnType<typeof parse>, snapshot = baseline(), runId = 'synthetic-run', reconcileExisting = false) =>
  applyGmailSemanticBatch(snapshot, { records: [record], runId, sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, reconcileExisting })

describe('Gmail uses saved account interpretation timezone without execution-host defaults', () => {
  it.each(['UTC', 'Asia/Shanghai', 'Asia/Tokyo'])('matches Tell through the actual transaction-read context in %s', async timezone => {
    const initial = baseline(timezone)
    const source = createTransactionalWorkspaceSource({ userId: 'synthetic-user', supabaseUrl: 'https://example.invalid',
      serviceRoleKey: 'synthetic-key', principalKind: 'automation', sourceId: 'gmail:primary', timezone: 'Asia/Shanghai',
      fetchImpl: async () => new Response(JSON.stringify([{ id: 'synthetic-workspace', user_id: 'synthetic-user', snapshot: initial, revision: 7, schema_version: 1 }]), { status: 200 }) })
    const workspace = await source.read()
    expect(workspace.context).toMatchObject({ timezone, workspaceVersion: 'txn:7' })
    const interpreted = buildWebSemanticInterpretation(notice, workspace.snapshot.data.opportunities, workspace.snapshot, [], now)
    const told = applySemanticIntake(workspace.snapshot, { contractVersion: 1, inputId: 'synthetic-web', statementMode: interpreted.mode,
      source: { kind: 'web', sourceId: 'todayaction-web', sourceRecordId: 'synthetic-web', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone },
      candidates: interpreted.candidates }, { authorized: true, now })
    const record = parse(notice, workspace.snapshot.data.timePlanning?.timezone)
    const mailed = apply(record, workspace.snapshot)
    expect(told.status).toBe('APPLIED')
    expect(mailed.snapshot.data.processEvents).toHaveLength(1)
    expect(mailed.snapshot.data.processEvents[0]!.dueAt).toBe(told.snapshot.data.processEvents[0]!.dueAt)
    expect(record.observation.source.timezone).toBe(timezone)
    expect(mailed.snapshot.data.scheduleNodes![0]!.temporal).toMatchObject({ startAt: told.snapshot.data.scheduleNodes![0]!.temporal.startAt, timezone })
  })
  it.each(['', 'Unknown/Place'])('retains a timed notice as unresolved without trusted timezone %s', timezone => {
    const record = parse(notice, timezone)
    const result = apply(record)
    expect(record.gaps.length).toBeGreaterThan(0)
    expect(result.run.outcomes.unresolved).toBe(1)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.scheduleNodes).toEqual([])
    expect(record.observation.source.timezone).toBe('unresolved')
  })
  it('preserves the established explicit Gmail service default when no override is supplied', () => {
    expect(parse(notice).observation.candidates[0]).toMatchObject({ temporal: { startAt: '2026-09-25T14:30:00+08:00', timezone: 'Asia/Shanghai' } })
  })
  it('does not add a timezone gap to nontemporal application evidence', () => {
    const record = parse('京东 AI产品经理 申请已收到', '')
    expect(record.observation.candidates[0]).toMatchObject({ kind: 'application_submitted' })
    expect(record.issueKinds).not.toContain('interpretation_failure')
    expect(record.gaps).toEqual([])
  })
  it.each(['面试已完成', '面试取消'])('does not add a timezone gap to nontemporal occurrence evidence %s', fact => {
    const record = parse(`京东 AI产品经理 ${fact}`, '')
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]!.kind).toBe(fact === '面试取消' ? 'occurrence_cancelled' : 'occurrence_completed')
    expect(record.gaps).toEqual([])
  })
  it('binds a UTC old/new reschedule against the evolving same-batch snapshot', () => {
    const initial = parse(notice, 'UTC', 'initial', '2026-09-19T00:00:00Z')
    const moved = parse('京东 AI产品经理 面试改期通知：原定2026年9月25日14:30，改为2026年9月26日14:30', 'UTC', 'move', '2026-09-20T00:00:00Z')
    const result = applyGmailSemanticBatch(baseline('UTC'), { records: [moved, initial], runId: 'utc-move', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true })
    expect(result.run.outcomes.unresolved ?? 0).toBe(0)
    expect(result.snapshot.data.processEvents).toHaveLength(1)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(2)
    expect(result.snapshot.data.scheduleNodes!.find(node => node.state !== 'superseded')).toMatchObject({ version: 2, temporal: { startAt: '2026-09-26T14:30:00+00:00', timezone: 'UTC' } })
  })
  it('retains UTC windows, latest start and dependent submission deadline without calendar appointments', () => {
    const result = apply(parse('京东 AI产品经理 笔试开放窗口2026年9月24日09:00至17:00，最晚入场10:00；提交截止2026年9月24日18:00', 'UTC'))
    expect(result.snapshot.data.processEvents).toHaveLength(2)
    expect(result.snapshot.data.processEvents[0]!.temporal).toMatchObject({ shape: 'availability_window', startAt: '2026-09-24T09:00:00+00:00', latestStartAt: '2026-09-24T10:00:00+00:00', endAt: '2026-09-24T17:00:00+00:00', timezone: 'UTC' })
    expect(result.snapshot.data.processEvents[1]!.temporal).toMatchObject({ deadlineAt: '2026-09-24T18:00:00+00:00', timezone: 'UTC' })
    expect(result.snapshot.data.scheduleNodes).toEqual([])
  })
  it.each(['UTC', ''])('honors an explicit Beijing-time fragment ahead of workspace %s', timezone => {
    const record = parse('京东 AI产品经理 面试通知：北京时间2026年9月25日14:30', timezone)
    expect(record.observation.candidates[0]).toMatchObject({ temporal: { startAt: '2026-09-25T14:30:00+08:00', timezone: 'Asia/Shanghai' } })
    expect(record.observation.source.timezone).toBe('Asia/Shanghai')
    expect(apply(record).snapshot.data.scheduleNodes).toHaveLength(1)
  })
  it('replays a proven explicit-zone fact across parser and workspace versions without moving it', () => {
    const text = '京东 AI产品经理 面试通知：北京时间2026年9月25日14:30'
    const first = apply(parse(text, 'Asia/Shanghai'))
    const replay = apply(reconciliationRecordVersion(parse(text, 'UTC')), first.snapshot, 'explicit-replay', true)
    expect(replay.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
    expect(replay.snapshot.data.scheduleNodes).toEqual(first.snapshot.data.scheduleNodes)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
  })
  it('keeps explicit Beijing scope within its fragment and preserves a mixed-zone exact replay', () => {
    const text = '京东 AI产品经理 笔试通知：北京时间2026年9月24日09:00；京东 AI产品经理 面试通知：2026年9月25日14:30'
    const record = parse(text, 'UTC')
    expect(record.observation.candidates).toMatchObject([
      { temporal: { startAt: '2026-09-24T09:00:00+08:00', timezone: 'Asia/Shanghai' } },
      { temporal: { startAt: '2026-09-25T14:30:00+00:00', timezone: 'UTC' } },
    ])
    const first = apply(record), replay = apply(reconciliationRecordVersion(parse(text, 'UTC')), first.snapshot, 'mixed-zone-replay', true)
    expect(replay.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
    expect(replay.snapshot.data.scheduleNodes).toEqual(first.snapshot.data.scheduleNodes)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
  })
  it('does not borrow Beijing timezone from a quoted old message', () => {
    expect(parse(`${notice}\n> 北京时间2026年9月24日09:00`, 'UTC').observation.candidates[0]).toMatchObject({ temporal: { startAt: '2026-09-25T14:30:00+00:00', timezone: 'UTC' } })
  })
  it.each(['不是北京时间', '非北京时间', '请不要使用北京时间'])('does not infer a zone from unsupported qualified prefix %s', prefix => {
    expect(apply(parse(`京东 AI产品经理 面试通知：${prefix}2026年9月25日14:30`, 'UTC')).snapshot.data.scheduleNodes).toEqual([])
  })
  it('keeps conflicting or unsupported explicit zone labels unresolved', () => {
    const record = parse('京东 AI产品经理 面试通知：北京时间2026年9月25日14:30 PST', 'UTC')
    expect(apply(record).snapshot.data.scheduleNodes).toEqual([])
  })
  it.each(['PST', 'Asia/Tokyo', 'UTC+09:00'])('does not replace unsupported explicit source zone %s with account UTC', zone => {
    const record = parse(`${notice} ${zone}`, 'UTC')
    expect(record.observation.candidates.some(candidate => 'temporal' in candidate && candidate.temporal)).toBe(false)
    expect(apply(record).snapshot.data.scheduleNodes).toEqual([])
  })
  it.each(['2026年3月8日02:30', '2026年11月1日01:30'])('keeps DST gap/fold %s unresolved', wall => {
    expect(apply(parse(`京东 AI产品经理 面试通知：${wall}`, 'America/New_York')).snapshot.data.scheduleNodes).toEqual([])
  })
  it.each([['UTC', '2026-09-21T14:30:00+00:00'], ['Asia/Shanghai', '2026-09-22T14:30:00+08:00']])('anchors relative dates to message instant in %s', (zone, startAt) => {
    expect(parse('京东 AI产品经理 面试通知：明天14:30', zone, 'relative', '2026-09-20T23:55:00Z').observation.candidates[0]).toMatchObject({ temporal: { startAt, timezone: zone } })
  })
  it('does not use Date-header offset as the appointment timezone', () => {
    const mail = message(); delete (mail as { internalDate?: string }).internalDate
    mail.payload.headers.push({ name: 'Date', value: 'Sun, 20 Sep 2026 23:55:00 +0900' })
    const record = gmailSemanticRecordFromMessage(mail, baseline().data.opportunities, now, 'UTC')!
    expect(record.observation.source.assertedAt).toBe('2026-09-20T14:55:00.000Z')
    expect(record.observation.candidates[0]).toMatchObject({ temporal: { startAt: '2026-09-25T14:30:00+00:00', timezone: 'UTC' } })
  })
  it('threads the same timezone through bounded by-id reprocessing', async () => {
    const result = await fetchGmailSemanticRecordsByIds({ accessToken: 'synthetic-access', messageIds: ['synthetic-zone'],
      opportunities: baseline().data.opportunities, timezone: 'UTC', now, fetchImpl: async () => new Response(JSON.stringify(message()), { status: 200 }) })
    expect(result.records[0]!.observation.candidates[0]).toMatchObject({ temporal: { startAt: '2026-09-25T14:30:00+00:00', timezone: 'UTC' } })
  })
  it.each([['reconciliation', reconciliationRecordVersion], ['fragment-reprocess', reprocessVersion]] as const)('refuses changed interpretation of consumed time across %s source versions', (_name, version) => {
    const first = apply(parse(notice, 'Asia/Shanghai'))
    const beforeEvents = structuredClone(first.snapshot.data.processEvents), beforeNodes = structuredClone(first.snapshot.data.scheduleNodes)
    const replay = apply(version(parse(notice, 'UTC')), first.snapshot, 'cross-version', true)
    expect(replay.snapshot.data.processEvents).toEqual(beforeEvents)
    expect(replay.snapshot.data.scheduleNodes).toEqual(beforeNodes)
    expect(replay.run.outcomes.unresolved).toBe(1)
  })
  it.each(['Asia/Shanghai', 'UTC'])('retains a genuinely consumed pre-UU06 timed event without guessing its original zone: %s', timezone => {
    const old = baseline(), mail = message()
    const legacy = applyGmailIngestionHardened(old, { runId: 'legacy-run', sourceId: 'gmail:primary', producer: 'server_scheduler',
      startedAt: now.toISOString(), completedAt: now.toISOString(), sourcePolicy: bootstrapPolicyFor('gmail', 'gmail:primary'),
      messages: [gmailObservationFromMessage(mail, old.data.opportunities, now)] })
    expect(legacy.snapshot.data.processEvents).toHaveLength(1)
    expect(legacy.snapshot.data.semanticReceipts ?? []).toEqual([])
    // Use the normal persisted-snapshot upgrade before comparing business history;
    // it fills legacy duePrecision without reinterpreting its existing instant.
    const consumed = upgradeSnapshotToLatest(legacy.snapshot)
    expect(consumed.data.processEvents[0]!.dueAt).toBe(legacy.snapshot.data.processEvents[0]!.dueAt)
    const replay = apply(reconciliationRecordVersion(parse(notice, timezone)), consumed, 'legacy-replay', true)
    expect(replay.snapshot.data.processEvents).toEqual(consumed.data.processEvents)
    expect(replay.snapshot.data.scheduleNodes).toEqual(consumed.data.scheduleNodes)
    expect(replay.run.outcomes.unresolved).toBe(1)
  })
  it('allows legacy unresolved mail with no timed fact to be interpreted after its target becomes known', () => {
    const old = baseline(); old.data.opportunities = []
    const legacy = applyGmailIngestionHardened(old, { runId: 'legacy-no-fact', sourceId: 'gmail:primary', producer: 'server_scheduler',
      startedAt: now.toISOString(), completedAt: now.toISOString(), sourcePolicy: bootstrapPolicyFor('gmail', 'gmail:primary'),
      messages: [gmailObservationFromMessage(message(), [], now)] })
    expect(legacy.snapshot.data.processEvents).toEqual([])
    legacy.snapshot.data.opportunities = baseline().data.opportunities
    const replay = apply(reconciliationRecordVersion(parse(notice, 'UTC')), legacy.snapshot, 'legacy-known-target', true)
    expect(replay.snapshot.data.processEvents).toHaveLength(1)
    expect(replay.snapshot.data.processEvents[0]!.dueAt).toBe('2026-09-25T14:30:00+00:00')
  })
  it('retains same-zone equivalent legacy latest-start keys when the exact event still proves its temporal value', () => {
    const text = '京东 AI产品经理 笔试开放窗口2026年9月24日09:00至17:00，最晚入场10:00'
    const first = apply(parse(text, 'Asia/Shanghai'))
    for (const receipt of first.snapshot.data.semanticReceipts ?? []) {
      const legacyKey = (key: string) => key.split('|latestStartAt:')[0]!
      receipt.factKeys = receipt.factKeys?.map(legacyKey)
      receipt.mutatedFactKeys = receipt.mutatedFactKeys?.map(legacyKey)
      if (receipt.factMutationObjects) receipt.factMutationObjects = Object.fromEntries(Object.entries(receipt.factMutationObjects).map(([key, refs]) => [legacyKey(key), refs]))
    }
    const replay = apply(reconciliationRecordVersion(parse(text, 'Asia/Shanghai')), first.snapshot, 'legacy-latest', true)
    expect(replay.snapshot.data.processEvents).toEqual(first.snapshot.data.processEvents)
    expect(replay.snapshot.data.scheduleNodes).toEqual(first.snapshot.data.scheduleNodes)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
  })
  it.each([false, true])('does not reinterpret consumed mail after a timezone preference change, reconcile=%s', reconcile => {
    const original = parse(notice, 'Asia/Shanghai')
    const first = apply(original)
    const priorNodes = structuredClone(first.snapshot.data.scheduleNodes)
    const priorEvents = structuredClone(first.snapshot.data.processEvents)
    const replay = apply(parse(notice, 'UTC'), first.snapshot, 'synthetic-replay', reconcile)
    expect(replay.snapshot.data.scheduleNodes).toEqual(priorNodes)
    expect(replay.snapshot.data.processEvents).toEqual(priorEvents)
  })
})

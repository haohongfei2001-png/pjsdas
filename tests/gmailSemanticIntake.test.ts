import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { applySemanticCompensation, applySemanticIntake, resolveSemanticDecision } from '../src/semanticIntake.js'
import { createSnapshot, upgradeSnapshotToLatest, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { createIngestionLedgerTimeline, summarizeCoverage } from '../src/ingestion.js'
import { reconcileIngestionDebt } from '../src/ingestionResolution.js'
import { summarizeSourceHealth } from '../src/sourceHealth.js'

const now = new Date('2026-09-21T00:00:00Z')
function snapshot(): PJSDASSnapshot {
  return { schema: 'pjsdas-local-snapshot', version: 1, exportedAt: now.toISOString(), data: {
    opportunities: [{ id: 'jd', company: '京东', role: 'AI产品经理', currentStageLabel: '筛选中', processStage: 'screening', roleType: 'core', early: false, opportunityValue: 80, fitScore: 80, locallyManaged: true, importedAt: '2026-09-01T00:00:00Z' }],
    processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [],
  } }
}
function message(text: string, id = 'msg-1', receivedAt = '2026-09-20T00:00:00Z') {
  return { id, threadId: 'thread-1', internalDate: String(Date.parse(receivedAt)),
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '京东 AI产品经理 招聘进展' }], body: { data: Buffer.from(text).toString('base64url') } } }
}
function run(base: PJSDASSnapshot, text: string, id = 'msg-1', receivedAt = '2026-09-20T00:00:00Z') {
  return applyGmailSemanticBatch(base, { runId: `run:${id}`, sourceId: 'gmail:primary', checkedAt: now.toISOString(),
    authorized: true, records: [gmailSemanticRecordFromMessage(message(text, id, receivedAt), base.data.opportunities, now)!] })
}
const invitation = '京东 AI产品经理 面试通知，请于2026年9月25日 14:30参加视频面试'

describe('UU06 shared Gmail intake', () => {
  it('commits two independently clear events through shared semantics with source evidence and exact timezone', () => {
    const result = run(snapshot(), '京东 AI产品经理 笔试通知：统一笔试时间2026年9月24日 09:00；' + invitation)
    expect(result.snapshot.data.processEvents).toHaveLength(2)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(2)
    expect(result.snapshot.data.processEvents.map((event) => event.dueAt)).toEqual(['2026-09-24T09:00:00+08:00', '2026-09-25T14:30:00+08:00'])
    expect(result.snapshot.data.scheduleNodes?.every((node) => node.evidenceRefs.some((ref) => ref.includes('fragment:')))).toBe(true)
    expect(result.snapshot.data.semanticReceipts).toHaveLength(1)
    expect(result.compensation.payload.domainCompensations).toHaveLength(2)
    validateSnapshot(result.snapshot)
  })
  it('uses an explicit invitation subject when the body only supplies date and location', () => {
    const mail = message('京东 AI产品经理，请于2026年9月25日 14:30到会议室A参加。')
    mail.payload.headers[0]!.value = '京东 AI产品经理 Interview invitation'
    const record = gmailSemanticRecordFromMessage(mail, snapshot().data.opportunities, now)!
    expect(record.observation.candidates[0]).toMatchObject({ kind: 'process_event', eventType: 'interview_invite', dueAt: '2026-09-25T14:30:00+08:00' })
    const result = applyGmailSemanticBatch(snapshot(), { runId: 'subject', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
    expect(result.snapshot.data.processEvents).toHaveLength(1)
  })
  it('resolves relative dates from the original source time on delayed replay', () => {
    const mail = message('京东 AI产品经理 面试通知：明天 14:30参加面试', 'relative', '2026-09-20T23:55:00Z')
    const first = gmailSemanticRecordFromMessage(mail, snapshot().data.opportunities, now)!
    const replay = gmailSemanticRecordFromMessage(mail, snapshot().data.opportunities, new Date('2026-10-10T00:00:00Z'))!
    expect(first.observation.candidates).toEqual(replay.observation.candidates)
    expect(first.observation.candidates[0]).toMatchObject({ dueAt: '2026-09-22T14:30:00+08:00', temporal: { timezone: 'Asia/Shanghai', rawExpression: '明天 14:30' } })
    const headerMail = { ...mail, internalDate: undefined, payload: { ...mail.payload,
      headers: [...mail.payload.headers, { name: 'Date', value: 'Sun, 20 Sep 2026 23:55:00 +0000' }] } }
    const headerFirst = gmailSemanticRecordFromMessage(headerMail, snapshot().data.opportunities, now)!
    const headerReplay = gmailSemanticRecordFromMessage(headerMail, snapshot().data.opportunities, new Date('2026-10-10T00:00:00Z'))!
    expect(headerFirst.observation.candidates).toEqual(headerReplay.observation.candidates)
    expect(headerReplay.observation.source.assertedAt).toBe('2026-09-20T23:55:00.000Z')
    const missingTimestamp = { ...mail, internalDate: undefined }
    expect(gmailSemanticRecordFromMessage(missingTimestamp, snapshot().data.opportunities, now)?.observation.candidates[0]).toMatchObject({ temporalConfidence: 'low' })
    const noDateApplication = { ...message('京东 AI产品经理 申请已收到'), internalDate: undefined }
    const applicationRecord = gmailSemanticRecordFromMessage(noDateApplication, snapshot().data.opportunities, now)!
    expect(applicationRecord.issueKinds).toContain('interpretation_failure')
    const guarded = applyGmailSemanticBatch(snapshot(), { runId: 'missing-date', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [applicationRecord] })
    expect(guarded.snapshot.data.decisionRequests).toHaveLength(1)
    expect(guarded.snapshot.data.opportunities[0]?.appliedAt).toBeUndefined()
    expect(summarizeCoverage(guarded.snapshot.data.timeline)).toMatchObject({ interpretationFailureCount: 1, businessAmbiguityCount: 1 })
  })
  it('preserves test availability window and submission deadline as distinct shared schedule shapes', () => {
    const text = '京东 AI产品经理 笔试开放窗口2026年9月24日 09:00至2026年9月25日 17:00；提交截止2026年9月25日 18:00'
    const first = run(snapshot(), text, 'window')
    expect(first.snapshot.data.processEvents).toHaveLength(2)
    expect(first.snapshot.data.scheduleNodes?.map((node) => node.temporal.shape)).toEqual(['availability_window', 'deadline'])
    expect(first.snapshot.data.scheduleNodes?.[0]?.temporal).toMatchObject({ startAt: '2026-09-24T09:00:00+08:00', endAt: '2026-09-25T17:00:00+08:00' })
    expect(first.snapshot.data.scheduleNodes?.[1]?.temporal.deadlineAt).toBe('2026-09-25T18:00:00+08:00')
    validateSnapshot(first.snapshot)
    const reschedule = gmailSemanticRecordFromMessage(message('京东 AI产品经理 笔试开放窗口改期为2026年9月26日 09:00至2026年9月27日 17:00'), snapshot().data.opportunities, now)!
    expect(reschedule.observation.candidates[0]).toMatchObject({ kind: 'occurrence_rescheduled', temporal: { shape: 'availability_window', endAt: '2026-09-27T17:00:00+08:00' } })
    const replay = run(first.snapshot, text, 'window2')
    expect(replay.snapshot.data.scheduleNodes).toHaveLength(2)
    const changedWindow = run(first.snapshot, text.replace('17:00', '16:00'), 'window3')
    expect(changedWindow.snapshot.data.decisionRequests?.some((decision) => decision.reason === 'material_conflict')).toBe(true)
    expect(changedWindow.snapshot.data.scheduleNodes?.[0]?.temporal.endAt).toBe('2026-09-25T17:00:00+08:00')
    const undone = applySemanticCompensation(first.snapshot, first.compensation, now)
    expect(undone.data.processEvents).toHaveLength(0)
    expect(undone.data.scheduleNodes?.filter((node) => node.state !== 'cancelled')).toHaveLength(0)
  })
  it('rejects normalized invalid calendar dates and ambiguous multi-date fragments', () => {
    for (const text of ['京东 AI产品经理 面试通知2026年2月30日 14:30', '京东 AI产品经理 面试通知2026-09-22T14:30:00Z', '京东 AI产品经理 面试通知2026-09-22 14:30 Asia/Tokyo', '京东 AI产品经理 面试通知2026年9月25日 14:30或2026年9月26日 14:30']) {
      const result = run(snapshot(), text)
      expect(result.snapshot.data.processEvents).toHaveLength(0)
      expect(result.snapshot.data.decisionRequests).toHaveLength(1)
    }
  })
  it('treats a previously consumed Gmail source record as a no-write replay across a new run id', () => {
    const base = snapshot()
    const record = gmailSemanticRecordFromMessage(message(invitation, 'stable-source-id'), base.data.opportunities, now)!
    const first = applyGmailSemanticBatch(base, {
      runId: 'run:first',
      sourceId: 'gmail:primary',
      checkedAt: now.toISOString(),
      authorized: true,
      records: [record],
    })
    const beforeTimeline = first.snapshot.data.timeline?.length ?? 0
    const replay = applyGmailSemanticBatch(first.snapshot, {
      runId: 'run:retry',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:10:00Z').toISOString(),
      authorized: true,
      records: [record],
    })
    expect(replay.alreadyApplied).toBe(true)
    expect(replay.snapshot).toBe(first.snapshot)
    expect(replay.snapshot.data.timeline).toHaveLength(beforeTimeline)
    expect(replay.run).toMatchObject({
      receivedCount: 1,
      accountedCount: 1,
      outcomes: { duplicate: 1 },
    })
  })

  it('reconcileExisting records a complete no-write replay as a later ignored source state and settles old fragment debt', () => {
    const base = snapshot()
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-no-write',
      runId: 'legacy-fragment-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-no-write',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message('京东 AI产品经理 招聘资讯更新', 'fragment-replay-no-write'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-no-write:fragment-reprocess-v2'
    record.observation.source.sourceVersion = 'fragment-reprocess-v2'
    record.observation.candidates = []
    record.gaps = []

    const replay = applyGmailSemanticBatch(base, {
      runId: 'fragment-replay-no-write',
      sourceId: 'gmail:primary',
      checkedAt: now.toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    const sourceRecords = replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-no-write')
    expect(sourceRecords.map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'ignored'])
    expect(replay.run.outcomes.ignored).toBe(1)

    const reconciled = reconcileIngestionDebt(replay.snapshot, now)
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'ignored',
      reason: 'later_source_state',
      sourceRecordId: 'fragment-replay-no-write',
    })
    expect(summarizeCoverage(reconciled.snapshot.data.timeline).activeUnresolvedCount).toBe(0)
  })

  it('reconcileExisting keeps the source unresolved when the complete replay still needs a semantic decision', () => {
    const base = snapshot()
    base.data.opportunities.push({ ...base.data.opportunities[0]!, id: 'jd-ambiguous' })
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-decision',
      runId: 'legacy-fragment-decision-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-decision',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-decision'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-decision:fragment-reprocess-v2'
    record.observation.source.sourceVersion = 'fragment-reprocess-v2'
    record.gaps = []

    const replay = applyGmailSemanticBatch(base, {
      runId: 'fragment-replay-decision',
      sourceId: 'gmail:primary',
      checkedAt: now.toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    const sourceRecords = replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-decision')
    expect(sourceRecords.map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'unresolved'])
    expect(replay.snapshot.data.decisionRequests).toHaveLength(1)

    const reconciled = reconcileIngestionDebt(replay.snapshot, now)
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'semantic_decision_open',
      sourceRecordId: 'fragment-replay-decision',
    })
  })

  it('does not use an older committed ALREADY_APPLIED receipt as fresh parser-completeness evidence', () => {
    const base = snapshot()
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-stale-committed',
      runId: 'legacy-stale-committed-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-stale-committed',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-stale-committed'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-stale-committed:reconciliation-v1'
    record.observation.source.sourceVersion = 'reconciliation-v1'
    record.gaps = []

    const oldSemanticPass = applySemanticIntake(base, record.observation, { authorized: true, now })
    expect(oldSemanticPass.status).toBe('APPLIED')
    expect(oldSemanticPass.receipt?.status).toBe('committed')

    const replay = applyGmailSemanticBatch(oldSemanticPass.snapshot, {
      runId: 'fragment-replay-stale-committed',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:01:00Z').toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    expect(replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-stale-committed')
      .map((item) => item.ingestion?.outcome)).toEqual(['unresolved'])
    expect(replay.run.outcomes.unresolved).toBe(1)
  })

  it('does not reactivate or append source debt when an ALREADY_APPLIED decision is already settled', () => {
    const base = snapshot()
    base.data.opportunities.push({ ...base.data.opportunities[0]!, id: 'jd-settled-decision' })
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-settled-decision',
      runId: 'legacy-settled-decision-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-settled-decision',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-settled-decision'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-settled-decision:reconciliation-v1'
    record.observation.source.sourceVersion = 'reconciliation-v1'
    record.gaps = []

    const first = applySemanticIntake(base, record.observation, { authorized: true, now })
    expect(first.status).toBe('DECISION_REQUIRED')
    const request = first.decisionRequests[0]!
    const choice = request.choices.find((item) => item.resolution && !item.resolution.dismiss)
      ?? request.choices[0]!
    const settled = resolveSemanticDecision(
      first.snapshot,
      request.id,
      choice.id,
      new Date('2026-09-21T00:01:00Z'),
    )
    const settledRequest = settled.snapshot.data.decisionRequests?.find((item) => item.id === request.id)
    expect(['answered', 'superseded']).toContain(settledRequest?.state)

    const sourceRowsBefore = settled.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-settled-decision').length
    const replay = applyGmailSemanticBatch(settled.snapshot, {
      runId: 'fragment-replay-settled-decision',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:02:00Z').toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    const sourceRowsAfter = replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-settled-decision').length
    expect(sourceRowsBefore).toBe(1)
    expect(sourceRowsAfter).toBe(1)
    expect(replay.snapshot.data.decisionRequests?.find((item) => item.id === request.id)?.state)
      .toBe(settledRequest?.state)
  })

  it('does not amplify settled Gmail source ledger rows during reconcileExisting replay', () => {
    const base = snapshot()
    const record = gmailSemanticRecordFromMessage(
      message(invitation, 'settled-reconciliation-replay'),
      base.data.opportunities,
      now,
    )!
    const first = applyGmailSemanticBatch(base, {
      runId: 'settled-reconciliation-first',
      sourceId: 'gmail:primary',
      checkedAt: now.toISOString(),
      authorized: true,
      records: [record],
    })
    expect(first.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'settled-reconciliation-replay')).toHaveLength(1)

    const second = applyGmailSemanticBatch(first.snapshot, {
      runId: 'settled-reconciliation-second',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:01:00Z').toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    const third = applyGmailSemanticBatch(second.snapshot, {
      runId: 'settled-reconciliation-third',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:02:00Z').toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })

    expect(second.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'settled-reconciliation-replay')).toHaveLength(1)
    expect(third.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'settled-reconciliation-replay')).toHaveLength(1)
    expect(second.run.outcomes.duplicate).toBe(1)
    expect(third.run.outcomes.duplicate).toBe(1)
  })

  it('does not settle a reconcileExisting replay whose matching semantic receipt was undone', () => {
    const base = snapshot()
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-undone',
      runId: 'legacy-fragment-undone-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-undone',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-undone'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-undone:fragment-reprocess-v2'
    record.observation.source.sourceVersion = 'fragment-reprocess-v2'
    record.gaps = []

    const applied = applySemanticIntake(base, record.observation, { authorized: true, now })
    expect(applied.status).toBe('APPLIED')
    const undone = applySemanticCompensation(
      applied.snapshot,
      applied.compensation!,
      new Date('2026-09-21T00:01:00Z'),
    )
    expect(undone.data.semanticReceipts?.find((receipt) =>
      receipt.sourceRecordId === 'fragment-replay-undone')?.status).toBe('undone')

    const replay = applyGmailSemanticBatch(undone, {
      runId: 'fragment-replay-undone',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:02:00Z').toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    const sourceRecords = replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-undone')
    expect(sourceRecords.length).toBeGreaterThanOrEqual(2)
    expect(sourceRecords.every((item) => item.ingestion?.outcome === 'unresolved')).toBe(true)
    expect(replay.run.outcomes.unresolved).toBe(1)

    const reconciled = reconcileIngestionDebt(replay.snapshot, new Date('2026-09-21T00:03:00Z'))
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'semantic_decision_open',
      sourceRecordId: 'fragment-replay-undone',
    })
    expect(summarizeCoverage(reconciled.snapshot.data.timeline).activeUnresolvedCount).toBe(1)
  })

  it('preserves an older open source decision even when a newer parser version can apply another fact', () => {
    const base = snapshot()
    base.data.opportunities.push({ ...base.data.opportunities[0]!, id: 'jd-historical-decision' })
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-historical-open',
      runId: 'legacy-historical-open-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-historical-open',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]

    const oldRecord = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-historical-open'),
      base.data.opportunities,
      now,
    )!
    oldRecord.observation.inputId = 'gmail:fragment-replay-historical-open:reconciliation-v1'
    oldRecord.observation.source.sourceVersion = 'reconciliation-v1'
    const oldInterpretation = applySemanticIntake(base, oldRecord.observation, { authorized: true, now })
    expect(oldInterpretation.status).toBe('DECISION_REQUIRED')
    expect(oldInterpretation.decisionRequests[0]?.state).toBe('open')

    const narrowed = structuredClone(oldInterpretation.snapshot)
    narrowed.data.opportunities = narrowed.data.opportunities.filter((item) => item.id === 'jd')
    const freshRecord = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-historical-open'),
      narrowed.data.opportunities,
      now,
    )!
    freshRecord.observation.inputId = 'gmail:fragment-replay-historical-open:fragment-reprocess-v2'
    freshRecord.observation.source.sourceVersion = 'fragment-reprocess-v2'
    freshRecord.gaps = []

    const replay = applyGmailSemanticBatch(narrowed, {
      runId: 'fragment-replay-historical-open',
      sourceId: 'gmail:primary',
      checkedAt: new Date('2026-09-21T00:02:00Z').toISOString(),
      authorized: true,
      records: [freshRecord],
      reconcileExisting: true,
    })
    expect(replay.snapshot.data.processEvents).toHaveLength(1)
    expect(replay.snapshot.data.decisionRequests?.find((item) =>
      item.id === oldInterpretation.decisionRequests[0]!.id)?.state).toBe('open')
    expect(replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-historical-open')
      .map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'unresolved'])

    const reconciled = reconcileIngestionDebt(replay.snapshot, new Date('2026-09-21T00:03:00Z'))
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'semantic_decision_open',
      sourceRecordId: 'fragment-replay-historical-open',
    })
  })

  it('reopens fragment debt immediately when the conclusive replay write is undone', () => {
    const base = snapshot()
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-applied-undo',
      runId: 'legacy-fragment-applied-undo-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-applied-undo',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-applied-undo'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-applied-undo:fragment-reprocess-v2'
    record.observation.source.sourceVersion = 'fragment-reprocess-v2'
    record.gaps = []

    const replay = applyGmailSemanticBatch(base, {
      runId: 'fragment-replay-applied-undo',
      sourceId: 'gmail:primary',
      checkedAt: now.toISOString(),
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    expect(replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-applied-undo')
      .map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'updated'])
    expect(replay.compensation.payload.receiptIds).toHaveLength(1)

    const undone = applySemanticCompensation(
      replay.snapshot,
      replay.compensation,
      now,
    )
    const sourceRows = undone.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-applied-undo')
    expect(sourceRows.map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'updated', 'unresolved'])
    expect(sourceRows[2]?.ingestion?.reason).toBe('Semantic write was undone; source requires fresh reconciliation.')
    expect(Date.parse(sourceRows[2]!.ingestion!.accountedAt)).toBeGreaterThan(
      Date.parse(sourceRows[1]!.ingestion!.accountedAt),
    )
    expect(undone.data.semanticReceipts?.find((receipt) =>
      receipt.sourceRecordId === 'fragment-replay-applied-undo')?.status).toBe('undone')
    expect(summarizeCoverage(undone.data.timeline).activeUnresolvedCount).toBe(1)

    const reconciled = reconcileIngestionDebt(undone, new Date('2026-09-21T00:02:00Z'))
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
      sourceRecordId: 'fragment-replay-applied-undo',
    })
  })

  it('reopens source debt when undoing an earlier write after a later conclusive replay', () => {
    const base = snapshot()
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-later-before-undo',
      runId: 'legacy-fragment-later-before-undo',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-later-before-undo',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: '2026-09-10T00:00:00Z',
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]

    const firstRecord = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-later-before-undo'),
      base.data.opportunities,
      now,
    )!
    firstRecord.observation.inputId = 'gmail:fragment-replay-later-before-undo:v1'
    firstRecord.observation.source.sourceVersion = 'fragment-reprocess-v1'
    firstRecord.gaps = []
    const first = applyGmailSemanticBatch(base, {
      runId: 'fragment-replay-later-before-undo:v1',
      sourceId: 'gmail:primary',
      checkedAt: now.toISOString(),
      authorized: true,
      records: [firstRecord],
      reconcileExisting: true,
    })
    expect(first.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-later-before-undo')
      .map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'updated'])

    const secondRecord = gmailSemanticRecordFromMessage(
      message(invitation, 'fragment-replay-later-before-undo'),
      first.snapshot.data.opportunities,
      new Date('2026-09-21T00:01:00Z'),
    )!
    secondRecord.observation.inputId = 'gmail:fragment-replay-later-before-undo:v2'
    secondRecord.observation.source.sourceVersion = 'fragment-reprocess-v2'
    secondRecord.gaps = []
    const second = applyGmailSemanticBatch(first.snapshot, {
      runId: 'fragment-replay-later-before-undo:v2',
      sourceId: 'gmail:primary',
      checkedAt: '2026-09-21T00:01:00.000Z',
      authorized: true,
      records: [secondRecord],
      reconcileExisting: true,
    })
    expect(second.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-later-before-undo')
      .map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'updated', 'updated'])

    const undone = applySemanticCompensation(
      second.snapshot,
      first.compensation,
      new Date('2026-09-21T00:02:00Z'),
    )
    const sourceRows = undone.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-later-before-undo')
    expect(sourceRows.map((item) => item.ingestion?.outcome)).toEqual([
      'unresolved', 'updated', 'updated', 'unresolved',
    ])
    expect(Date.parse(sourceRows[3]!.ingestion!.accountedAt)).toBeGreaterThan(
      Date.parse(sourceRows[2]!.ingestion!.accountedAt),
    )
    expect(summarizeCoverage(undone.data.timeline).activeUnresolvedCount).toBe(1)

    const reconciled = reconcileIngestionDebt(undone, new Date('2026-09-21T00:03:00Z'))
    expect(reconciled.appended[0]?.ingestionResolution).toMatchObject({
      outcome: 'active_unresolved',
      reason: 'unlinked_unresolved',
      sourceRecordId: 'fragment-replay-later-before-undo',
    })
  })

  it('orders a persisted reconcileExisting source transition after a tied prior state', () => {
    const base = snapshot()
    const tiedAt = now.toISOString()
    const legacy = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-replay-tied-transition',
      runId: 'legacy-fragment-tied-transition',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-replay-tied-transition',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: tiedAt,
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    base.data.timeline = [legacy]
    const record = gmailSemanticRecordFromMessage(
      message('京东 AI产品经理 招聘资讯更新', 'fragment-replay-tied-transition'),
      base.data.opportunities,
      now,
    )!
    record.observation.inputId = 'gmail:fragment-replay-tied-transition:v2'
    record.observation.source.sourceVersion = 'fragment-reprocess-v2'
    record.observation.candidates = []
    record.gaps = []

    const replay = applyGmailSemanticBatch(base, {
      runId: 'fragment-replay-tied-transition:v2',
      sourceId: 'gmail:primary',
      checkedAt: tiedAt,
      authorized: true,
      records: [record],
      reconcileExisting: true,
    })
    const sourceRows = replay.snapshot.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-replay-tied-transition')
    expect(sourceRows.map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'ignored'])
    expect(Date.parse(sourceRows[1]!.ingestion!.accountedAt)).toBeGreaterThan(Date.parse(tiedAt))
  })

  it('undo reopens a tied historical source state even when durable ordering puts unresolved first', () => {
    const base = snapshot()
    const tiedAt = now.toISOString()
    const unresolvedRow = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-undo-tied-state',
      runId: 'legacy-fragment-undo-tied-state',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-undo-tied-state',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: tiedAt,
      reason: 'Message exceeds the 20-fragment interpretation limit.',
    })
    const updatedRow = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-undo-tied-state',
      runId: 'semantic-run:tied-state',
      recordType: 'recruiting_message',
      outcome: 'updated',
      fingerprint: 'fp:fragment-undo-tied-state:v2',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: tiedAt,
      reason: 'Later semantic state applied.',
    })
    base.data.timeline = [unresolvedRow, updatedRow]
    base.data.semanticReceipts = [{
      id: 'semantic-receipt:fragment-undo-tied-state',
      inputId: 'gmail:fragment-undo-tied-state:v2',
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'fragment-undo-tied-state',
      sourceVersion: 'fragment-reprocess-v2',
      commandId: 'semantic-run:tied-state',
      status: 'committed',
      summary: 'Applied.',
      affectedObjects: [],
      decisionRequestIds: [],
      undoAvailable: true,
      createdAt: tiedAt,
      updatedAt: tiedAt,
    }]

    const undone = applySemanticCompensation(base, {
      operation: 'semantic_batch',
      payload: {
        domainCompensations: [],
        decisionRequestIds: [],
        receiptIds: ['semantic-receipt:fragment-undo-tied-state'],
      },
    }, now)
    const sourceRows = undone.data.timeline.filter((item) =>
      item.ingestion?.sourceRecordId === 'fragment-undo-tied-state')
    expect(sourceRows.map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'updated', 'unresolved'])
    expect(Date.parse(sourceRows[2]!.ingestion!.accountedAt)).toBeGreaterThan(Date.parse(tiedAt))
    expect(summarizeCoverage(undone.data.timeline).activeUnresolvedCount).toBe(1)
  })

  it('appends a distinct undo source marker even when the latest Gmail source row is already unresolved', () => {
    const base = snapshot()
    const sourceRecordId = 'fragment-undo-behind-unresolved'
    const latest = createIngestionLedgerTimeline({
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId,
      runId: 'later-mixed-run',
      recordType: 'recruiting_message',
      outcome: 'unresolved',
      fingerprint: 'fp:fragment-undo-behind-unresolved',
      receivedAt: '2026-09-10T00:00:00Z',
      accountedAt: now.toISOString(),
      reason: 'A later parser run still has an open decision.',
    })
    base.data.timeline = [latest]
    base.data.semanticReceipts = [{
      id: 'semantic-receipt:fragment-undo-behind-unresolved',
      inputId: 'gmail:fragment-undo-behind-unresolved:v1',
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId,
      sourceVersion: 'v1',
      commandId: 'older-committed-run',
      status: 'committed',
      summary: 'Applied an earlier fact.',
      affectedObjects: [],
      decisionRequestIds: [],
      factKeys: ['application_submitted|opp:jd'],
      undoAvailable: true,
      createdAt: '2026-09-20T23:59:00.000Z',
      updatedAt: '2026-09-20T23:59:00.000Z',
    }]

    const undone = applySemanticCompensation(base, {
      operation: 'semantic_batch',
      payload: {
        domainCompensations: [],
        decisionRequestIds: [],
        receiptIds: ['semantic-receipt:fragment-undo-behind-unresolved'],
      },
    }, now)

    const rows = undone.data.timeline.filter((item) => item.ingestion?.sourceRecordId === sourceRecordId)
    expect(rows.map((item) => item.ingestion?.outcome)).toEqual(['unresolved', 'unresolved'])
    expect(rows[1]?.ingestion?.reason).toBe('Semantic write was undone; source requires fresh reconciliation.')
    expect(Date.parse(rows[1]!.ingestion!.accountedAt)).toBeGreaterThan(Date.parse(rows[0]!.ingestion!.accountedAt))
    expect(summarizeCoverage(undone.data.timeline).activeUnresolvedCount).toBe(1)
  })

  it('invalidates a dependent committed replay receipt and allows the same source version to recover after undo', () => {
    const base = snapshot()
    const observation = (version: string) => ({
      contractVersion: 1 as const,
      inputId: `gmail:dependent-replay-recovery:${version}`,
      source: {
        kind: 'gmail' as const,
        sourceId: 'gmail:primary',
        sourceRecordId: 'dependent-replay-recovery',
        sourceVersion: version,
        observedAt: now.toISOString(),
        assertedAt: now.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: `deadline:${version}`,
        kind: 'opportunity_deadline' as const,
        target: { opportunityId: 'jd' },
        deadline: '2026-09-25',
        precision: 'date' as const,
        objectConfidence: 'high' as const,
        eventConfidence: 'high' as const,
        temporalConfidence: 'high' as const,
        evidenceRefs: ['gmail:dependent-replay-recovery'],
        sourceVersionRefs: [`dependent-replay-recovery:${version}`],
      }],
    })

    const firstObservation = observation('v1')
    const first = applySemanticIntake(base, firstObservation, { authorized: true, now })
    expect(first.status).toBe('APPLIED')
    expect(first.snapshot.data.opportunities[0]?.deadline).toBe('2026-09-25')
    expect(first.compensation?.payload.domainCompensations).toHaveLength(1)

    const secondObservation = observation('v2')
    const second = applySemanticIntake(first.snapshot, secondObservation, {
      authorized: true,
      now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(second.status).toBe('APPLIED')
    expect(second.receipt?.factKeys).toEqual(first.receipt?.factKeys)

    const persistedSecond = structuredClone(second.snapshot)
    persistedSecond.data.semanticReceipts?.reverse()
    const undone = applySemanticCompensation(
      persistedSecond,
      first.compensation!,
      new Date('2026-09-21T00:02:00Z'),
    )
    expect(undone.data.opportunities[0]?.deadline).toBeUndefined()
    const dependent = undone.data.semanticReceipts?.find((receipt) => receipt.id === second.receipt!.id)
    expect(dependent).toMatchObject({
      status: 'committed',
      factInvalidations: [{
        factKey: first.receipt!.factKeys![0],
        invalidatedByReceiptId: first.receipt!.id,
        invalidatedAt: '2026-09-21T00:02:00.000Z',
      }],
    })

    const recovered = applySemanticIntake(undone, secondObservation, {
      authorized: true,
      now: new Date('2026-09-21T00:03:00Z'),
    })
    expect(recovered.status).toBe('APPLIED')
    expect(recovered.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(recovered.snapshot.data.opportunities[0]?.deadline).toBe('2026-09-25')
    expect(recovered.receipt?.factInvalidations).toBeUndefined()
  })

  it('does not invalidate an earlier creator receipt when undoing a later no-op replay', () => {
    const base = snapshot()
    const observation = (version: string) => ({
      contractVersion: 1 as const,
      inputId: `gmail:undo-later-noop:${version}`,
      source: {
        kind: 'gmail' as const,
        sourceId: 'gmail:primary',
        sourceRecordId: 'undo-later-noop',
        sourceVersion: version,
        observedAt: now.toISOString(),
        assertedAt: now.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: `deadline:${version}`,
        kind: 'opportunity_deadline' as const,
        target: { opportunityId: 'jd' },
        deadline: '2026-09-25',
        precision: 'date' as const,
        objectConfidence: 'high' as const,
        eventConfidence: 'high' as const,
        temporalConfidence: 'high' as const,
        evidenceRefs: ['gmail:undo-later-noop'],
        sourceVersionRefs: [`undo-later-noop:${version}`],
      }],
    })

    const first = applySemanticIntake(base, observation('v1'), { authorized: true, now })
    expect(first.compensation?.payload.domainCompensations).toHaveLength(1)
    const laterReceiptId = 'semantic-receipt:undo-later-noop:v2'
    const withLaterNoop = structuredClone(first.snapshot)
    withLaterNoop.data.semanticReceipts = [...(withLaterNoop.data.semanticReceipts ?? []), {
      id: laterReceiptId,
      inputId: 'gmail:undo-later-noop:v2',
      sourceKind: 'gmail',
      sourceId: 'gmail:primary',
      sourceRecordId: 'undo-later-noop',
      sourceVersion: 'v2',
      status: 'committed',
      summary: 'Same fact was already present; no new domain mutation.',
      affectedObjects: first.receipt?.affectedObjects ?? [],
      decisionRequestIds: [],
      factKeys: first.receipt?.factKeys,
      undoAvailable: false,
      createdAt: '2026-09-21T00:01:00.000Z',
      updatedAt: '2026-09-21T00:01:00.000Z',
    }]

    withLaterNoop.data.semanticReceipts?.reverse()
    const undoneLater = applySemanticCompensation(
      withLaterNoop,
      {
        operation: 'semantic_batch',
        payload: {
          domainCompensations: [],
          decisionRequestIds: [],
          receiptIds: [laterReceiptId],
        },
      },
      new Date('2026-09-21T00:02:00Z'),
    )
    const original = undoneLater.data.semanticReceipts?.find((receipt) => receipt.id === first.receipt!.id)
    expect(original).toMatchObject({ status: 'committed' })
    expect(original?.factInvalidations).toBeUndefined()
    expect(original?.undoAvailable).toBe(true)
    expect(undoneLater.data.opportunities[0]?.deadline).toBe('2026-09-25')
  })

  it('invalidates only overlapping facts in a later partially dependent receipt', () => {
    const base = snapshot()
    const targetFact = 'opportunity_deadline|opp:jd|date|2026-09-25T00:00:00.000Z'
    const independentFact = 'manual_action|independent action|'
    base.data.semanticReceipts = [
      {
        id: 'semantic-receipt:partial-target',
        inputId: 'gmail:partial-target:v1',
        sourceKind: 'gmail',
        sourceId: 'gmail:primary',
        sourceRecordId: 'partial-source',
        sourceVersion: 'v1',
        commandId: 'partial-target-run',
        status: 'committed',
        summary: 'Created target fact.',
        affectedObjects: [],
        decisionRequestIds: [],
        factKeys: [targetFact],
        undoAvailable: true,
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      },
      {
        id: 'semantic-receipt:partial-dependent',
        inputId: 'gmail:partial-target:v2',
        sourceKind: 'gmail',
        sourceId: 'gmail:primary',
        sourceRecordId: 'partial-source',
        sourceVersion: 'v2',
        commandId: 'partial-dependent-run',
        status: 'committed',
        summary: 'Contains one dependent and one independent fact.',
        affectedObjects: [],
        decisionRequestIds: [],
        factKeys: [targetFact, independentFact],
        undoAvailable: true,
        createdAt: '2026-09-21T00:01:00.000Z',
        updatedAt: '2026-09-21T00:01:00.000Z',
      },
    ]

    const undone = applySemanticCompensation(base, {
      operation: 'semantic_batch',
      payload: {
        domainCompensations: [],
        decisionRequestIds: [],
        receiptIds: ['semantic-receipt:partial-target'],
      },
    }, new Date('2026-09-21T00:02:00Z'))
    const dependent = undone.data.semanticReceipts?.find((receipt) => receipt.id === 'semantic-receipt:partial-dependent')
    expect(dependent?.factInvalidations).toEqual([{
      factKey: targetFact,
      invalidatedByReceiptId: 'semantic-receipt:partial-target',
      invalidatedAt: '2026-09-21T00:02:00.000Z',
      invalidatedAfterSequence: 2,
    }])
    expect(dependent?.undoAvailable).toBe(true)

    const crossSource = applySemanticIntake(undone, {
      contractVersion: 1,
      inputId: 'gmail:other-source:independent',
      source: {
        kind: 'gmail',
        sourceId: 'gmail:other',
        sourceRecordId: 'other-independent',
        sourceVersion: 'v1',
        observedAt: '2026-09-21T00:03:00.000Z',
        assertedAt: '2026-09-21T00:03:00.000Z',
        timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion',
      candidates: [{
        id: 'independent-action',
        kind: 'manual_action',
        title: 'Independent Action',
        objectConfidence: 'high',
        eventConfidence: 'high',
        evidenceRefs: ['gmail:other-independent'],
        sourceVersionRefs: ['other-independent:v1'],
      }],
    }, { authorized: true, now: new Date('2026-09-21T00:03:00Z') })
    expect(crossSource.status).toBe('APPLIED')
    expect(crossSource.compensation?.payload.domainCompensations).toHaveLength(0)
    expect(crossSource.snapshot.data.actions).toHaveLength(0)
  })

  it('recovers only the invalidated fact after durable receipt reordering without duplicating a manual action', () => {
    const observation = (version: string, withAction: boolean) => ({
      contractVersion: 1 as const,
      inputId: `gmail:partial-recovery:${version}`,
      source: {
        kind: 'gmail' as const,
        sourceId: 'gmail:primary',
        sourceRecordId: 'partial-recovery',
        sourceVersion: version,
        observedAt: now.toISOString(),
        assertedAt: now.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [
        {
          id: `deadline:${version}`,
          kind: 'opportunity_deadline' as const,
          target: { opportunityId: 'jd' },
          deadline: '2026-09-25',
          precision: 'date' as const,
          objectConfidence: 'high' as const,
          eventConfidence: 'high' as const,
          temporalConfidence: 'high' as const,
          evidenceRefs: ['gmail:partial-recovery'],
          sourceVersionRefs: [`partial-recovery:${version}`],
        },
        ...(withAction ? [{
          id: 'independent-action',
          kind: 'manual_action' as const,
          title: 'Independent Action',
          objectConfidence: 'high' as const,
          eventConfidence: 'high' as const,
          evidenceRefs: ['gmail:partial-recovery'],
          sourceVersionRefs: [`partial-recovery:${version}`],
        }] : []),
      ],
    })
    const first = applySemanticIntake(snapshot(), observation('v1', false), { authorized: true, now })
    const secondObservation = observation('v2', true)
    const second = applySemanticIntake(first.snapshot, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(second.snapshot.data.actions).toHaveLength(1)
    expect(second.receipt?.factKeys).toHaveLength(2)
    const originalAction = structuredClone(second.snapshot.data.actions[0])
    const persisted = structuredClone(second.snapshot)
    persisted.data.semanticReceipts?.reverse() // IndexedDB returns primary-key order, not creation order.
    const undone = applySemanticCompensation(persisted, first.compensation!, new Date('2026-09-21T00:02:00Z'))
    const dependent = undone.data.semanticReceipts?.find((item) => item.id === second.receipt!.id)
    expect(dependent?.factInvalidations?.map((item) => item.factKey)).toEqual(first.receipt?.factKeys)
    expect(dependent?.factKeys).toHaveLength(2)
    expect(undone.data.actions).toEqual([originalAction])

    const recovered = applySemanticIntake(undone, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:03:00Z'),
    })
    expect(recovered.status).toBe('APPLIED')
    expect(recovered.snapshot.data.actions).toEqual([originalAction])
    expect(recovered.snapshot.data.opportunities[0]?.deadline).toBe('2026-09-25')
    expect(recovered.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(recovered.receipt?.factKeys).toEqual(first.receipt?.factKeys)
    expect(recovered.receipt?.id).not.toBe(second.receipt?.id)
    expect(recovered.snapshot.data.semanticReceipts).toHaveLength(3)
    expect(recovered.snapshot.data.semanticReceipts?.find((item) => item.id === second.receipt!.id)?.factInvalidations).toEqual(dependent?.factInvalidations)
    const replay = applySemanticIntake(recovered.snapshot, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:04:00Z'),
    })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot.data.actions).toEqual([originalAction])
    validateSnapshot(recovered.snapshot)
  })

  it('invalidates a later cross-source dedupe receipt when its original mutation is undone', () => {
    const observation = (sourceId: string) => ({
      contractVersion: 1 as const,
      inputId: `${sourceId}:cross-source-deadline`,
      source: {
        kind: 'gmail' as const, sourceId, sourceRecordId: 'cross-source-deadline',
        sourceVersion: 'v1', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'deadline', kind: 'opportunity_deadline' as const, target: { opportunityId: 'jd' },
        deadline: '2026-09-25', precision: 'date' as const,
        objectConfidence: 'high' as const, eventConfidence: 'high' as const, temporalConfidence: 'high' as const,
        evidenceRefs: ['cross-source-deadline'], sourceVersionRefs: ['cross-source-deadline:v1'],
      }],
    })
    const creator = applySemanticIntake(snapshot(), observation('gmail:first'), { authorized: true, now })
    const follower = applySemanticIntake(creator.snapshot, observation('gmail:second'), {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(follower.compensation?.payload.domainCompensations).toHaveLength(0)
    const undone = applySemanticCompensation(follower.snapshot, creator.compensation!, new Date('2026-09-21T00:02:00Z'))
    expect(undone.data.opportunities[0]?.deadline).toBeUndefined()
    expect(undone.data.semanticReceipts?.find((item) => item.id === follower.receipt!.id)?.factInvalidations?.[0]?.factKey)
      .toBe(creator.receipt?.factKeys?.[0])
    const replay = applySemanticIntake(undone, observation('gmail:second'), {
      authorized: true, now: new Date('2026-09-21T00:03:00Z'),
    })
    expect(replay.status).toBe('APPLIED')
    expect(replay.compensation?.payload.domainCompensations).toHaveLength(1)
    expect(replay.snapshot.data.opportunities[0]?.deadline).toBe('2026-09-25')
    validateSnapshot(replay.snapshot)
  })

  it('recovers a second invalidated fact after an earlier subset was already restored', () => {
    const base = snapshot()
    base.data.opportunities.push({ ...base.data.opportunities[0]!, id: 'other' })
    const observation = (version: string, targets: string[]) => ({
      contractVersion: 1 as const,
      inputId: `gmail:staggered-recovery:${version}`,
      source: {
        kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId: 'staggered-recovery',
        sourceVersion: version, observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: targets.map((target) => ({
        id: `deadline:${target}`, kind: 'opportunity_deadline' as const, target: { opportunityId: target },
        deadline: '2026-09-25', precision: 'date' as const,
        objectConfidence: 'high' as const, eventConfidence: 'high' as const, temporalConfidence: 'high' as const,
        evidenceRefs: ['staggered-recovery'], sourceVersionRefs: [`staggered-recovery:${version}`],
      })),
    })
    const first = applySemanticIntake(base, observation('v1', ['jd']), { authorized: true, now })
    const second = applySemanticIntake(first.snapshot, observation('v2', ['other']), {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    const combined = observation('v3', ['jd', 'other'])
    const third = applySemanticIntake(second.snapshot, combined, {
      authorized: true, now: new Date('2026-09-21T00:02:00Z'),
    })
    const firstUndone = applySemanticCompensation(third.snapshot, first.compensation!, new Date('2026-09-21T00:03:00Z'))
    const firstRecovered = applySemanticIntake(firstUndone, combined, {
      authorized: true, now: new Date('2026-09-21T00:04:00Z'),
    })
    expect(firstRecovered.receipt?.factKeys).toEqual(first.receipt?.factKeys)
    const secondUndone = applySemanticCompensation(firstRecovered.snapshot, second.compensation!, new Date('2026-09-21T00:05:00Z'))
    const secondRecovered = applySemanticIntake(secondUndone, combined, {
      authorized: true, now: new Date('2026-09-21T00:06:00Z'),
    })
    expect(secondRecovered.status).toBe('APPLIED')
    expect(secondRecovered.receipt?.factKeys).toEqual(second.receipt?.factKeys)
    expect(secondRecovered.snapshot.data.opportunities.map((item) => item.deadline)).toEqual(['2026-09-25', '2026-09-25'])
    expect(secondRecovered.snapshot.data.semanticReceipts).toHaveLength(5)
    validateSnapshot(secondRecovered.snapshot)
  })

  it('uses persisted sequence when a later dependent receipt has an older caller timestamp', () => {
    const base = snapshot()
    const factKey = 'opportunity_deadline|opp:jd|date|2026-09-25T00:00:00.000Z'
    base.data.semanticReceipts = [
      {
        id: 'z-creator', inputId: 'same-time:creator', sourceKind: 'gmail', sourceId: 'gmail:primary',
        sourceRecordId: 'same-time', sourceVersion: 'v1', status: 'committed', summary: 'Creator',
        affectedObjects: [], decisionRequestIds: [], factKeys: [factKey], mutatedFactKeys: [factKey],
        creationSequence: 1, undoAvailable: true,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      },
      {
        id: 'a-dependent', inputId: 'same-time:follower', sourceKind: 'gmail', sourceId: 'gmail:primary',
        sourceRecordId: 'same-time', sourceVersion: 'v2', status: 'committed', summary: 'No-op follower',
        affectedObjects: [], decisionRequestIds: [], factKeys: [factKey], creationSequence: 2,
        undoAvailable: false, createdAt: '2026-09-20T23:59:00.000Z', updatedAt: '2026-09-20T23:59:00.000Z',
      },
    ]
    base.data.semanticReceipts.sort((left, right) => left.id.localeCompare(right.id))
    const undone = applySemanticCompensation(base, {
      operation: 'semantic_batch', payload: { domainCompensations: [], decisionRequestIds: [], receiptIds: ['z-creator'] },
    }, new Date('2026-09-21T00:01:00Z'))
    expect(undone.data.semanticReceipts?.find((item) => item.id === 'a-dependent')?.factInvalidations?.[0]?.factKey)
      .toBe(factKey)
    validateSnapshot(undone)
  })

  it('backfills historical same-time Gmail receipt order from durable ingestion times after ID reordering', () => {
    const base = snapshot()
    const batchTime = new Date('2026-09-21T00:00:00Z')
    const observation = (sourceRecordId: string, receivedAt: string) => ({
      contractVersion: 1 as const,
      inputId: `gmail:historical-order:${sourceRecordId}`,
      source: {
        kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId,
        sourceVersion: 'v1', observedAt: receivedAt, assertedAt: receivedAt, timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'deadline', kind: 'opportunity_deadline' as const, target: { opportunityId: 'jd' },
        deadline: '2026-09-25', precision: 'date' as const,
        objectConfidence: 'high' as const, eventConfidence: 'high' as const, temporalConfidence: 'high' as const,
        evidenceRefs: ['historical-order'], sourceVersionRefs: ['historical-order:v1'],
      }],
    })
    base.data.timeline = [
      ['older-mail', '2026-09-20T09:00:00Z'],
      ['newer-mail', '2026-09-20T09:01:00Z'],
    ].map(([sourceRecordId, receivedAt]) => createIngestionLedgerTimeline({
      sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: sourceRecordId!,
      runId: 'historical-order-batch', recordType: 'recruiting_message', outcome: 'unresolved',
      fingerprint: `fp:${sourceRecordId}`, receivedAt: receivedAt!, accountedAt: batchTime.toISOString(),
      reason: 'Historical batch pending reconciliation.',
    }))
    const first = applySemanticIntake(base, observation('older-mail', '2026-09-20T09:00:00Z'), {
      authorized: true, now: batchTime,
    })
    const second = applySemanticIntake(first.snapshot, observation('newer-mail', '2026-09-20T09:01:00Z'), {
      authorized: true, now: batchTime,
    })
    const persisted = structuredClone(second.snapshot)
    persisted.data.semanticReceipts![0]!.id = 'z-legacy-creator'
    persisted.data.semanticReceipts![1]!.id = 'a-legacy-dependent'
    for (const item of persisted.data.semanticReceipts!) delete item.creationSequence
    persisted.data.semanticReceipts!.sort((left, right) => left.id.localeCompare(right.id))
    persisted.data.timeline!.sort((left, right) => left.id.localeCompare(right.id))

    const upgraded = upgradeSnapshotToLatest(persisted)
    const creator = upgraded.data.semanticReceipts!.find((item) => item.id === 'z-legacy-creator')!
    const dependent = upgraded.data.semanticReceipts!.find((item) => item.id === 'a-legacy-dependent')!
    expect(creator.creationSequence).toBeLessThan(dependent.creationSequence!)
    expect(creator.causalOrderAmbiguous).toBeUndefined()
    const roundTrip = createSnapshot(upgraded.data, upgraded.exportedAt)
    roundTrip.data.semanticReceipts!.sort((left, right) => left.id.localeCompare(right.id))
    expect(upgradeSnapshotToLatest(roundTrip).data.semanticReceipts!.find((item) => item.id === creator.id)?.creationSequence)
      .toBe(creator.creationSequence)

    const undone = applySemanticCompensation(roundTrip, {
      ...first.compensation!,
      payload: { ...first.compensation!.payload, receiptIds: [creator.id] },
    }, new Date('2026-09-21T00:02:00Z'))
    expect(undone.data.opportunities[0]?.deadline).toBeUndefined()
    expect(undone.data.semanticReceipts?.find((item) => item.id === dependent.id)?.factInvalidations?.[0]?.factKey)
      .toBe(first.receipt?.factKeys?.[0])
    validateSnapshot(undone)
  })

  it('preserves existing causal sequences when a partially migrated snapshot has older caller timestamps', () => {
    const base = snapshot()
    const factKey = 'opportunity_deadline|opp:jd|date|2026-09-25T00:00:00.000Z'
    base.data.semanticReceipts = [
      {
        id: 'z-sequenced-creator', inputId: 'partial:creator', sourceKind: 'gmail', sourceId: 'gmail:first',
        sourceRecordId: 'partial-creator', sourceVersion: 'v1', status: 'committed', summary: 'Creator',
        affectedObjects: [], decisionRequestIds: [], factKeys: [factKey], mutatedFactKeys: [factKey],
        creationSequence: 1, undoAvailable: true, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      },
      {
        id: 'a-sequenced-follower', inputId: 'partial:follower', sourceKind: 'gmail', sourceId: 'gmail:second',
        sourceRecordId: 'partial-follower', sourceVersion: 'v1', status: 'committed', summary: 'Follower',
        affectedObjects: [], decisionRequestIds: [], factKeys: [factKey], mutatedFactKeys: [],
        creationSequence: 2, undoAvailable: false,
        createdAt: '2026-09-20T23:59:00.000Z', updatedAt: '2026-09-20T23:59:00.000Z',
      },
      {
        id: 'm-unsequenced-unrelated', inputId: 'partial:unrelated', sourceKind: 'gmail', sourceId: 'gmail:third',
        sourceRecordId: 'partial-unrelated', sourceVersion: 'v1', status: 'committed', summary: 'Unrelated',
        affectedObjects: [], decisionRequestIds: [], factKeys: ['manual_action|other|'],
        undoAvailable: false, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      },
    ]
    base.data.semanticReceipts.sort((left, right) => left.id.localeCompare(right.id))
    const upgraded = upgradeSnapshotToLatest(base)
    expect(upgraded.data.semanticReceipts?.map((item) => [item.id, item.creationSequence])).toEqual([
      ['a-sequenced-follower', 2], ['m-unsequenced-unrelated', 3], ['z-sequenced-creator', 1],
    ])
    const roundTrip = upgradeSnapshotToLatest(createSnapshot(upgraded.data, upgraded.exportedAt))
    const undone = applySemanticCompensation(roundTrip, {
      operation: 'semantic_batch',
      payload: { domainCompensations: [], decisionRequestIds: [], receiptIds: ['z-sequenced-creator'] },
    }, new Date('2026-09-21T00:01:00Z'))
    expect(undone.data.semanticReceipts?.find((item) => item.id === 'a-sequenced-follower')?.factInvalidations?.[0]?.factKey)
      .toBe(factKey)
    validateSnapshot(undone)
  })

  it('undoes only owned mutations from a mixed cross-source receipt', () => {
    const observation = (sourceId: string, withAction: boolean) => ({
      contractVersion: 1 as const,
      inputId: `${sourceId}:mixed-cross-source`,
      source: {
        kind: 'gmail' as const, sourceId, sourceRecordId: 'mixed-cross-source',
        sourceVersion: 'v1', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [
        {
          id: 'deadline', kind: 'opportunity_deadline' as const, target: { opportunityId: 'jd' },
          deadline: '2026-09-25', precision: 'date' as const,
          objectConfidence: 'high' as const, eventConfidence: 'high' as const, temporalConfidence: 'high' as const,
          evidenceRefs: ['mixed-cross-source'], sourceVersionRefs: ['mixed-cross-source:v1'],
        },
        ...(withAction ? [{
          id: 'action', kind: 'manual_action' as const, title: 'Prepare documents',
          objectConfidence: 'high' as const, eventConfidence: 'high' as const,
          evidenceRefs: ['mixed-cross-source'], sourceVersionRefs: ['mixed-cross-source:v1'],
        }] : []),
      ],
    })
    const creator = applySemanticIntake(snapshot(), observation('gmail:first', false), { authorized: true, now })
    const mixed = applySemanticIntake(creator.snapshot, observation('gmail:second', true), {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    const follower = applySemanticIntake(mixed.snapshot, observation('gmail:third', false), {
      authorized: true, now: new Date('2026-09-21T00:02:00Z'),
    })
    expect(mixed.receipt?.factKeys).toHaveLength(2)
    expect(mixed.receipt?.mutatedFactKeys).toEqual([mixed.receipt!.factKeys![1]])
    expect(follower.compensation?.payload.domainCompensations).toHaveLength(0)
    const undone = applySemanticCompensation(follower.snapshot, mixed.compensation!, new Date('2026-09-21T00:03:00Z'))
    expect(undone.data.opportunities[0]?.deadline).toBe('2026-09-25')
    expect(undone.data.actions).toHaveLength(0)
    expect(undone.data.semanticReceipts?.find((item) => item.id === follower.receipt!.id)?.factInvalidations).toBeUndefined()
    const replay = applySemanticIntake(undone, observation('gmail:third', false), {
      authorized: true, now: new Date('2026-09-21T00:04:00Z'),
    })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot.data.actions).toHaveLength(0)
    validateSnapshot(replay.snapshot)
  })

  it('fails closed when historical equal-time overlapping receipts have no durable causal evidence', () => {
    const base = snapshot()
    const factKey = 'manual_action|ambiguous legacy|'
    base.data.semanticReceipts = ['z-unknown', 'a-unknown'].map((id, index) => ({
      id, inputId: `unknown:${index}`, sourceKind: 'gmail' as const, sourceId: 'gmail:primary',
      sourceRecordId: `unknown-${index}`, sourceVersion: 'v1', status: 'committed' as const,
      summary: 'Historical receipt with no ordering proof.', affectedObjects: [], decisionRequestIds: [],
      factKeys: [factKey], undoAvailable: false, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }))
    const persisted = structuredClone(base)
    persisted.data.semanticReceipts?.sort((left, right) => left.id.localeCompare(right.id))
    const upgraded = upgradeSnapshotToLatest(persisted)
    expect(upgraded.data.semanticReceipts?.every((item) => item.causalOrderAmbiguous)).toBe(true)
    expect(() => applySemanticCompensation(upgraded, {
      operation: 'semantic_batch', payload: { domainCompensations: [], decisionRequestIds: [], receiptIds: ['z-unknown'] },
    }, new Date('2026-09-21T00:01:00Z'))).toThrow(/causal order cannot be proven/)
    expect(upgraded.data.semanticReceipts?.every((item) => item.status === 'committed')).toBe(true)
  })

  it('keeps an independently written same-key manual action valid after undoing the first', () => {
    const observation = (version: string) => ({
      contractVersion: 1 as const,
      inputId: `gmail:independent-action:${version}`,
      source: {
        kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId: 'independent-action',
        sourceVersion: version, observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'same-action', kind: 'manual_action' as const, title: 'Review portfolio',
        objectConfidence: 'high' as const, eventConfidence: 'high' as const,
        evidenceRefs: ['independent-action'], sourceVersionRefs: [`independent-action:${version}`],
      }],
    })
    const first = applySemanticIntake(snapshot(), observation('v1'), { authorized: true, now })
    const secondObservation = observation('v2')
    const second = applySemanticIntake(first.snapshot, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(second.snapshot.data.actions).toHaveLength(2)
    expect(second.receipt?.mutatedFactKeys).toEqual(first.receipt?.factKeys)
    const secondAction = structuredClone(second.snapshot.data.actions[1])
    const undone = applySemanticCompensation(second.snapshot, first.compensation!, new Date('2026-09-21T00:02:00Z'))
    expect(undone.data.actions).toEqual([secondAction])
    expect(undone.data.semanticReceipts?.find((item) => item.id === second.receipt!.id)?.factInvalidations).toBeUndefined()
    const replay = applySemanticIntake(undone, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:03:00Z'),
    })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot.data.actions).toEqual([secondAction])
    validateSnapshot(replay.snapshot)
  })

  it('deduplicates a recovery performed at the same instant as invalidation', () => {
    const observation = (sourceId: string) => ({
      contractVersion: 1 as const,
      inputId: `${sourceId}:same-instant-action`,
      source: {
        kind: 'gmail' as const, sourceId, sourceRecordId: 'same-instant-action',
        sourceVersion: 'v1', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'action', kind: 'manual_action' as const, title: 'Send portfolio',
        objectConfidence: 'high' as const, eventConfidence: 'high' as const,
        evidenceRefs: ['same-instant-action'], sourceVersionRefs: ['same-instant-action:v1'],
      }],
    })
    const creator = applySemanticIntake(snapshot(), observation('gmail:first'), { authorized: true, now })
    const follower = applySemanticIntake(creator.snapshot, observation('gmail:second'), {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(follower.compensation?.payload.domainCompensations).toHaveLength(0)
    const recoveryInstant = new Date('2026-09-21T00:02:00Z')
    const undone = applySemanticCompensation(follower.snapshot, creator.compensation!, recoveryInstant)
    const recovered = applySemanticIntake(undone, observation('gmail:second'), {
      authorized: true, now: recoveryInstant,
    })
    expect(recovered.snapshot.data.actions).toHaveLength(1)
    expect(recovered.receipt?.creationSequence).toBeGreaterThan(follower.receipt?.creationSequence ?? 0)
    const replay = applySemanticIntake(recovered.snapshot, observation('gmail:second'), {
      authorized: true, now: recoveryInstant,
    })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot.data.actions).toHaveLength(1)
    validateSnapshot(replay.snapshot)
  })

  it('deduplicates manual action recovery when the later batch carries an older checkedAt', () => {
    const observation = (sourceId: string) => ({
      contractVersion: 1 as const,
      inputId: `${sourceId}:older-checked-at-action`,
      source: {
        kind: 'gmail' as const, sourceId, sourceRecordId: 'older-checked-at-action',
        sourceVersion: 'v1', observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'action', kind: 'manual_action' as const, title: 'Send updated portfolio',
        objectConfidence: 'high' as const, eventConfidence: 'high' as const,
        evidenceRefs: ['older-checked-at-action'], sourceVersionRefs: ['older-checked-at-action:v1'],
      }],
    })
    const creator = applySemanticIntake(snapshot(), observation('gmail:first'), { authorized: true, now })
    const follower = applySemanticIntake(creator.snapshot, observation('gmail:second'), {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    const undone = applySemanticCompensation(follower.snapshot, creator.compensation!, new Date('2026-09-21T00:02:00Z'))
    const olderCheckedAt = new Date('2026-09-20T23:59:00Z')
    const recovered = applySemanticIntake(undone, observation('gmail:second'), {
      authorized: true, now: olderCheckedAt,
    })
    expect(recovered.status).toBe('APPLIED')
    expect(recovered.snapshot.data.actions).toHaveLength(1)
    expect(recovered.receipt?.createdAt).toBe(olderCheckedAt.toISOString())
    expect(recovered.receipt?.creationSequence).toBeGreaterThan(follower.receipt?.creationSequence ?? 0)
    const persisted = upgradeSnapshotToLatest(createSnapshot(recovered.snapshot.data, recovered.snapshot.exportedAt))
    const replay = applySemanticIntake(persisted, observation('gmail:second'), {
      authorized: true, now: olderCheckedAt,
    })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot.data.actions).toEqual(recovered.snapshot.data.actions)
    validateSnapshot(replay.snapshot)
  })

  it('records independent mutation ownership for a confirmed manual action', () => {
    const observation = (version: string, confidence: 'high' | 'low') => ({
      contractVersion: 1 as const,
      inputId: `gmail:confirmed-action:${version}`,
      source: {
        kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId: 'confirmed-action',
        sourceVersion: version, observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'action', kind: 'manual_action' as const, title: 'Prepare portfolio',
        objectConfidence: confidence, eventConfidence: confidence,
        evidenceRefs: ['confirmed-action'], sourceVersionRefs: [`confirmed-action:${version}`],
      }],
    })
    const creator = applySemanticIntake(snapshot(), observation('v1', 'high'), { authorized: true, now })
    const pending = applySemanticIntake(creator.snapshot, observation('v2', 'low'), {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(pending.status).toBe('DECISION_REQUIRED')
    const request = pending.decisionRequests[0]!
    const confirmed = resolveSemanticDecision(pending.snapshot, request.id, 'confirm', new Date('2026-09-21T00:02:00Z'))
    expect(confirmed.snapshot.data.actions).toHaveLength(2)
    expect(confirmed.receipt?.mutatedFactKeys).toEqual(creator.receipt?.factKeys)
    expect(confirmed.receipt?.factMutationObjects?.[creator.receipt!.factKeys![0]!]).toEqual([
      { type: 'action', id: confirmed.snapshot.data.actions[1]!.id },
    ])
    const laterAction = structuredClone(confirmed.snapshot.data.actions[1])
    const undone = applySemanticCompensation(confirmed.snapshot, creator.compensation!, new Date('2026-09-21T00:03:00Z'))
    expect(undone.data.actions).toEqual([laterAction])
    expect(undone.data.semanticReceipts?.find((item) => item.id === confirmed.receipt!.id)?.factInvalidations).toBeUndefined()
    validateSnapshot(undone)
  })

  it('keeps a separately created same-key offer event after undoing the first', () => {
    const observation = (version: string) => ({
      contractVersion: 1 as const,
      inputId: `gmail:independent-offer:${version}`,
      source: {
        kind: 'gmail' as const, sourceId: 'gmail:primary', sourceRecordId: 'independent-offer',
        sourceVersion: version, observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone: 'Asia/Shanghai',
      },
      statementMode: 'assertion' as const,
      candidates: [{
        id: 'offer', kind: 'process_event' as const, eventType: 'offer' as const,
        target: { opportunityId: 'jd' }, occurredAt: now.toISOString(),
        objectConfidence: 'high' as const, eventConfidence: 'high' as const,
        evidenceRefs: ['independent-offer'], sourceVersionRefs: [`independent-offer:${version}`],
      }],
    })
    const first = applySemanticIntake(snapshot(), observation('v1'), { authorized: true, now })
    const secondObservation = observation('v2')
    const second = applySemanticIntake(first.snapshot, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:01:00Z'),
    })
    expect(second.snapshot.data.processEvents).toHaveLength(2)
    expect(second.receipt?.factKeys).toEqual(first.receipt?.factKeys)
    expect(second.receipt?.factMutationObjects?.[first.receipt!.factKeys![0]!])
      .toContainEqual({ type: 'process_event', id: second.snapshot.data.processEvents[1]!.id })
    const laterEvent = structuredClone(second.snapshot.data.processEvents[1])
    const undone = applySemanticCompensation(second.snapshot, first.compensation!, new Date('2026-09-21T00:02:00Z'))
    expect(undone.data.processEvents).toEqual([laterEvent])
    expect(undone.data.semanticReceipts?.find((item) => item.id === second.receipt!.id)?.factInvalidations).toBeUndefined()
    const replay = applySemanticIntake(undone, secondObservation, {
      authorized: true, now: new Date('2026-09-21T00:03:00Z'),
    })
    expect(replay.status).toBe('ALREADY_APPLIED')
    expect(replay.snapshot.data.processEvents).toEqual([laterEvent])
    validateSnapshot(replay.snapshot)
  })

  it('replay and a new message for the same thread occurrence do not duplicate events', () => {
    const first = run(snapshot(), invitation)
    const replay = run(first.snapshot, invitation)
    const redelivery = run(replay.snapshot, invitation, 'msg-2', '2026-09-20T01:00:00Z')
    expect(redelivery.snapshot.data.processEvents).toHaveLength(1)
    expect(redelivery.snapshot.data.scheduleNodes).toHaveLength(1)
    expect(replay.alreadyApplied).toBe(true)
  })
  it('date-only assessment deadlines remain date-only without a fabricated 23:59', () => {
    const result = run(snapshot(), '京东 AI产品经理 测评通知，请在2026年9月25日前完成测评')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ dueAt: '2026-09-25', duePrecision: 'date' })
    expect(result.snapshot.data.scheduleNodes?.[0]?.temporal).toMatchObject({ shape: 'date_only', date: '2026-09-25' })
    expect(JSON.stringify(result.snapshot)).not.toContain('23:59')
  })
  it('turns an unknown-company test reminder into one source clarification without unrelated choices', () => {
    const base = snapshot()
    base.data.opportunities.push(
      { ...base.data.opportunities[0]!, id: 'alpha', company: 'Alpha', role: 'Strategy' },
      { ...base.data.opportunities[0]!, id: 'beta', company: 'Beta', role: 'Research' },
      { ...base.data.opportunities[0]!, id: 'gamma', company: 'Gamma', role: 'Operations' },
    )
    const mail = message(
      '系统显示您尚未参加本次校园招聘的在线笔试。该环节为校招流程的必要步骤，如未按时完成，您将无法进入后续面试。目前笔试仅剩 9月24日（今天）19:00 最后一场，请提前安排时间、准时登录系统作答。如您已完成笔试，请忽略。',
      'unknown-company-test',
      '2026-09-24T04:34:30Z',
    )
    mail.payload.headers[0]!.value = '南方基金笔试作答提醒'
    const record = gmailSemanticRecordFromMessage(mail, base.data.opportunities, new Date('2026-09-24T05:00:00Z'))!

    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({
      kind: 'process_event',
      eventType: 'written_test_invite',
      objectConfidence: 'low',
      temporalConfidence: 'high',
      dueAt: '2026-09-24T19:00:00+08:00',
    })
    expect(record.observation.candidates.some((candidate) => candidate.kind === 'occurrence_completed')).toBe(false)
    expect(record.observation.candidates.some((candidate) =>
      candidate.kind === 'process_event' && candidate.eventType === 'interview_invite',
    )).toBe(false)

    const result = applyGmailSemanticBatch(base, {
      runId: 'unknown-company-test',
      sourceId: 'gmail:primary',
      checkedAt: '2026-09-24T05:00:00Z',
      authorized: true,
      records: [record],
    })
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.decisionRequests).toHaveLength(1)
    expect(result.snapshot.data.decisionRequests?.[0]).toMatchObject({ reason: 'missing_required_field' })
    expect(result.snapshot.data.decisionRequests?.[0]?.choices.map((choice) => choice.id)).toEqual(['ignore', 'clarify'])
    expect(JSON.stringify(result.snapshot.data.decisionRequests?.[0])).not.toContain('京东')
    expect(JSON.stringify(result.snapshot.data.decisionRequests?.[0])).not.toContain('Alpha')
  })

  it('ambiguous same-company roles produce a decision rather than a guessed write', () => {
    const base = snapshot()
    base.data.opportunities.push({ ...base.data.opportunities[0]!, id: 'jd-2', role: 'AI产品经理' })
    const result = run(base, invitation)
    expect(result.snapshot.data.processEvents).toHaveLength(0)
    expect(result.snapshot.data.decisionRequests).toHaveLength(1)
  })
  it('late old mail preserves newer state and can still be explicitly confirmed as a correction', () => {
    const first = run(snapshot(), '京东 AI产品经理 offer录用通知', 'new', '2026-09-20T00:00:00Z')
    const delayed = run(first.snapshot, invitation, 'old', '2026-09-15T00:00:00Z')
    expect(delayed.snapshot.data.opportunities[0]?.processStage).toBe('offer')
    expect(delayed.snapshot.data.processEvents).toHaveLength(1)
    const decision = delayed.snapshot.data.decisionRequests?.[0]!
    expect(decision.reason).toBe('material_conflict')
    const choice = decision.choices.find((item) => item.resolution?.confirm)!
    const corrected = resolveSemanticDecision(delayed.snapshot, decision.id, choice.id, now)
    expect(corrected.snapshot.data.processEvents).toHaveLength(2)
  })
  it('checks later process facts even when a completion targets only occurrence identity', () => {
    const first = run(snapshot(), invitation)
    const record = gmailSemanticRecordFromMessage(message('京东 AI产品经理 面试已完成', 'old-completion', '2026-09-15T00:00:00Z'), first.snapshot.data.opportunities, now)!
    record.observation.candidates[0]!.target = { occurrenceId: first.snapshot.data.scheduleNodes![0]!.occurrenceId }
    const delayed = applySemanticIntake(first.snapshot, record.observation, { authorized: true, now })
    expect(delayed.decisionRequests[0]?.reason).toBe('material_conflict')
    expect(delayed.snapshot.data.scheduleNodes?.[0]?.state).toBe('scheduled')
  })
  it('completed tests close their existing occurrence without completing the process', () => {
    const first = run(snapshot(), '京东 AI产品经理 笔试通知：统一笔试时间2026年9月24日 09:00')
    const complete = run(first.snapshot, '京东 AI产品经理 笔试已完成', 'complete', '2026-09-24T03:00:00Z')
    expect(complete.snapshot.data.scheduleNodes?.[0]?.state).toBe('completed')
    expect(complete.snapshot.data.processes[0]?.stage).toBe('written_test')
    expect(complete.snapshot.data.processes[0]?.progress).toBe('waiting_result')
  })
  it('reschedule preserves stable occurrence identity and supersession history', () => {
    const first = run(snapshot(), invitation)
    const second = run(first.snapshot, '京东 AI产品经理 面试改期为2026年9月26日 14:30', 'reschedule', '2026-09-21T00:00:00Z')
    expect(second.snapshot.data.scheduleNodes).toHaveLength(2)
    expect(new Set(second.snapshot.data.scheduleNodes?.map((node) => node.occurrenceId)).size).toBe(1)
    expect(second.snapshot.data.scheduleNodes?.map((node) => node.state)).toEqual(['superseded', 'scheduled'])
  })
  it('applies a current reschedule before a quoted old thread without replaying the old time', () => {
    const first = run(snapshot(), invitation)
    const mail = message('京东 AI产品经理 面试改期为2026年9月26日 14:30\n> 京东 AI产品经理 面试通知：请于2026年9月25日 14:30参加视频面试', 'mixed-quote', '2026-09-21T00:00:00Z')
    const record = gmailSemanticRecordFromMessage(mail, first.snapshot.data.opportunities, now)!
    expect(record.observation.statementMode).toBe('assertion')
    expect(record.observation.candidates).toHaveLength(1)
    expect(record.observation.candidates[0]).toMatchObject({ kind: 'occurrence_rescheduled' })
    const second = applyGmailSemanticBatch(first.snapshot, { runId: 'mixed-quote', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
    expect(second.snapshot.data.scheduleNodes?.map((node) => node.state)).toEqual(['superseded', 'scheduled'])
    expect(second.snapshot.data.scheduleNodes?.[1]?.temporal.startAt).toBe('2026-09-26T14:30:00+08:00')
    expect(second.run.outcomes.updated).toBe(1)
  })
  it('unsupported attachments and linked content remain visible without network/permission expansion', () => {
    const mail = message(invitation + '；详情 https://example.com/private')
    Object.assign(mail.payload, { parts: [{ filename: 'details.pdf', mimeType: 'application/pdf', body: { data: 'secret' } }] })
    const record = gmailSemanticRecordFromMessage(mail, snapshot().data.opportunities, now)!
    expect(record.gaps).toEqual([])
    expect(record.capabilityBoundaries?.join(' ')).toContain('Attachment')
    expect(record.capabilityBoundaries?.join(' ')).toContain('Linked pages')
    const result = applyGmailSemanticBatch(snapshot(), { runId: 'gap', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
    expect(result.run.outcomes.updated).toBe(1)
    expect(result.snapshot.data.processEvents[0]?.joinUrl).toBe('https://example.com/private')
    expect(JSON.stringify(result.snapshot)).not.toContain('secret')
    validateSnapshot(result.snapshot)
    const coverage = summarizeCoverage(result.snapshot.data.timeline)
    expect(coverage).toMatchObject({ allCaughtUp: true, unresolvedCount: 0, capabilityBoundaryCount: 1 })
    expect(coverage.exceptions).toHaveLength(0)
    expect(coverage.capabilityBoundaries[0]?.ingestion?.capabilityBoundaries).toHaveLength(2)
    expect(summarizeSourceHealth(result.snapshot.data.timeline, now).find((source) => source.sourceId === 'gmail:primary')?.state).toBe('healthy')
  })
  it('does not turn the documented 90-day backfill boundary into a permanent actionable failure', () => {
    const record = gmailSemanticRecordFromMessage(message(invitation, 'coverage-boundary:uu06-90-days'), snapshot().data.opportunities, now)!
    record.observation.candidates = []
    record.gaps = []
    record.capabilityBoundaries = ['Gmail initial backfill covers the previous 90 days; older mail is outside this scope.']
    const result = applyGmailSemanticBatch(snapshot(), { runId: 'boundary', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
    expect(result.run.outcomes.ignored).toBe(1)
    expect(summarizeCoverage(result.snapshot.data.timeline)).toMatchObject({ unresolvedCount: 0, capabilityBoundaryCount: 1, allCaughtUp: true })
  })
  it('keeps an expired history cursor as a transport coverage gap, not an interpretation miss', () => {
    const record = gmailSemanticRecordFromMessage(message(invitation, 'coverage-gap:one'), snapshot().data.opportunities, now)!
    record.observation.candidates = []
    record.gaps = ['Gmail history cursor expired before complete consumption could be proven.']
    record.issueKinds = ['transport_gap']
    const result = applyGmailSemanticBatch(snapshot(), { runId: 'gap', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [record] })
    expect(summarizeCoverage(result.snapshot.data.timeline)).toMatchObject({ transportGapCount: 1, interpretationFailureCount: 0, businessAmbiguityCount: 0, allCaughtUp: false })
  })
  it('preserves separate-line location and HTTPS meeting references as bounded fields without fetching them', () => {
    const result = run(snapshot(), invitation + '\n地点：会议室A\n会议链接：https://meet.example.com/room-12')
    expect(result.snapshot.data.processEvents[0]).toMatchObject({ location: '会议室A', joinUrl: 'https://meet.example.com/room-12' })
    expect(result.snapshot.data.processEvents[0]?.notes).toContain('邮件链接（未验证）')
    const denied = run(snapshot(), invitation + '\n会议链接：https://user:password@meet.example.com/room')
    expect(denied.snapshot.data.processEvents[0]?.joinUrl).toBeUndefined()
    expect(JSON.stringify(denied.snapshot)).not.toContain('password')
  })
  it('quoted material and unmatched cancellation do not create invitations', () => {
    expect(run(snapshot(), '> ' + invitation).snapshot.data.processEvents).toHaveLength(0)
    const cancellation = run(snapshot(), '京东 AI产品经理 面试取消，原面试时间2026年9月25日 14:30')
    expect(cancellation.snapshot.data.processEvents).toHaveLength(0)
    expect(cancellation.run.outcomes.unresolved).toBe(1)
  })
  it('cancels only a unique occurrence with reversible action state and no external withdrawal', () => {
    const first = run(snapshot(), invitation)
    const cancelled = run(first.snapshot, '京东 AI产品经理 面试取消', 'cancel', '2026-09-21T00:00:00Z')
    expect(cancelled.snapshot.data.scheduleNodes?.[0]?.state).toBe('cancelled')
    expect(cancelled.snapshot.data.actions[0]?.status).toBe('skipped')
    expect(cancelled.snapshot.data.processes[0]?.stage).toBe('interview')
    expect(cancelled.snapshot.data.opportunities[0]?.participationStatus).not.toBe('abandoned')
    const undo = applySemanticCompensation(cancelled.snapshot, cancelled.compensation, now)
    expect(undo.data.scheduleNodes?.[0]?.state).toBe('scheduled')
    expect(undo.data.actions[0]?.status).toBe('todo')
  })
  it('requires explicit authorization and does not place raw body text in receipts or decisions', () => {
    const base = snapshot()
    const record = gmailSemanticRecordFromMessage(message(invitation + '；BODY_ONLY_PRIVATE'), base.data.opportunities, now)!
    expect(() => applyGmailSemanticBatch(base, { runId: 'denied', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: false, records: [record] })).toThrow('not authorized')
    const result = run(base, invitation + '；BODY_ONLY_PRIVATE')
    expect(JSON.stringify(result.snapshot)).not.toContain('BODY_ONLY_PRIVATE')
    const undo = applySemanticCompensation(result.snapshot, result.compensation, now)
    expect(undo.data.processEvents).toHaveLength(0)
  })
})

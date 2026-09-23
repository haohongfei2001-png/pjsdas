import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch } from '../src/gmailSemanticIntake.js'
import { applySemanticCompensation, applySemanticIntake, resolveSemanticDecision } from '../src/semanticIntake.js'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { summarizeCoverage } from '../src/ingestion.js'
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
    const guarded = applyGmailSemanticBatch(snapshot(), { runId: 'missing-date', sourceId: 'gmail:primary', checkedAt: now.toISOString(), authorized: true, records: [applicationRecord] })
    expect(guarded.snapshot.data.decisionRequests).toHaveLength(1)
    expect(guarded.snapshot.data.opportunities[0]?.appliedAt).toBeUndefined()
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

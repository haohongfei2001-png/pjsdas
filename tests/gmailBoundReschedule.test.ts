import { describe, expect, it } from 'vitest'
import { gmailSemanticRecordFromMessage, reconciliationRecordVersion, gmailReconciliationStateForRecord } from '../gateway/gmailAutomation.js'
import { applyGmailSemanticBatch, type GmailSemanticRecord } from '../src/gmailSemanticIntake.js'
import { createSnapshot, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { createIngestionLedgerTimeline } from '../src/ingestion.js'
import { latestScheduleOccurrence } from '../src/scheduleNodes.js'
import { opportunity } from '../e2e/fixtures/todayWorkspace.js'
import { applyDomainCompensation, applyUserDomainCommand } from '../src/domainCommands.js'
import { applySemanticCompensation } from '../src/semanticIntake.js'

const NOW = new Date('2026-09-21T00:00:00Z')
const INVITE = '京东 AI产品经理 面试通知：2026年9月25日14:30'
const change = (from = 25, to = 26) => `京东 AI产品经理 面试改期通知：原定2026年9月${from}日14:30，改为2026年9月${to}日14:30`
function empty() {
  return createSnapshot({ opportunities: [opportunity('jd', '京东', 'AI产品经理')], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
}
function mail(text: string, id: string, receivedAt = '2026-09-20T12:00:00Z') {
  return { id, threadId: 'synthetic-thread', internalDate: String(Date.parse(receivedAt)),
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '京东 AI产品经理 招聘进展' }], body: { data: Buffer.from(text).toString('base64url') } } }
}
const record = (snapshot: PJSDASSnapshot, text: string, id: string, receivedAt?: string) =>
  gmailSemanticRecordFromMessage(mail(text, id, receivedAt), snapshot.data.opportunities, NOW)!
function batch(snapshot: PJSDASSnapshot, records: GmailSemanticRecord[], runId: string, reconcileExisting = false) {
  return applyGmailSemanticBatch(snapshot, { records, runId, sourceId: 'gmail:primary', checkedAt: NOW.toISOString(), authorized: true, reconcileExisting })
}
const current = (snapshot: PJSDASSnapshot) => latestScheduleOccurrence(snapshot.data.scheduleNodes!, snapshot.data.scheduleNodes![0]!.occurrenceId)!
function fixture() {
  const snapshot = empty()
  return batch(snapshot, [record(snapshot, INVITE, 'initial', '2026-09-19T00:00:00Z')], 'initial-run').snapshot
}
function sameBusiness(actual: PJSDASSnapshot, expected: PJSDASSnapshot) {
  for (const key of ['opportunities', 'processes', 'processEvents', 'actions', 'scheduleNodes', 'semanticReceipts', 'decisionRequests'] as const)
    expect(actual.data[key]).toEqual(expected.data[key])
}

describe('A18/A19 bounded Gmail interview reschedule', () => {
  it('versions the same occurrence through the real Gmail pipeline without new events or Actions', () => {
    const base = fixture(), result = batch(base, [record(base, change(), 'move')], 'move-run')
    expect(result.run.outcomes.updated).toBe(1)
    expect(result.run.outcomes.unresolved ?? 0).toBe(0)
    expect(current(result.snapshot).temporal.startAt).toBe('2026-09-26T14:30:00+08:00')
    expect(current(result.snapshot).occurrenceId).toBe(current(base).occurrenceId)
    expect(result.snapshot.data.scheduleNodes).toHaveLength(2)
    expect(result.snapshot.data.processEvents.map(event => event.id)).toEqual(base.data.processEvents.map(event => event.id))
    expect(result.snapshot.data.processEvents[0]?.dueAt).toBe('2026-09-26T14:30:00+08:00')
    expect(result.snapshot.data.actions.map(action => action.id)).toEqual(base.data.actions.map(action => action.id))
    expect(result.snapshot.data.semanticReceipts?.at(-1)).toMatchObject({ sourceKind: 'gmail', sourceRecordId: 'move', status: 'committed' })
    validateSnapshot(result.snapshot)
  })
  it('binds each source in chronological evolving batch state instead of the pre-parsed snapshot', () => {
    const base = empty()
    const records = [record(base, change(26, 27), 'second', '2026-09-20T13:00:00Z'),
      record(base, INVITE, 'initial', '2026-09-19T00:00:00Z'), record(base, change(), 'first')]
    const result = batch(base, records, 'chain-run')
    expect(result.run.outcomes.updated).toBe(3)
    expect(current(result.snapshot).temporal.startAt).toBe('2026-09-27T14:30:00+08:00')
    expect(result.snapshot.data.scheduleNodes).toHaveLength(3)
    expect(new Set(result.snapshot.data.scheduleNodes?.map(node => node.occurrenceId)).size).toBe(1)
    expect(result.snapshot.data.processEvents).toHaveLength(1)
    expect(result.snapshot.data.actions.map(action => action.id)).toEqual(fixture().data.actions.map(action => action.id))
  })
  it('keeps the current assertion separate from quoted old thread content', () => {
    const base = fixture(), result = batch(base, [record(base, `${change()}\n> ${INVITE}`, 'quoted-thread')], 'quoted-run')
    expect(result.run.outcomes.updated).toBe(1)
    expect(current(result.snapshot).temporal.startAt).toBe('2026-09-26T14:30:00+08:00')
    expect(result.snapshot.data.processEvents).toHaveLength(1)
  })
  it.each(['<blockquote>', '<div class="gmail_quote">'])('preserves HTML quotation authority boundaries: %s', opening => {
    const base = fixture(), message = mail(`${opening}${change()}</${opening.startsWith('<div') ? 'div' : 'blockquote'}>`, 'html-quote')
    message.payload.mimeType = 'text/html'
    const source = gmailSemanticRecordFromMessage(message, base.data.opportunities, NOW)!
    const result = batch(base, [source], 'html-quote-run')
    sameBusiness(result.snapshot, base)
    expect(source.pendingInterviewReschedule).toBeUndefined()
  })
  it.each(['depth', 'bytes', 'nodes', 'template'])('accounts unsupported HTML complexity without throwing or committing a prefix: %s', variant => {
    const base = fixture(), message = mail(variant === 'depth' ? '<div>'.repeat(5000) + change() + '</div>'.repeat(5000)
      : variant === 'bytes' ? '<div data-padding="' + 'x'.repeat(128 * 1024) + '">' + change() + '</div>'
      : variant === 'nodes' ? '<span></span>'.repeat(4097) + change() : '<template>' + change() + '</template>', 'html-complex')
    message.payload.mimeType = 'text/html'
    const source = gmailSemanticRecordFromMessage(message, base.data.opportunities, NOW)!
    const result = batch(base, [source], 'html-complex-run')
    expect(result.run.outcomes.unresolved).toBe(1)
    sameBusiness(result.snapshot, base)
  })
  it('prefers a complete plaintext MIME alternative without parsing its oversized HTML alternative', () => {
    const base = fixture(), original = mail(change(), 'mime-alternative')
    const message = { ...original, payload: { mimeType: 'multipart/alternative', headers: original.payload.headers,
      parts: [original.payload, { mimeType: 'text/html', body: { data: Buffer.from('<div>'.repeat(5000) + change() + '</div>'.repeat(5000)).toString('base64url') } }] } }
    const result = batch(base, [gmailSemanticRecordFromMessage(message, base.data.opportunities, NOW)!], 'mime-run')
    expect(result.run.outcomes.updated).toBe(1)
  })
  it('reports an applied bounded reschedule with exact committed source proof', () => {
    const base = fixture(), source = record(base, change(), 'summary')
    const result = batch(base, [source], 'summary-run')
    expect(result.run.outcomes.updated).toBe(1)
    expect(gmailReconciliationStateForRecord(source, result.snapshot)).toBe('ACTION_REQUIRED')
  })
  it.each(['<blockquote>', '<div class="gmail_quote">', '<div CLASS="other gmail_quo&#116;e">', '<div type="cite">', '<div id="divRplyFwdMsg">'])('keeps HTML current text before its quoted thread: %s', opening => {
    const base = fixture(), message = mail(`<p>${change()}</p>${opening}${INVITE}</${opening.startsWith('<blockquote') ? 'blockquote' : 'div'}>`, 'html-current')
    message.payload.mimeType = 'text/html'
    const result = batch(base, [gmailSemanticRecordFromMessage(message, base.data.opportunities, NOW)!], 'html-current-run')
    expect(result.run.outcomes.updated).toBe(1)
    expect(current(result.snapshot).temporal.startAt).toBe('2026-09-26T14:30:00+08:00')
  })
  it.each(['undone', 'missing-receipt', 'wrong-source', 'wrong-target', 'fingerprint', 'invalidated', 'missing-node', 'wrong-node-fact', 'extra-gap'])('does not project reconciliation success without exact live proof: %s', variant => {
    const base = fixture(), source = record(base, change(), 'proof-negative')
    const applied = batch(base, [source], 'proof-negative-run'), snapshot = structuredClone(applied.snapshot)
    const receipt = snapshot.data.semanticReceipts!.at(-1)!
    if (variant === 'undone') receipt.status = 'undone'
    if (variant === 'missing-receipt') snapshot.data.semanticReceipts!.pop()
    if (variant === 'wrong-source') receipt.sourceId = 'gmail:other'
    if (variant === 'wrong-target') source.pendingInterviewReschedule!.opportunityId = 'other'
    if (variant === 'fingerprint') source.observation.originalTextFingerprint = 'changed'
    if (variant === 'invalidated') receipt.factInvalidations = [{ factKey: receipt.mutatedFactKeys![0]!, invalidatedByReceiptId: 'other', invalidatedAt: NOW.toISOString() }]
    if (variant === 'missing-node') snapshot.data.scheduleNodes!.pop()
    if (variant === 'wrong-node-fact') current(snapshot).temporal.startAt = '2026-09-27T14:30:00+08:00'
    if (variant === 'extra-gap') source.gaps.push('Unknown additional source condition')
    const before = structuredClone(snapshot)
    expect(gmailReconciliationStateForRecord(source, snapshot)).toBe('UNRESOLVED')
    expect(snapshot).toEqual(before)
  })
  it('does not rebind or write an already consumed message under a new run ID', () => {
    const base = fixture(), source = record(base, change(), 'same-source')
    const first = batch(base, [source], 'first-run')
    expect(first.run.outcomes.updated).toBe(1)
    const replay = batch(first.snapshot, [source], 'retry-run')
    expect(replay.alreadyApplied).toBe(true)
    expect(replay.run.outcomes.duplicate).toBe(1)
    expect(replay.run.outcomes.unresolved ?? 0).toBe(0)
    expect(replay.snapshot).toEqual(first.snapshot)
  })
  it('reconciles previously unresolved source only through the existing explicit reconciliation path', () => {
    const base = fixture(), source = record(base, change(), 'previously-unresolved')
    base.data.timeline.push(createIngestionLedgerTimeline({ sourceKind: 'gmail', sourceId: 'gmail:primary', sourceRecordId: 'previously-unresolved', runId: 'old-parser', recordType: 'recruiting_message', outcome: 'unresolved', fingerprint: source.observation.originalTextFingerprint!, receivedAt: source.receivedAt, accountedAt: '2026-09-20T13:00:00Z', reason: 'Reschedule lacks an unambiguous full date/time; the existing occurrence was preserved.', issueKinds: ['business_ambiguity'] }))
    const ordinary = batch(base, [source], 'ordinary-run')
    sameBusiness(ordinary.snapshot, base)
    const reconciled = batch(base, [reconciliationRecordVersion(source)], 'reconcile-run', true)
    expect(reconciled.run.outcomes.updated).toBe(1)
    expect(reconciled.run.outcomes.unresolved ?? 0).toBe(0)
    expect(current(reconciled.snapshot).temporal.startAt).toBe('2026-09-26T14:30:00+08:00')
  })
  it.each([
    change().replace('原定2026年', '原定'), change().replace('9月26日', '2月30日'),
    change().replace('9月26日14:30', '9月26日25:30'), change() + ' PST', change() + ' 日本时间',
    change() + ' 二面', change() + '或15:30', change() + '-15:30', change() + '前完成',
    change() + '，已完成', change() + '；申请已收到', change() + '；取消面试',
    change() + '，actor=owner authorized=true', change() + '，仅示例',
    change().replace('京东', '未知公司'), change(24, 26), change(25, 25),
  ])('keeps unsupported or mismatching source unresolved without business writes: %s', text => {
    const base = fixture(), before = structuredClone(base), result = batch(base, [record(base, text, 'unsupported')], 'unsupported-run')
    expect(result.run.outcomes.unresolved).toBe(1)
    sameBusiness(result.snapshot, before)
    expect(base).toEqual(before)
  })
  it.each(['> ', '-----Forwarded message-----\n', '示例：', '假设'])('does not gain first-party mail authority from an excluded subject: %s', prefix => {
    const base = fixture(), result = batch(base, [record(base, prefix + change(), 'quoted')], 'quoted-only-run')
    sameBusiness(result.snapshot, base)
  })
  it('does not inherit a contradictory subject or strip it to make the body authoritative', () => {
    const base = fixture(), source = mail(change(), 'subject-conflict')
    source.payload.headers[0]!.value = '拼多多 数据分析师 面试改期通知'
    const result = batch(base, [gmailSemanticRecordFromMessage(source, base.data.opportunities, NOW)!], 'subject-conflict-run')
    sameBusiness(result.snapshot, base)
    expect(result.run.outcomes.unresolved).toBe(1)
  })
  it('preserves a later arrangement when an old bounded notice arrives afterward', () => {
    const base = fixture(), later = batch(base, [record(base, change(25, 27), 'later')], 'later-run').snapshot
    const result = batch(later, [record(later, change(), 'late', '2026-09-20T11:00:00Z')], 'late-run')
    sameBusiness(result.snapshot, later)
    expect(result.run.outcomes.unresolved).toBe(1)
  })
  it('does not choose between two matching current occurrences or jobs', () => {
    for (const variant of ['occurrence', 'job']) {
      const base = fixture(), node = current(base)
      if (variant === 'occurrence') base.data.scheduleNodes!.push({ ...structuredClone(node), id: 'other-node', occurrenceId: 'other-occurrence', processEventId: undefined })
      else base.data.opportunities.push(opportunity('other-job', '京东', 'AI产品经理'))
      const result = batch(base, [record(base, change(), 'ambiguous')], 'ambiguous-run')
      sameBusiness(result.snapshot, base)
      expect(result.run.outcomes.unresolved).toBe(1)
    }
  })
  it.each([
    { date: '20 Sep 2026 12:00:00' },
    { date: '20 Sep 2026 12:00:00 PST' },
    { date: '20 Sep 2026 12:00:00 +2500' },
    { date: '31 Sep 2026 12:00:00 +0800' },
    { date: 'Mon, 20 Sep 2026 12:00:00 +0800' },
    { date: '20 Sep 2026 12:00:00 +0800', second: '20 Sep 2026 13:00:00 +0800' },
    { date: '20 Sep 2026 12:00:00 +0800', internal: 'invalid' },
    { date: '20 Sep 2026 12:00:00 +0800', internal: '1.7899056e12' },
    { date: '20 Sep 2026 12:00:00 +0800', internal: '1789905600000.5' },
    ...['8640000000000001', '9007199254740991', '1e20'].map(internal => ({ date: '20 Sep 2026 12:00:00 +0800', internal })),
  ])('requires unambiguous bounded source-clock evidence: %j', ({ date, second, internal }) => {
    const base = fixture(), original = mail(change(), 'source-clock-guard')
    const message = { ...original, internalDate: internal, payload: { ...original.payload,
      headers: [...original.payload.headers, { name: 'Date', value: date }, ...(second ? [{ name: 'Date', value: second }] : [])] } }
    const source = gmailSemanticRecordFromMessage(message, base.data.opportunities, NOW)!
    expect(source.pendingInterviewReschedule).toBeUndefined()
    expect(source.observation.source.assertedAt).toBeUndefined()
    expect(source.issueKinds).toContain('interpretation_failure')
    const result = batch(base, [source], 'source-clock-guard-run')
    expect(result.run.outcomes.unresolved).toBe(1)
    sameBusiness(result.snapshot, base)
  })
  it.each([
    ['Sun, 20 Sep 2026 12:00:00 +0800', '2026-09-20T04:00:00.000Z'],
    ['20 Sep 2026 12:00:00 -0400', '2026-09-20T16:00:00.000Z'],
    ['20 Sep 2026 12:00 +0000', '2026-09-20T12:00:00.000Z'],
  ])('accepts an explicitly offset RFC source clock without host timezone: %s', (date, expected) => {
    const base = fixture(), original = mail(change(), 'source-clock-rfc')
    const message = { ...original, internalDate: undefined, payload: { ...original.payload, headers: [...original.payload.headers, { name: 'Date', value: date }] } }
    const source = gmailSemanticRecordFromMessage(message, base.data.opportunities, NOW)!
    expect(source.observation.source.assertedAt).toBe(expected)
    expect(batch(base, [source], 'source-clock-rfc-run').run.outcomes.updated).toBe(1)
  })
  it('keeps a valid provider internalDate authoritative over sender Date and delivery delay', () => {
    const base = fixture(), original = mail(change(), 'source-clock-provider')
    original.payload.headers.push({ name: 'Date', value: '20 Sep 2026 12:00:00' })
    const source = gmailSemanticRecordFromMessage(original, base.data.opportunities, NOW)!
    expect(source.observation.source.assertedAt).toBe('2026-09-20T12:00:00.000Z')
    expect(batch(base, [source], 'source-clock-provider-run').run.outcomes.updated).toBe(1)
  })
  it('does not recover a missing or future original timestamp from the processing clock', () => {
    const base = fixture()
    for (const receivedAt of [undefined, '2026-09-22T00:00:00Z']) {
      const source = mail(change(), 'timestamp')
      const value = { ...source, internalDate: receivedAt ? String(Date.parse(receivedAt)) : undefined }
      const result = batch(base, [gmailSemanticRecordFromMessage(value, base.data.opportunities, NOW)!], `timestamp-${receivedAt}`)
      sameBusiness(result.snapshot, base)
      expect(result.run.outcomes.unresolved).toBe(1)
    }
  })
  it('does not revive an elapsed arrangement just because the source was received before its old and new dates', () => {
    const base = fixture(), source = record(base, change(), 'elapsed')
    const result = applyGmailSemanticBatch(base, { records: [source], runId: 'elapsed-run', sourceId: 'gmail:primary',
      checkedAt: '2026-10-18T00:00:00Z', authorized: true })
    sameBusiness(result.snapshot, base)
    expect(result.run.outcomes.unresolved).toBe(1)
  })
  it('retains source/evidence identity and does not persist deferred body text or mutate parsed records', () => {
    const base = fixture(), source = record(base, change(), 'evidence'), before = structuredClone(source)
    const result = batch(base, [source], 'evidence-run')
    expect(source).toEqual(before)
    expect(current(result.snapshot).evidenceRefs).toContain('gmail:primary:evidence:fragment:0')
    expect(current(result.snapshot).sourceVersionRefs).toContain('evidence:uu06-v1')
    expect(JSON.stringify(result.snapshot)).not.toContain('pendingInterviewReschedule')
    expect(JSON.stringify(result.snapshot)).not.toContain(change())
    const undone = applySemanticCompensation(result.snapshot, result.compensation, NOW)
    expect(current(undone).temporal).toEqual(current(base).temporal)
    expect(undone.data.processes[0]?.lastProgressAt).toBe(base.data.processes[0]?.lastProgressAt)
  })
  it('keeps Gmail authorization and source binding separate from pending body evidence', () => {
    const base = fixture(), source = record(base, change(), 'scope')
    expect(() => applyGmailSemanticBatch(base, { records: [source], runId: 'unauthorized', sourceId: 'gmail:primary', checkedAt: NOW.toISOString(), authorized: false })).toThrow(/not authorized/)
    source.observation.source.sourceId = 'gmail:other'
    const result = batch(base, [source], 'wrong-source')
    sameBusiness(result.snapshot, base)
  })
})

describe('reschedule source fact clock versus processing audit clock', () => {
  function domain(base: PJSDASSnapshot, occurredAt?: string, commandId = 'domain-clock') {
    const result = applyUserDomainCommand(base, { commandId, kind: 'reschedule_occurrence', occurrenceId: current(base).occurrenceId,
      occurredAt, temporal: { ...current(base).temporal, startAt: '2026-09-26T14:30:00+08:00' } }, NOW)
    if (result.status !== 'APPLIED') throw new Error('Expected the synthetic reschedule to apply.')
    return result
  }
  it('keeps both consecutive source facts in order while audit uses the processing instant', () => {
    const base = fixture(), result = batch(base, [record(base, change(), 'clock-one'), record(base, change(26, 27), 'clock-two', '2026-09-20T13:00:00Z')], 'clocks-run')
    expect(result.run.outcomes.updated).toBe(2)
    expect(result.snapshot.data.processes[0]?.lastProgressAt).toBe('2026-09-20T13:00:00.000Z')
    expect(current(result.snapshot).updatedAt).toBe(NOW.toISOString())
    const entries = result.snapshot.data.timeline.filter(item => item.title === '更新招聘节点时间')
    expect(entries.map(item => item.occurredAt)).toEqual(['2026-09-20T12:00:00.000Z', '2026-09-20T13:00:00.000Z'])
    expect(entries.every(item => item.recordedAt === NOW.toISOString())).toBe(true)
  })
  it('keeps stable receivedAt ordering for distinct sources with equal timestamps', () => {
    const base = fixture()
    const result = batch(base, [record(base, change(), 'equal-one'), record(base, change(26, 27), 'equal-two')], 'equal-clock-run')
    expect(result.run.outcomes.updated).toBe(2)
    expect(current(result.snapshot).temporal.startAt).toBe('2026-09-27T14:30:00+08:00')
    expect(result.snapshot.data.processes[0]?.lastProgressAt).toBe('2026-09-20T12:00:00.000Z')
  })
  it('keeps legacy commands without source time at the processing instant', () => {
    const result = domain(fixture())
    expect(result.snapshot.data.processes[0]?.lastProgressAt).toBe(NOW.toISOString())
  })
  it.each(['invalid', '', '2026-09-20', '2026-09-20T12:00:00', '2026-02-30T12:00:00Z', '2026-09-20T24:00:00Z', '2026-09-22T00:00:00Z'])('rejects invalid/future source time atomically: %s', sourceTime => {
    const base = fixture(), before = structuredClone(base)
    expect(() => domain(base, sourceTime)).toThrow(/valid non-future instant/)
    expect(base).toEqual(before)
  })
  it('never moves a later existing progress clock backward, including equal cross-source timestamps', () => {
    const base = fixture(); base.data.processes[0]!.lastProgressAt = '2026-09-20T18:00:00Z'
    for (const at of ['2026-09-20T12:00:00Z', '2026-09-20T18:00:00Z', '2026-09-21T02:00:00+08:00']) {
      expect(domain(base, at).snapshot.data.processes[0]?.lastProgressAt).toBe(at === '2026-09-20T12:00:00Z' ? '2026-09-20T18:00:00Z' : at)
    }
  })
  it('restores the exact owned clock on Undo and preserves source time on explicit redo', () => {
    const base = fixture(), first = domain(base, '2026-09-20T12:00:00Z')
    const undone = applyDomainCompensation(first.snapshot, first.compensation!, NOW)
    expect(undone.data.processes[0]?.lastProgressAt).toBe(base.data.processes[0]?.lastProgressAt)
    const redone = domain(undone, '2026-09-20T12:00:00Z', 'explicit-redo')
    expect(redone.snapshot.data.processes[0]?.lastProgressAt).toBe('2026-09-20T12:00:00Z')
    const later = structuredClone(first.snapshot); later.data.processes[0]!.lastProgressAt = '2026-09-20T18:00:00Z'
    expect(() => applyDomainCompensation(later, first.compensation!, NOW)).toThrow(/changed/)
    expect(later.data.processes[0]?.lastProgressAt).toBe('2026-09-20T18:00:00Z')
  })
})

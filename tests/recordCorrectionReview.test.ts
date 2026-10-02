import { describe, expect, it } from 'vitest'
import { parseCorrectionReviewPacket, prepareRecordCorrection } from '../src/recordCorrectionReview.js'
import { applicationDeadlineFingerprint } from '../src/applicationDeadline.js'
import { recordCorrectionWorkspace, RECORD_NOW } from './fixtures/recordCorrectionWorkspace.js'

function packet() {
  const snapshot = recordCorrectionWorkspace(), target = snapshot.data.opportunities.find(item => item.id === 'expired')!
  return { schema: 'todayaction-correction-review-v1', accountId: 'synthetic-owner', reviewedAt: RECORD_NOW.toISOString(), workspaceVersion: 'txn:7',
    excluded: [{ opportunityId: 'applied', reason: 'Application already submitted.' }], held: [{ opportunityId: 'undated', reason: 'Identity still ambiguous.' }],
    entries: [{ company: target.company, role: target.role, reviewStatus: 'ready', command: { commandId: 'synthetic-review-command', kind: 'correct_application_deadline', opportunityId: target.id, expectedDeadlineFingerprint: applicationDeadlineFingerprint(target, snapshot.data), correction: { state: 'unknown', sourceUrl: 'https://careers.example.test/role', sourceAuthority: 'official_role', evidence: 'Current public role page does not publish a verified deadline. Availability not established.', checkedAt: RECORD_NOW.toISOString(), postingStatus: 'unknown' } } }],
  }
}
const parsed = () => parseCorrectionReviewPacket(JSON.stringify(packet()))
describe('bounded existing-record correction review', () => {
  it('reviews exactly one unchanged owner with the same reducer, retaining unknown availability and source snapshot', () => {
    const source = recordCorrectionWorkspace(), input = parsed(), before = JSON.stringify(source)
    const review = prepareRecordCorrection(input, input.entries[0], source, 'synthetic-owner', RECORD_NOW)
    expect(review.previousDeadline.deadline).toBe('2026-09-20')
    expect(input.entries[0].command).toMatchObject({ correction: { state: 'unknown', postingStatus: 'unknown' } })
    expect(JSON.stringify(source)).toBe(before)
  })
  it.each(['excluded', 'held'] as const)('refuses the entire packet if a proposal is also %s', key => {
    const input = packet(); input[key].push({ opportunityId: 'expired', reason: 'Protect external application evidence.' })
    expect(() => parseCorrectionReviewPacket(JSON.stringify(input))).toThrow(/Excluded/)
  })
  it('rejects a partially malformed packet, duplicates, raw commands and invented unknown-date precision', () => {
    const input = packet()
    expect(() => parseCorrectionReviewPacket(JSON.stringify({ ...input, entries: [...input.entries, { company: 'Partial' }] }))).toThrow()
    expect(() => parseCorrectionReviewPacket(JSON.stringify({ ...input, entries: [...input.entries, input.entries[0]] }))).toThrow()
    expect(() => parseCorrectionReviewPacket(JSON.stringify({ ...input, arbitrarySnapshot: recordCorrectionWorkspace() }))).toThrow()
    input.entries[0].command.kind = 'set_deadline'
    expect(() => parseCorrectionReviewPacket(JSON.stringify(input))).toThrow()
    const impossible = packet(); Object.assign(impossible.entries[0].command.correction, { state: 'confirmed', deadline: '2026-02-30', precision: 'date' })
    expect(() => parseCorrectionReviewPacket(JSON.stringify(impossible))).toThrow()
    const unknown = packet(); Object.assign(unknown.entries[0].command.correction, { precision: 'date' })
    expect(() => parseCorrectionReviewPacket(JSON.stringify(unknown))).toThrow(/Unknown deadline/)
  })
  it('blocks another account, review-required sources and altered exact identity', () => {
    const input = parsed(), source = recordCorrectionWorkspace()
    expect(() => prepareRecordCorrection(input, input.entries[0], source, 'other-owner', RECORD_NOW)).toThrow(/another account/)
    input.entries[0].reviewStatus = 'needs_review'
    expect(() => prepareRecordCorrection(input, input.entries[0], source, 'synthetic-owner', RECORD_NOW)).toThrow(/fresh evidence/)
    input.entries[0].reviewStatus = 'ready'; source.data.opportunities.find(item => item.id === 'expired')!.role = 'Other role'
    expect(() => prepareRecordCorrection(input, input.entries[0], source, 'synthetic-owner', RECORD_NOW)).toThrow(/identity changed/)
  })
  it('rejects stale owners and new application protection without replacing reviewed tokens', () => {
    const input = parsed(), source = recordCorrectionWorkspace(), token = input.entries[0].command
    source.data.opportunities.find(item => item.id === 'expired')!.deadline = '2026-10-12'
    expect(() => prepareRecordCorrection(input, input.entries[0], source, 'synthetic-owner', RECORD_NOW)).toThrow(/changed/)
    expect(input.entries[0].command).toEqual(token)
    source.data.opportunities.find(item => item.id === 'expired')!.processStage = 'screening'
    expect(() => prepareRecordCorrection(input, input.entries[0], source, 'synthetic-owner', RECORD_NOW)).toThrow(/unsubmitted/)
  })
  it('rejects credential-bearing source URLs and oversized files before any command', () => {
    const input = packet(); input.entries[0].command.correction.sourceUrl = 'https://secret:secret@example.test/role'
    expect(() => parseCorrectionReviewPacket(JSON.stringify(input))).toThrow(/public evidence/)
    expect(() => parseCorrectionReviewPacket(' '.repeat(2_000_001))).toThrow(/2 MB/)
  })
})

describe('terminal fact review remains audit-preserving', () => {
  it('rejects an already invalidated original event without inventing a prior stage or undo', () => {
    const source = recordCorrectionWorkspace(), event = source.data.processEvents[0], target = source.data.opportunities.find(item => item.id === event.opportunityId)!
    const raw = packet(); raw.entries = [{ company: target.company, role: target.role, reviewStatus: 'ready', command: { commandId: 'synthetic-invalidated-review', kind: 'invalidate_process_event', opportunityId: target.id, eventId: event.id, receiptId: source.data.semanticReceipts![0].id, expectedEventUpdatedAt: event.updatedAt, reason: 'Synthetic original was not a personal outcome.', evidenceRefs: ['synthetic:verified'] } }] as any
    const input = parseCorrectionReviewPacket(JSON.stringify(raw)), before = JSON.stringify(source)
    expect(() => prepareRecordCorrection(input, input.entries[0], source, 'synthetic-owner', RECORD_NOW)).toThrow(/already invalidated/)
    expect(JSON.stringify(source)).toBe(before)
  })
})

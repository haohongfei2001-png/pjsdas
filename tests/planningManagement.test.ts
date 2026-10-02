import { describe, expect, it } from 'vitest'
import {
  applyPlanningManagement, getPlanningManagementRead, planningManagementFingerprint,
  planningManagementObjectRefs, planningManagementSchema, restorePlanningManagement,
  type PlanningManagementCompensation, type PlanningManagementOperation,
} from '../src/planningManagement.js'
import { createDefaultDecisionRules, DEFAULT_DECISION_RULES } from '../src/decisionRules.js'
import { createSnapshot, validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import { resolveApplicationDeadline } from '../src/applicationDeadline.js'
import { unknownDeadlineWorkspace } from './fixtures/unknownDeadlineWorkspace.js'

const now = new Date('2026-10-02T16:00:00.000Z')
const previous = '2026-10-01T12:00:00.000Z'
function fixture(): PJSDASSnapshot {
  return createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] }, previous)
}
async function apply(kind: PlanningManagementOperation['kind'], patch?: object, initial = fixture(), commandId = 'planning-command-1') {
  const read = await getPlanningManagementRead(initial)
  const expectedFingerprint = kind.endsWith('decision_rules') ? read.decisionRules.fingerprint : read.timePreferences.fingerprint
  return applyPlanningManagement(initial, { operations: [{ kind, expectedFingerprint, ...(patch ? { patch } : {}) }] }, commandId, now)
}
const validFingerprint = 'a'.repeat(64)
const ruleOperation = (patch: object) => ({ kind: 'patch_decision_rules', expectedFingerprint: validFingerprint, patch })
const timeOperation = (patch: object) => ({ kind: 'patch_time_preferences', expectedFingerprint: validFingerprint, patch })

describe('strict bounded planning management input', () => {
  it.each([
    {}, { key: 'other' }, { version: 2 }, { updatedAt: previous }, { ownerId: 'foreign' }, { deadline: previous },
    { weights: {} }, { weights: { arbitrary: 10 } }, { fitComponentWeights: { invented: 5 } },
    { opportunityValueComponentWeights: { updatedAt: previous } }, { portfolioWeights: { ownerId: 5 } },
    { hardDeadlineHorizonHours: 0 }, { fixedEventHorizonHours: 337 }, { nearDeadlineStretchMinutes: 181 },
    { followUpDailyCap: 11 }, { prepDailyCap: -1 }, { upcomingHorizonDays: 31 }, { upcomingNodeLimit: 51 },
    { riskCriticalHours: 169 }, { riskHighHours: 337 }, { riskNearHours: 505 }, { riskWatchHours: 721 },
    { portfolioMinimumCandidateScore: 101 }, { portfolioMinimumCandidateScore: 1.5 }, { weights: { fit: -1 } },
    { weights: { fit: 101 } }, { weights: { fit: null } }, { weights: { fit: Number.NaN } },
    { weights: { fit: Number.POSITIVE_INFINITY } }, { prepDailyCap: '2' }, { weights: null },
    { prepDailyCap: undefined }, { weights: { fit: undefined } },
  ])('rejects invalid or injected Decision Rules patch %#', patch => {
    expect(planningManagementSchema.safeParse({ operations: [ruleOperation(patch)] }).success).toBe(false)
  })
  it.each([
    {}, { version: 1 }, { updatedAt: previous }, { key: 'timePlanning' }, { reschedule: true },
    { defaultDailyMinutes: -1 }, { defaultDailyMinutes: 1441 }, { defaultDailyMinutes: 1.5 },
    { dateOverrides: {} }, { dateOverrides: null }, { dateOverrides: { '2026-02-29': 50 } },
    { dateOverrides: { '2026-04-31': 0 } }, { dateOverrides: { '2026-2-01': 0 } },
    { dateOverrides: { '2026-10-02': 1441 } }, { dateOverrides: { arbitrary: null } },
    { weeklyWindows: [{ weekday: 7, startMinute: 0, endMinute: 60 }] },
    { weeklyWindows: [{ weekday: 0, startMinute: 60, endMinute: 60 }] },
    { weeklyWindows: [{ weekday: 0, startMinute: 120, endMinute: 60 }] },
    { weeklyWindows: [{ weekday: 0, startMinute: -1, endMinute: 60 }] },
    { weeklyWindows: [{ weekday: 0, startMinute: 0, endMinute: 1441 }] },
    { weeklyWindows: [{ weekday: 0, startMinute: 0, endMinute: 60, timezone: 'Asia/Shanghai' }] },
    { weeklyWindows: [{ weekday: 0, startMinute: 0, endMinute: 60 }, { weekday: 0, startMinute: 59, endMinute: 100 }] },
    { weeklyWindows: Array.from({ length: 22 }, (_, index) => ({ weekday: 0, startMinute: index * 2, endMinute: index * 2 + 1 })) },
  ])('rejects invalid or injected time preferences patch %#', patch => {
    expect(planningManagementSchema.safeParse({ operations: [timeOperation(patch)] }).success).toBe(false)
  })
  it('accepts leap dates, adjacent windows, fractional weights, null clearing and zero capacity', () => {
    expect(planningManagementSchema.safeParse({ operations: [ruleOperation({ weights: { fit: 2.5 } }), timeOperation({ defaultDailyMinutes: 0, dateOverrides: { '2028-02-29': null }, weeklyWindows: [{ weekday: 0, startMinute: 0, endMinute: 60 }, { weekday: 0, startMinute: 60, endMinute: 120 }] })] }).success).toBe(true)
  })
  it.each([
    [], [ruleOperation({ prepDailyCap: 1 }), ruleOperation({ prepDailyCap: 2 })],
    [ruleOperation({ prepDailyCap: 1 }), { kind: 'reset_decision_rules', expectedFingerprint: validFingerprint }],
    [timeOperation({ defaultDailyMinutes: 0 }), { kind: 'reset_time_preferences', expectedFingerprint: validFingerprint }],
    [ruleOperation({ prepDailyCap: 1 }), timeOperation({ defaultDailyMinutes: 0 }), { kind: 'reset_time_preferences', expectedFingerprint: validFingerprint }],
    [{ kind: 'reset_time_preferences' }], [{ kind: 'reset_time_preferences', expectedFingerprint: 'null' }],
    [{ kind: 'reset_time_preferences', expectedFingerprint: validFingerprint, patch: {} }],
    [{ kind: 'reset_decision_rules', expectedFingerprint: validFingerprint, value: DEFAULT_DECISION_RULES }],
    [{ kind: 'json_patch', expectedFingerprint: validFingerprint, path: '/decisionRules', value: {} }],
  ])('rejects missing fingerprint, duplicate configuration, unknown kind or excessive batch %#', operations => {
    expect(planningManagementSchema.safeParse({ operations }).success).toBe(false)
  })
  it('rejects top-level injection and a structurally valid batch above 256 KiB', () => {
    expect(planningManagementSchema.safeParse({ operations: [ruleOperation({ prepDailyCap: 1 })], ownerId: 'foreign' }).success).toBe(false)
    const dateOverrides = Object.fromEntries(Array.from({ length: 16000 }, (_, index) => [new Date(Date.UTC(2000, 0, index + 1)).toISOString().slice(0, 10), 1440]))
    expect(planningManagementSchema.safeParse({ operations: [timeOperation({ dateOverrides })] }).success).toBe(false)
  })
})

describe('exact planning reads and guarded atomic writes', () => {
  it('reads recommended rules, unknown capacity and raw absence without mutating the snapshot', async () => {
    const initial = fixture(); const before = structuredClone(initial)
    const read = await getPlanningManagementRead(initial)
    expect(read.decisionRules.raw).toBeNull()
    expect(read.decisionRules.effective).toEqual(DEFAULT_DECISION_RULES)
    expect(read.timePreferences).toMatchObject({ raw: null, effective: { defaultDailyMinutes: null, weeklyWindows: null, dateOverrides: {} } })
    expect(read.decisionRules.fingerprint).toBe(await planningManagementFingerprint(null))
    read.decisionRules.effective.weights.fit = 99
    expect(initial).toEqual(before); expect(DEFAULT_DECISION_RULES.weights.fit).toBe(12)
  })
  it('fingerprints raw values with deterministic object ordering and distinguishes absence, defaults, metadata and arrays', async () => {
    const left = { version: 1 as const, defaultDailyMinutes: 60, dateOverrides: { '2026-10-03': 0, '2026-10-02': 60 }, updatedAt: previous }
    const right = { updatedAt: previous, dateOverrides: { '2026-10-02': 60, '2026-10-03': 0 }, defaultDailyMinutes: 60, version: 1 as const }
    expect(await planningManagementFingerprint(left)).toBe(await planningManagementFingerprint(right))
    expect(await planningManagementFingerprint(null)).not.toBe(await planningManagementFingerprint(createDefaultDecisionRules(previous)))
    expect(await planningManagementFingerprint(left)).not.toBe(await planningManagementFingerprint({ ...left, updatedAt: now.toISOString() }))
    expect(await planningManagementFingerprint({ ...left, weeklyWindows: [] })).not.toBe(await planningManagementFingerprint(left))
    expect(await planningManagementFingerprint({ ...left, defaultDailyMinutes: 0 })).not.toBe(await planningManagementFingerprint(left))
  })
  it('patches nested weights and scalars without resetting adjacent or optional raw fields', async () => {
    const initial = fixture(); initial.data.decisionRules = createDefaultDecisionRules(previous)
    delete initial.data.decisionRules.fitComponentWeights
    delete initial.data.decisionRules.opportunityValueComponentWeights
    const before = structuredClone(initial)
    const changed = await apply('patch_decision_rules', { weights: { fit: 32 }, portfolioWeights: { overlapPenalty: 3 }, prepDailyCap: 4 }, initial)
    expect(changed.snapshot.data.decisionRules).toMatchObject({ prepDailyCap: 4, weights: { fit: 32, urgency: 23 }, portfolioWeights: { overlapPenalty: 3, fit: 28 }, updatedAt: now.toISOString() })
    expect(changed.snapshot.data.decisionRules?.fitComponentWeights).toBeUndefined()
    expect(changed.snapshot.data.decisionRules?.opportunityValueComponentWeights).toBeUndefined()
    expect(changed.compensation?.payload.changes[0].before).toEqual(before.data.decisionRules)
    expect(changed.compensationFingerprint).toBe(await planningManagementFingerprint(changed.compensation))
    expect(initial).toEqual(before)
  })
  it('uses effective optional weight defaults only when an explicitly patched group changes', async () => {
    const initial = fixture(); initial.data.decisionRules = createDefaultDecisionRules(previous)
    delete initial.data.decisionRules.fitComponentWeights
    const changed = await apply('patch_decision_rules', { fitComponentWeights: { skills: 30 } }, initial)
    expect(changed.snapshot.data.decisionRules?.fitComponentWeights).toEqual({ ...DEFAULT_DECISION_RULES.fitComponentWeights, skills: 30 })
  })
  it('reuses cross-field risk and positive weight validators atomically', async () => {
    for (const patch of [
      { riskCriticalHours: 40 },
      { weights: Object.fromEntries(Object.keys(DEFAULT_DECISION_RULES.weights).map(key => [key, 0])) },
      { fitComponentWeights: Object.fromEntries(Object.keys(DEFAULT_DECISION_RULES.fitComponentWeights!).map(key => [key, 0])) },
      { opportunityValueComponentWeights: Object.fromEntries(Object.keys(DEFAULT_DECISION_RULES.opportunityValueComponentWeights!).map(key => [key, 0])) },
      { portfolioWeights: Object.fromEntries(Object.keys(DEFAULT_DECISION_RULES.portfolioWeights!).map(key => [key, 0])) },
    ]) {
      const initial = fixture(); const before = structuredClone(initial)
      await expect(apply('patch_decision_rules', patch, initial)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
      expect(initial).toEqual(before)
    }
  })
  it('merges per-date capacity, removes individual overrides and clears nullable preferences', async () => {
    const initial = fixture(); initial.data.timePlanning = { version: 1, defaultDailyMinutes: 120, weeklyWindows: [{ weekday: 1, startMinute: 600, endMinute: 900 }], dateOverrides: { '2026-10-02': 30, '2026-10-03': 45 }, updatedAt: previous }
    const changed = await apply('patch_time_preferences', { defaultDailyMinutes: null, weeklyWindows: null, dateOverrides: { '2026-10-02': null, '2028-02-29': 0 } }, initial)
    expect(changed.snapshot.data.timePlanning).toEqual({ version: 1, dateOverrides: { '2026-10-03': 45, '2028-02-29': 0 }, updatedAt: now.toISOString() })
    const removed = await apply('patch_time_preferences', { dateOverrides: { '2026-10-03': null, '2028-02-29': null } }, changed.snapshot, 'planning-command-2')
    expect(removed.snapshot.data.timePlanning?.dateOverrides).toBeUndefined()
    expect(initial.data.timePlanning.defaultDailyMinutes).toBe(120)
  })
  it('records explicit zero capacity and empty windows without fabricating date overrides', async () => {
    const changed = await apply('patch_time_preferences', { defaultDailyMinutes: 0, weeklyWindows: [] })
    expect(changed.snapshot.data.timePlanning).toEqual({ version: 1, defaultDailyMinutes: 0, weeklyWindows: [], updatedAt: now.toISOString() })
  })
  it.each([
    ['patch_decision_rules', { prepDailyCap: DEFAULT_DECISION_RULES.prepDailyCap }],
    ['patch_decision_rules', { fitComponentWeights: { skills: DEFAULT_DECISION_RULES.fitComponentWeights!.skills } }],
    ['patch_time_preferences', { defaultDailyMinutes: null, weeklyWindows: null, dateOverrides: { '2026-10-02': null } }],
    ['reset_time_preferences', undefined],
  ] as const)('no-op %s does not create defaults, audit history, metadata or compensation', async (kind, patch) => {
    const initial = fixture(); const changed = await apply(kind, patch, initial)
    expect(changed).toMatchObject({ changed: false, status: 'ALREADY_APPLIED' })
    expect(changed.snapshot).toBe(initial); expect(changed.compensation).toBeUndefined()
  })
  it('does not update metadata for identical stored values or a repeat reset', async () => {
    const initial = fixture(); initial.data.decisionRules = createDefaultDecisionRules(previous)
    initial.data.timePlanning = { version: 1, defaultDailyMinutes: 0, updatedAt: previous }
    expect((await apply('reset_decision_rules', undefined, initial)).changed).toBe(false)
    expect((await apply('patch_time_preferences', { defaultDailyMinutes: 0 }, initial)).snapshot).toBe(initial)
  })
  it('reset rules explicitly persists recommended defaults; reset time deletes the row to unknown capacity', async () => {
    const defaults = await apply('reset_decision_rules')
    expect(defaults.snapshot.data.decisionRules).toEqual(createDefaultDecisionRules(now.toISOString()))
    expect(defaults.compensation?.payload.changes[0].before).toBeNull()
    const initial = fixture(); initial.data.timePlanning = { version: 1, defaultDailyMinutes: 0, updatedAt: previous }
    const cleared = await apply('reset_time_preferences', undefined, initial)
    expect(Object.hasOwn(cleared.snapshot.data, 'timePlanning')).toBe(false)
    expect((await getPlanningManagementRead(cleared.snapshot)).timePreferences.effective.defaultDailyMinutes).toBeNull()
  })
  it('requires exact raw fingerprints even for no-op changes and metadata-only edits', async () => {
    const initial = fixture(); const read = await getPlanningManagementRead(initial)
    initial.data.decisionRules = createDefaultDecisionRules(previous)
    await expect(applyPlanningManagement(initial, { operations: [{ kind: 'patch_decision_rules', expectedFingerprint: read.decisionRules.fingerprint, patch: { prepDailyCap: 2 } }] }, 'stale-command', now)).rejects.toMatchObject({ code: 'STALE_TARGET' })
    const stored = await getPlanningManagementRead(initial)
    initial.data.decisionRules.updatedAt = now.toISOString()
    await expect(applyPlanningManagement(initial, { operations: [{ kind: 'reset_decision_rules', expectedFingerprint: stored.decisionRules.fingerprint }] }, 'stale-command', now)).rejects.toMatchObject({ code: 'STALE_TARGET' })
  })
  it('applies a mixed batch atomically and provides one aggregate audit event and exact refs', async () => {
    const initial = fixture(); const read = await getPlanningManagementRead(initial)
    const input = { operations: [{ kind: 'patch_decision_rules' as const, expectedFingerprint: read.decisionRules.fingerprint, patch: { prepDailyCap: 4 } }, { kind: 'patch_time_preferences' as const, expectedFingerprint: read.timePreferences.fingerprint, patch: { defaultDailyMinutes: 30 } }] }
    const changed = await applyPlanningManagement(initial, input, 'mixed-command', now)
    expect(changed.compensation?.payload.changes).toHaveLength(2)
    expect(changed.snapshot.data.timeline).toHaveLength(1)
    expect(changed.snapshot.data.timeline![0]).toMatchObject({ commandOperation: 'planning_management', commandId: 'mixed-command', category: 'rules' })
    expect(planningManagementObjectRefs(input)).toEqual([{ type: 'decision_rules', id: 'current' }, { type: 'time_preferences', id: 'current' }])
  })
  it('leaves the input untouched when the second operation is stale or violates semantic validators', async () => {
    const initial = fixture(); const before = structuredClone(initial); const read = await getPlanningManagementRead(initial)
    for (const second of [
      { kind: 'reset_decision_rules', expectedFingerprint: validFingerprint },
      { kind: 'patch_decision_rules', expectedFingerprint: read.decisionRules.fingerprint, patch: { riskCriticalHours: 100 } },
    ]) {
      await expect(applyPlanningManagement(initial, { operations: [{ kind: 'patch_time_preferences', expectedFingerprint: read.timePreferences.fingerprint, patch: { defaultDailyMinutes: 50 } }, second] }, 'atomic-command', now)).rejects.toThrow()
      expect(initial).toEqual(before)
    }
  })
  it('bounds stored configuration size and rejects invalid original rows before they are fingerprinted', async () => {
    const initial = fixture(); initial.data.timePlanning = { version: 1, updatedAt: previous, ...{ extra: 'x'.repeat(262144) } }
    await expect(getPlanningManagementRead(initial)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    initial.data.timePlanning = { version: 1, updatedAt: previous, weeklyWindows: [{ weekday: 0, startMinute: 0, endMinute: 60 }, { weekday: 0, startMinute: 50, endMinute: 90 }] }
    await expect(getPlanningManagementRead(initial)).rejects.toThrow(/overlap/)
    delete initial.data.timePlanning; initial.data.decisionRules = { ...createDefaultDecisionRules(previous), key: 'other' } as never
    await expect(getPlanningManagementRead(initial)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })
})

describe('conflict-aware reversible planning compensation', () => {
  it('restores original raw rows and absent optional fields exactly, preserving audit history', async () => {
    const initial = fixture(); initial.data.decisionRules = createDefaultDecisionRules(previous)
    delete initial.data.decisionRules.fitComponentWeights
    const changed = await apply('patch_decision_rules', { fitComponentWeights: { skills: 29 } }, initial)
    const restored = restorePlanningManagement(changed.snapshot, changed.compensation!, now)
    expect(restored.data.decisionRules).toEqual(initial.data.decisionRules)
    expect(restored.data.timeline).toEqual(changed.snapshot.data.timeline)
    expect(changed.snapshot.data.decisionRules?.fitComponentWeights?.skills).toBe(29)
  })
  it('undo of created rules and preferences restores missing rows instead of persisting defaults', async () => {
    for (const [kind, patch, field] of [['reset_decision_rules', undefined, 'decisionRules'], ['patch_time_preferences', { defaultDailyMinutes: 40 }, 'timePlanning']] as const) {
      const changed = await apply(kind, patch)
      const restored = restorePlanningManagement(changed.snapshot, changed.compensation!, now)
      expect(Object.hasOwn(restored.data, field)).toBe(false)
      expect(restored.data.timeline).toEqual(changed.snapshot.data.timeline)
    }
  })
  it('undo of a reset restores explicit zero, empty arrays and raw extra metadata exactly', async () => {
    const initial = fixture(); initial.data.timePlanning = { version: 1, defaultDailyMinutes: 0, weeklyWindows: [], dateOverrides: {}, updatedAt: previous, ...{ legacyLabel: 'Retained synthetic metadata' } }
    const changed = await apply('reset_time_preferences', undefined, initial)
    const restored = restorePlanningManagement(changed.snapshot, changed.compensation!, now)
    expect(JSON.stringify(restored.data.timePlanning)).toBe(JSON.stringify(initial.data.timePlanning))
    expect(restorePlanningManagement(changed.snapshot, changed.compensation!, now).data.timePlanning).not.toBe(initial.data.timePlanning)
  })
  it('refuses restoring over a newer edit, including update metadata or a recreated explicit-default row', async () => {
    const changed = await apply('patch_decision_rules', { prepDailyCap: 4 })
    changed.snapshot.data.decisionRules!.updatedAt = '2026-10-03T00:00:00Z'
    expect(() => restorePlanningManagement(changed.snapshot, changed.compensation!, now)).toThrow(/newer data/)
    const initial = fixture(); initial.data.timePlanning = { version: 1, defaultDailyMinutes: 50, updatedAt: previous }
    const reset = await apply('reset_time_preferences', undefined, initial)
    reset.snapshot.data.timePlanning = { version: 1, updatedAt: now.toISOString() }
    expect(() => restorePlanningManagement(reset.snapshot, reset.compensation!, now)).toThrow(/newer data/)
  })
  it('retains unrelated later edits but refuses a mixed restore if either configuration changed', async () => {
    const first = await apply('patch_decision_rules', { prepDailyCap: 4 })
    const second = await apply('patch_time_preferences', { defaultDailyMinutes: 60 }, first.snapshot, 'planning-command-2')
    const restored = restorePlanningManagement(second.snapshot, first.compensation!, now)
    expect(restored.data.decisionRules).toBeUndefined(); expect(restored.data.timePlanning).toEqual(second.snapshot.data.timePlanning)
    const initial = fixture(); const fingerprint = await planningManagementFingerprint(null)
    const mixed = await applyPlanningManagement(initial, { operations: [{ kind: 'patch_decision_rules', expectedFingerprint: fingerprint, patch: { prepDailyCap: 5 } }, { kind: 'patch_time_preferences', expectedFingerprint: fingerprint, patch: { defaultDailyMinutes: 100 } }] }, 'mixed-restore-command', now)
    mixed.snapshot.data.timePlanning!.defaultDailyMinutes = 99
    const before = structuredClone(mixed.snapshot)
    expect(() => restorePlanningManagement(mixed.snapshot, mixed.compensation!, now)).toThrow(/newer data/)
    expect(mixed.snapshot).toEqual(before)
  })
  it('validates bounded compensation shape, exact targets and semantic configuration before restoring', async () => {
    const changed = await apply('patch_time_preferences', { defaultDailyMinutes: 60 })
    const change = changed.compensation!.payload.changes[0]
    for (const malformed of [
      null, {}, { ...changed.compensation, operation: 'different_restore' },
      { ...changed.compensation, injected: 'unknown' }, { ...changed.compensation, payload: { changes: [] } },
      { ...changed.compensation, payload: { changes: [change, change] } },
      { ...changed.compensation, payload: { changes: [{ ...change, id: 'other' }] } },
      { ...changed.compensation, payload: { changes: [{ ...change, type: 'opportunity' }] } },
      { ...changed.compensation, payload: { changes: [{ ...change, before: null, after: null }] } },
      { ...changed.compensation, payload: { changes: [{ ...change, before: { version: 1, defaultDailyMinutes: -1, updatedAt: previous } }] } },
      { ...changed.compensation, payload: { changes: [{ ...change, before: { version: 1, updatedAt: previous, weeklyWindows: [{ weekday: 0, startMinute: 0, endMinute: 60 }, { weekday: 0, startMinute: 0, endMinute: 50 }] } }] } },
    ]) expect(() => restorePlanningManagement(changed.snapshot, malformed as PlanningManagementCompensation, now)).toThrow(/compensation is invalid/)
  })
})

describe('planning changes preserve historical and scheduling facts', () => {
  it.each(['scheduleNodes', 'decisionRequests', 'semanticReceipts', 'reminderIntents', 'reminderOutbox'] as const)('rejects missing protected %s consistently on read, apply and restore without creating arrays', async field => {
    const changed = await apply('patch_time_preferences', { defaultDailyMinutes: 60 })
    const fingerprint = await planningManagementFingerprint(null)
    for (const version of [1, 4] as const) {
      const initial = fixture(); initial.version = version; delete initial.data[field]
      const before = structuredClone(initial)
      const expected = { code: 'INVALID_CONFIGURATION', message: expect.stringMatching(/migration or upgrade.*protected data collections are missing/) }
      await expect(getPlanningManagementRead(initial)).rejects.toMatchObject(expected)
      await expect(applyPlanningManagement(initial, { operations: [{ kind: 'patch_time_preferences', expectedFingerprint: fingerprint, patch: { defaultDailyMinutes: 60 } }] }, 'missing-array-command', now)).rejects.toMatchObject(expected)
      expect(() => restorePlanningManagement(initial, changed.compensation!, now)).toThrow(expect.objectContaining(expected))
      expect(initial).toEqual(before)
      expect(Object.hasOwn(initial.data, field)).toBe(false)
    }
  })
  it('upgrades only a supported complete envelope and keeps planning reads consistent without semantic migration', async () => {
    const initial = unknownDeadlineWorkspace(1); initial.version = 1
    initial.data.actions[0].dueAt = '2026-08-27T15:59:59Z'
    initial.data.actions[0].timingMode = 'deadline'
    initial.data.timePlanning = { version: 1, defaultDailyMinutes: 45, updatedAt: previous }
    const before = structuredClone(initial)
    const read = await getPlanningManagementRead(initial)
    expect(read.timePreferences.raw).toEqual(initial.data.timePlanning)
    expect(read.timePreferences.fingerprint).toBe(await planningManagementFingerprint(initial.data.timePlanning))
    const changed = await apply('patch_time_preferences', { defaultDailyMinutes: 60 }, initial)
    expect(changed.snapshot.version).toBe(4)
    expect(JSON.stringify(changed.snapshot.data.actions)).toBe(JSON.stringify(initial.data.actions))
    expect((await getPlanningManagementRead(changed.snapshot)).timePreferences.fingerprint).toBe(await planningManagementFingerprint(changed.snapshot.data.timePlanning))
    expect(initial).toEqual(before)
  })
  it('keeps canceled and superseded unknown-deadline nodes, actions, evidence and historical scores byte-equivalent on apply/restore', async () => {
    const initial = unknownDeadlineWorkspace(2, true)
    const before = structuredClone(initial)
    const fingerprint = await planningManagementFingerprint(null)
    const result = await applyPlanningManagement(initial, { operations: [{ kind: 'patch_decision_rules', expectedFingerprint: fingerprint, patch: { weights: { urgency: 90 }, fitComponentWeights: { skills: 75 }, portfolioMinimumCandidateScore: 10 } }, { kind: 'patch_time_preferences', expectedFingerprint: fingerprint, patch: { defaultDailyMinutes: 0 } }] }, 'preserve-facts-command', now)
    const restored = restorePlanningManagement(result.snapshot, result.compensation!, now)
    for (const output of [result.snapshot, restored]) {
      for (const field of Object.keys(initial.data).filter(key => key !== 'timeline') as Array<keyof PJSDASSnapshot['data']>) {
        expect(JSON.stringify(output.data[field]), field).toBe(JSON.stringify(initial.data[field]))
      }
      expect(output.data.timeline!.slice(0, initial.data.timeline!.length)).toEqual(initial.data.timeline)
      expect(resolveApplicationDeadline(output.data.opportunities[0], output.data).state).toBe('unknown')
      expect(output.data.scheduleNodes!.filter(node => node.state === 'cancelled')).toHaveLength(2)
      validateSnapshot(output)
    }
    expect(initial).toEqual(before)
  })
  it('does not silently project legacy action dates or process state during a configuration write', async () => {
    const initial = unknownDeadlineWorkspace(1)
    initial.data.actions[0].dueAt = '2026-08-27T15:59:59Z'
    initial.data.actions[0].timingMode = 'deadline'
    const before = JSON.stringify(initial.data.actions)
    const changed = await apply('patch_time_preferences', { defaultDailyMinutes: 60 }, initial)
    expect(JSON.stringify(changed.snapshot.data.actions)).toBe(before)
    const restored = restorePlanningManagement(changed.snapshot, changed.compensation!, now)
    expect(JSON.stringify(restored.data.actions)).toBe(before)
  })
  it('fails closed if a legacy process needs unrelated semantic rewriting to validate', async () => {
    const initial = fixture(); initial.version = 1
    initial.data.processes.push({ id: 'legacy-process', company: 'Synthetic', role: 'Engineer', stage: 'screening', stageLabel: 'Screening' })
    const before = structuredClone(initial)
    await expect(apply('patch_time_preferences', { defaultDailyMinutes: 60 }, initial)).rejects.toThrow(/progress/)
    expect(initial).toEqual(before)
  })
})

describe('planning evidence preserves accepted raw metadata limits',()=>{
  it.each(['deep','wide'])('restores bounded %s metadata in both configuration pairs',async kind=>{
    const { unknownDeadlineWorkspace }=await import('./fixtures/unknownDeadlineWorkspace.js')
    const { createDefaultDecisionRules }=await import('../src/decisionRules.js')
    const api=await import('../src/planningManagement.js')
    const s=unknownDeadlineWorkspace(1);let metadata:any=0;if(kind==='deep')for(let i=0;i<30;i++)metadata={child:metadata};else metadata=Array(34000).fill(0)
    s.data.decisionRules={...createDefaultDecisionRules('2026-10-01T00:00:00Z'),metadata} as any
    s.data.timePlanning={version:1,defaultDailyMinutes:40,updatedAt:'2026-10-01T00:00:00Z',metadata} as any
    const read=await api.getPlanningManagementRead(s)
    const applied=await api.applyPlanningManagement(s,{operations:[{kind:'patch_decision_rules',expectedFingerprint:read.decisionRules.fingerprint,patch:{followUpDailyCap:3}},{kind:'patch_time_preferences',expectedFingerprint:read.timePreferences.fingerprint,patch:{defaultDailyMinutes:60}}]},'planning-bounded',new Date('2026-10-02T00:00:00Z'))
    expect(applied.compensation!.payload.changes).toHaveLength(2)
    expect(applied.compensationFingerprint).toBe(await api.planningManagementFingerprint(applied.compensation))
    const restored=api.restorePlanningManagement(applied.snapshot,applied.compensation!,new Date('2026-10-02T00:00:00Z'))
    expect(restored.data.decisionRules).toEqual(s.data.decisionRules);expect(restored.data.timePlanning).toEqual(s.data.timePlanning)
  })
})

describe('planning compensation byte envelope',()=>{
  it('accepts two maximum-size raw configurations plus bounded wrapper overhead',async()=>{
    const { unknownDeadlineWorkspace }=await import('./fixtures/unknownDeadlineWorkspace.js')
    const { createDefaultDecisionRules }=await import('../src/decisionRules.js')
    const api=await import('../src/planningManagement.js');const s=unknownDeadlineWorkspace(1)
    const fill=(value:any)=>{value.metadata='';value.metadata='x'.repeat(262144-new TextEncoder().encode(JSON.stringify(value)).byteLength);expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBe(262144);return value}
    s.data.decisionRules=fill(createDefaultDecisionRules('2026-10-01T00:00:00.000Z'))
    s.data.timePlanning=fill({version:1,defaultDailyMinutes:40,updatedAt:'2026-10-01T00:00:00.000Z'})
    const read=await api.getPlanningManagementRead(s)
    const result=await api.applyPlanningManagement(s,{operations:[{kind:'patch_decision_rules',expectedFingerprint:read.decisionRules.fingerprint,patch:{followUpDailyCap:3}},{kind:'patch_time_preferences',expectedFingerprint:read.timePreferences.fingerprint,patch:{defaultDailyMinutes:60}}]},'max-config-command',new Date('2026-10-02T00:00:00Z'))
    expect(result.compensation!.payload.changes).toHaveLength(2)
    expect(new TextEncoder().encode(JSON.stringify(result.compensation)).byteLength).toBeGreaterThan(4*262144)
    expect(result.compensationFingerprint).toBe(await api.planningManagementFingerprint(result.compensation))
    const restored=api.restorePlanningManagement(result.snapshot,result.compensation!);expect(restored.data.decisionRules).toEqual(s.data.decisionRules);expect(restored.data.timePlanning).toEqual(s.data.timePlanning)
  })
})

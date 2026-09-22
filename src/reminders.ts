import type {
  ExternalCapabilityId,
  ExternalCapabilityState,
  ReminderChannel,
  ReminderDeliveryOwner,
  ReminderIntent,
  ReminderOutboxRecord,
  ReminderPurpose,
  ScheduleNode,
} from './model.js'

export type ExternalCapabilityProbe = {
  id: ExternalCapabilityId
  state: ExternalCapabilityState
  reason: string
  provider?: string
  probedAt: string
}

export type ExternalCapabilityMap = Partial<Record<ExternalCapabilityId, ExternalCapabilityState>>

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function iso(value: string | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return undefined
  return new Date(value).toISOString()
}

export function reminderDedupeKey(node: Pick<ScheduleNode, 'id' | 'version'>, purpose: ReminderPurpose) {
  return `${node.id}@${node.version}|${purpose}`
}

export function reminderCapabilityForOwner(owner: ReminderDeliveryOwner): ExternalCapabilityId | undefined {
  if (owner === 'external_task') return 'chatgpt_tasks'
  if (owner === 'external_calendar') return 'google_calendar'
  return undefined
}

export function reminderChannelForOwner(owner: ReminderDeliveryOwner): ReminderChannel {
  if (owner === 'external_task') return 'task'
  if (owner === 'external_calendar') return 'calendar'
  return 'in_product'
}

function boundaryFor(node: ScheduleNode, purpose: ReminderPurpose) {
  const temporal = node.temporal
  if (purpose === 'deadline') return temporal.deadlineAt ?? temporal.endAt ?? temporal.startAt
  return temporal.startAt ?? temporal.deadlineAt ?? temporal.endAt
}

export function resolveReminderTrigger(node: ScheduleNode, input: {
  triggerAt?: string
  offsetMinutesBefore?: number
  purpose: ReminderPurpose
}) {
  if (input.triggerAt) {
    const parsed = iso(input.triggerAt)
    if (!parsed) throw new Error('Reminder triggerAt must be a valid date/time.')
    return parsed
  }
  const offset = input.offsetMinutesBefore
  if (offset === undefined) throw new Error('Reminder requires triggerAt or offsetMinutesBefore.')
  if (!Number.isInteger(offset) || offset < 0 || offset > 30 * 24 * 60) {
    throw new Error('Reminder offsetMinutesBefore must be an integer between 0 and 43200.')
  }
  const boundary = boundaryFor(node, input.purpose)
  const boundaryMs = boundary ? new Date(boundary).getTime() : NaN
  if (!Number.isFinite(boundaryMs) || node.temporal.precision !== 'datetime') {
    throw new Error('Reminder offset requires an exact datetime ScheduleNode boundary.')
  }
  return new Date(boundaryMs - offset * 60_000).toISOString()
}

export function buildReminderIntent(input: {
  node: ScheduleNode
  purpose: ReminderPurpose
  triggerAt: string
  deliveryOwner?: ReminderDeliveryOwner
  channel?: ReminderChannel
  capabilityStates?: ExternalCapabilityMap
  existing?: ReminderIntent
  now: string
}) {
  const owner = input.deliveryOwner ?? 'pjsdas'
  const expectedChannel = reminderChannelForOwner(owner)
  const channel = input.channel ?? expectedChannel
  if (channel !== expectedChannel) throw new Error('Reminder channel must match its single delivery owner.')
  const capability = reminderCapabilityForOwner(owner)
  const capabilityState = capability ? input.capabilityStates?.[capability] ?? 'unsupported' : 'available'
  const dedupeKey = reminderDedupeKey(input.node, input.purpose)
  const id = input.existing?.id ?? `reminder:${stableHash(dedupeKey)}`
  const state: ReminderIntent['state'] = capability && capabilityState !== 'available'
    ? 'unsupported'
    : 'active'
  const reminder: ReminderIntent = {
    id,
    scheduleNodeId: input.node.id,
    scheduleNodeVersion: input.node.version,
    purpose: input.purpose,
    triggerAt: input.triggerAt,
    deliveryOwner: owner,
    channel,
    capability,
    state,
    dedupeKey,
    externalLink: capability ? {
      capability,
      externalId: input.existing?.externalLink?.externalId,
      externalUrl: input.existing?.externalLink?.externalUrl,
      state: capabilityState === 'available' ? (input.existing?.externalLink?.state ?? 'unmapped') : 'failed',
      lastReceiptAt: input.existing?.externalLink?.lastReceiptAt,
      lastErrorCode: capabilityState === 'available' ? input.existing?.externalLink?.lastErrorCode : `CAPABILITY_${capabilityState.toUpperCase()}`,
    } : undefined,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  }
  const outbox: ReminderOutboxRecord | undefined = capability ? {
    id: `reminder-outbox:${stableHash(`${id}|upsert|${input.triggerAt}|${owner}`)}`,
    reminderIntentId: id,
    operation: 'upsert',
    capability,
    state: capabilityState === 'available' ? 'pending' : 'unsupported',
    attemptCount: 0,
    payloadFingerprint: stableHash(JSON.stringify([
      input.node.id,
      input.node.version,
      input.purpose,
      input.triggerAt,
      owner,
      channel,
    ])),
    receiptCode: capabilityState === 'available' ? undefined : `CAPABILITY_${capabilityState.toUpperCase()}`,
    createdAt: input.now,
    updatedAt: input.now,
  } : undefined
  return { reminder, outbox, capabilityState }
}

export function validateReminderIntent(value: ReminderIntent, nodeIds: Set<string>) {
  const errors: string[] = []
  if (!value.id?.trim() || !value.dedupeKey?.trim()) errors.push('ReminderIntent identity is incomplete.')
  if (!nodeIds.has(value.scheduleNodeId)) errors.push('ReminderIntent references a missing ScheduleNode.')
  if (!Number.isInteger(value.scheduleNodeVersion) || value.scheduleNodeVersion < 1) errors.push('ReminderIntent node version is invalid.')
  if (!iso(value.triggerAt)) errors.push('ReminderIntent triggerAt is invalid.')
  if (value.channel !== reminderChannelForOwner(value.deliveryOwner)) errors.push('ReminderIntent has more than one delivery ownership interpretation.')
  const capability = reminderCapabilityForOwner(value.deliveryOwner)
  if (capability !== value.capability) errors.push('ReminderIntent capability does not match delivery owner.')
  if (value.externalLink && value.externalLink.capability !== value.capability) errors.push('ReminderIntent ExternalLink capability mismatch.')
  if (!iso(value.createdAt) || !iso(value.updatedAt)) errors.push('ReminderIntent timestamps are invalid.')
  return errors
}

export function validateReminderOutbox(value: ReminderOutboxRecord, reminderIds: Set<string>) {
  const errors: string[] = []
  if (!value.id?.trim() || !value.payloadFingerprint?.trim()) errors.push('Reminder outbox identity is incomplete.')
  if (!reminderIds.has(value.reminderIntentId)) errors.push('Reminder outbox references a missing ReminderIntent.')
  if (!Number.isInteger(value.attemptCount) || value.attemptCount < 0) errors.push('Reminder outbox attemptCount is invalid.')
  if (value.nextAttemptAt && !iso(value.nextAttemptAt)) errors.push('Reminder outbox nextAttemptAt is invalid.')
  if (!iso(value.createdAt) || !iso(value.updatedAt)) errors.push('Reminder outbox timestamps are invalid.')
  return errors
}

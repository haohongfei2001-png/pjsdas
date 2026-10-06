import * as z from 'zod/v4'
import { createDefaultDiscoveryProfile } from './discoveryProfile.js'
import { normalizePlanningTimezone, validPlanningTimezone } from './timePlanningPreferences.js'
import { SNAPSHOT_SCHEMA, SNAPSHOT_VERSION, validateSnapshot, type PJSDASSnapshot } from './snapshot.js'

/** One explicit first-party "start empty" action, not a migration/reset API. */
export const consumerWorkspaceBootstrapSchema = z.object({
  action: z.literal('initialize_empty'),
  expectedAccountId: z.uuid(),
  commandId: z.string().trim().min(8).max(160),
  timezone: z.string().trim().max(120).refine(validPlanningTimezone, 'Choose a valid IANA timezone.'),
  confirmStartEmpty: z.literal(true),
}).strict()
export type ConsumerWorkspaceBootstrapInput = z.infer<typeof consumerWorkspaceBootstrapSchema>

export function createEmptyConsumerWorkspace(raw: unknown, now = new Date()): PJSDASSnapshot {
  const input = consumerWorkspaceBootstrapSchema.parse(raw)
  const timestamp = now.toISOString()
  const snapshot: PJSDASSnapshot = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    exportedAt: timestamp,
    data: {
      opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
      scheduleNodes: [], decisionRequests: [], semanticReceipts: [], reminderIntents: [], reminderOutbox: [],
      discoveryInbox: [], changeSets: [],
      discoveryProfile: createDefaultDiscoveryProfile(timestamp),
      // Capacity is deliberately unknown until the owner supplies it.
      timePlanning: { version: 1, timezone: normalizePlanningTimezone(input.timezone), updatedAt: timestamp },
      timeline: [{ id: `bootstrap:${input.commandId}`, kind: 'change_set_applied', category: 'data', source: 'user_action', occurredAt: timestamp, recordedAt: timestamp, title: 'Started an empty workspace', commandId: input.commandId, commandOperation: 'initialize_empty' }],
    },
  }
  validateSnapshot(snapshot)
  return snapshot
}

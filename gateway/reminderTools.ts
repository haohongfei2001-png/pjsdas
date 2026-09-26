import type { CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { ExternalCapabilityId, ExternalCapabilityState } from '../src/model.js'
import type { ExternalCapabilityProbe } from '../src/reminders.js'
import { WorkspaceSourceError, type WorkspaceSource } from './workspaceSource.js'

export const getExternalCapabilitiesSchema = z.object({}).strict()
export const listReminderIntentsSchema = z.object({
  state: z.enum(['active', 'paused', 'cancelled', 'unsupported']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()

export function defaultExternalCapabilityProbes(now = new Date()): ExternalCapabilityProbe[] {
  const probedAt = now.toISOString()
  return [
    {
      id: 'chatgpt_tasks',
      state: 'unsupported',
      reason: 'The TodayAction MCP runtime has no authorized ChatGPT Tasks action adapter. Host-side task features are not assumed to be callable.',
      provider: 'ChatGPT',
      probedAt,
    },
    {
      id: 'google_calendar',
      state: 'unsupported',
      reason: 'The TodayAction runtime has no authorized Google Calendar write adapter or calendar OAuth scope.',
      provider: 'Google Calendar',
      probedAt,
    },
  ]
}

export function capabilityStateMap(probes: ExternalCapabilityProbe[]): Partial<Record<ExternalCapabilityId, ExternalCapabilityState>> {
  return Object.fromEntries(probes.map((probe) => [probe.id, probe.state])) as Partial<Record<ExternalCapabilityId, ExternalCapabilityState>>
}

function success(body: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  }
}

function failure(caught: unknown): CallToolResult {
  if (caught instanceof WorkspaceSourceError) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code: caught.code, message: caught.message, retryable: caught.retryable }) }],
    }
  }
  if (caught instanceof z.ZodError) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_ARGUMENT', message: caught.issues[0]?.message ?? 'Invalid reminder tool arguments.', retryable: false }) }],
    }
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code: 'TEMPORARILY_UNAVAILABLE', message: 'TodayAction reminder tools are temporarily unavailable.', retryable: true }) }],
  }
}

export async function invokeExternalCapabilities(
  rawArgs: unknown,
  probes: ExternalCapabilityProbe[],
): Promise<CallToolResult> {
  try {
    getExternalCapabilitiesSchema.parse(rawArgs)
    return success({
      generatedAt: new Date().toISOString(),
      capabilities: probes.map((probe) => ({ ...probe })),
      rule: 'External task/calendar objects are delivery channels only; ScheduleNode and ReminderIntent remain TodayAction truth.',
    })
  } catch (caught) {
    return failure(caught)
  }
}

export async function invokeListReminderIntents(
  source: WorkspaceSource,
  rawArgs: unknown,
): Promise<CallToolResult> {
  try {
    const parsed = listReminderIntentsSchema.parse(rawArgs)
    const workspace = await source.read()
    const reminders = (workspace.snapshot.data.reminderIntents ?? [])
      .filter((item) => !parsed.state || item.state === parsed.state)
      .sort((a, b) => a.triggerAt.localeCompare(b.triggerAt) || a.id.localeCompare(b.id))
      .slice(0, parsed.limit)
    const outboxByIntent = new Map(
      (workspace.snapshot.data.reminderOutbox ?? [])
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((item) => [item.reminderIntentId, item]),
    )
    return success({
      workspaceVersion: workspace.context.workspaceVersion,
      reminders: reminders.map((item) => ({
        id: item.id,
        scheduleNodeId: item.scheduleNodeId,
        scheduleNodeVersion: item.scheduleNodeVersion,
        purpose: item.purpose,
        triggerAt: item.triggerAt,
        state: item.state,
        deliveryOwner: item.deliveryOwner,
        channel: item.channel,
        capability: item.capability,
        externalState: item.externalLink?.state,
        deliveryReceipt: outboxByIntent.get(item.id)
          ? {
              operation: outboxByIntent.get(item.id)!.operation,
              state: outboxByIntent.get(item.id)!.state,
              attemptCount: outboxByIntent.get(item.id)!.attemptCount,
              receiptCode: outboxByIntent.get(item.id)!.receiptCode,
            }
          : undefined,
      })),
      truncated: (workspace.snapshot.data.reminderIntents ?? []).length > reminders.length,
    })
  } catch (caught) {
    return failure(caught)
  }
}

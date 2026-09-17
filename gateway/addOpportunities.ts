import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { findSimilarOpportunity } from '../src/discoveryQuality.js'
import { stableIngestionHash } from '../src/ingestion.js'
import { createJobPostingEvidence, jobIdentityKey } from '../src/jobPosting.js'
import type { Action, DiscoveryConfidence, Opportunity, TimelineRecord } from '../src/model.js'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import {
  requireWritableWorkspaceSource,
  WorkspaceSourceError,
  type WorkspaceSource,
} from './workspaceSource.js'

const publicHttpUrl = z.string().url().refine((value) => {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1'
}, 'sourceUrl must be a public http(s) URL.')

const optionalDateString = z.string().min(1).max(80).refine(
  (value) => !Number.isNaN(new Date(value).getTime()),
  'Expected a valid date or date-time string.',
).optional()

export const addOpportunityCandidateSchema = z.object({
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(180),
  sourceUrl: publicHttpUrl,
  sourceTitle: z.string().min(1).max(240),
  location: z.string().min(1).max(160).optional(),
  deadline: optionalDateString,
  compensationText: z.string().min(1).max(500).optional(),
  rationale: z.string().min(1).max(1200).optional(),
  roleType: z.enum(['core', 'backup', 'reach', 'lottery', 'practice']),
  opportunityValue: z.number().min(0).max(100).optional(),
  fitScore: z.number().min(0).max(100).optional(),
  fitConfidence: z.enum(['high', 'medium', 'low']).optional(),
  opportunityValueConfidence: z.enum(['high', 'medium', 'low']).optional(),
  postingStatus: z.enum(['open', 'unknown']).optional(),
  discoveredAt: optionalDateString,
}).strict()

export const addOpportunitiesSchema = z.object({
  opportunities: z.array(addOpportunityCandidateSchema).min(1).max(20),
}).strict()

export type AddOpportunityCandidate = z.infer<typeof addOpportunityCandidateSchema>
export type AddOpportunitiesArgs = z.infer<typeof addOpportunitiesSchema>

function confidenceFor(score: number | undefined, confidence: DiscoveryConfidence | undefined): DiscoveryConfidence {
  if (confidence) return confidence
  return score === undefined ? 'low' : 'medium'
}

function buildOpportunity(candidate: AddOpportunityCandidate, now: Date): Opportunity {
  const discoveredAt = candidate.discoveredAt ?? now.toISOString()
  const posting = createJobPostingEvidence({
    company: candidate.company,
    role: candidate.role,
    sourceUrl: candidate.sourceUrl,
    sourceTitle: candidate.sourceTitle,
    location: candidate.location,
    deadline: candidate.deadline,
    compensationText: candidate.compensationText,
    postingStatus: candidate.postingStatus ?? 'unknown',
    observedAt: discoveredAt,
  })
  const identity = jobIdentityKey(candidate.company, candidate.role, candidate.location)
  const id = `user-opportunity:${stableIngestionHash(`${identity}|${posting.canonicalSourceUrl}`)}`
  const hasAssessment = candidate.opportunityValue !== undefined || candidate.fitScore !== undefined

  return {
    id,
    company: candidate.company,
    role: candidate.role,
    currentStageLabel: '待投',
    processStage: 'not_applied',
    roleType: candidate.roleType,
    early: false,
    deadline: candidate.deadline,
    sourcePriority: hasAssessment ? 'ChatGPT 明确写入' : 'ChatGPT 明确写入 · 待补评估',
    salaryReference: candidate.compensationText,
    nextActionLabel: '审阅并投递',
    prepEstimateMinutes: 45,
    opportunityValue: candidate.opportunityValue ?? 50,
    fitScore: candidate.fitScore ?? 50,
    locallyManaged: true,
    importedAt: discoveredAt,
    detail: {
      discovery: {
        sourceUrl: candidate.sourceUrl,
        sourceTitle: candidate.sourceTitle,
        location: candidate.location,
        compensationText: candidate.compensationText,
        rationale: candidate.rationale ?? '用户已在当前对话中明确要求将该来源岗位写入 PJSDAS。',
        discoveredAt,
        fitConfidence: confidenceFor(candidate.fitScore, candidate.fitConfidence),
        opportunityValueConfidence: confidenceFor(candidate.opportunityValue, candidate.opportunityValueConfidence),
        posting,
      },
    },
  }
}

function applyAction(opportunity: Opportunity, now: string): Action {
  return {
    id: `apply:${opportunity.id}`,
    kind: 'apply',
    title: `投递 ${opportunity.company}｜${opportunity.role}`,
    opportunityId: opportunity.id,
    processStage: 'not_applied',
    dueAt: opportunity.deadline,
    timingMode: opportunity.deadline ? 'deadline' : undefined,
    estimatedMinutes: opportunity.prepEstimateMinutes ?? 45,
    leverage: 70,
    delayCost: opportunity.deadline ? 65 : 40,
    status: 'todo',
    sourceLabel: 'ChatGPT 明确写入',
    createdAt: now,
    updatedAt: now,
  }
}

function timelineRecord(opportunity: Opportunity, now: string): TimelineRecord {
  const sourceUrl = opportunity.detail?.discovery?.sourceUrl ?? ''
  return {
    id: `timeline:user-opportunity:${stableIngestionHash(`${opportunity.id}|${sourceUrl}`)}`,
    kind: 'opportunity_added',
    category: 'opportunity',
    source: 'user_action',
    occurredAt: now,
    recordedAt: now,
    title: `明确写入机会｜${opportunity.company}｜${opportunity.role}`,
    detail: '用户在当前对话中明确要求 ChatGPT 将该岗位写入 PJSDAS；无需二次 Apply。',
    opportunityId: opportunity.id,
    company: opportunity.company,
    role: opportunity.role,
    sourceRef: sourceUrl || undefined,
  }
}

function cloneSnapshot(snapshot: PJSDASSnapshot): PJSDASSnapshot {
  return structuredClone(snapshot)
}

function jsonResult(structuredContent: Record<string, unknown>, isError = false): CallToolResult {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}

function toolError(caught: unknown): CallToolResult {
  if (caught instanceof WorkspaceSourceError) {
    return jsonResult({ code: caught.code, message: caught.message, retryable: caught.retryable }, true)
  }
  return jsonResult({
    code: 'DIRECT_WRITE_FAILED',
    message: caught instanceof Error ? caught.message : 'PJSDAS explicit user write failed.',
    retryable: false,
  }, true)
}

export async function invokeAddOpportunities(source: WorkspaceSource, rawArgs: unknown): Promise<CallToolResult> {
  try {
    const args = addOpportunitiesSchema.parse(rawArgs)
    const workspace = await source.read()
    const now = workspace.context.now ?? new Date()
    const nowIso = now.toISOString()
    const next = cloneSnapshot(workspace.snapshot)
    const created: Array<{ opportunityId: string; company: string; role: string }> = []
    const duplicates: Array<{ opportunityId: string; company: string; role: string; existingCompany: string; existingRole: string }> = []

    for (const candidate of args.opportunities) {
      const existing = findSimilarOpportunity(candidate, next.data.opportunities.filter((item) => item.processStage !== 'closed'))
      if (existing) {
        duplicates.push({
          opportunityId: existing.id,
          company: candidate.company,
          role: candidate.role,
          existingCompany: existing.company,
          existingRole: existing.role,
        })
        continue
      }

      const opportunity = buildOpportunity(candidate, now)
      next.data.opportunities.push(opportunity)
      next.data.actions.push(applyAction(opportunity, nowIso))
      next.data.timeline = [...(next.data.timeline ?? []), timelineRecord(opportunity, nowIso)]
      created.push({ opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role })
    }

    if (created.length === 0) {
      return jsonResult({
        applied: true,
        reviewRequired: false,
        workspaceVersion: workspace.context.workspaceVersion,
        createdCount: 0,
        duplicateCount: duplicates.length,
        created,
        duplicates,
      })
    }

    next.exportedAt = nowIso
    validateSnapshot(next)
    const writable = requireWritableWorkspaceSource(source)
    const written = await writable.write({
      snapshot: next,
      expectedWorkspaceVersion: workspace.context.workspaceVersion ?? workspace.snapshot.exportedAt,
      updatedByDevice: 'mcp-explicit-user-write',
    })

    return jsonResult({
      applied: true,
      reviewRequired: false,
      workspaceVersion: written.context.workspaceVersion,
      createdCount: created.length,
      duplicateCount: duplicates.length,
      created,
      duplicates,
    })
  } catch (caught) {
    return toolError(caught)
  }
}

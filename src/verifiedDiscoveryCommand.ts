import { canonicalizeVerifiedJobSourceUrl } from './jobPosting.js'
import { z } from 'zod/v4'
import { discoveryFactClaimShape, validateFactPrecision } from './discoveryFactSchema.js'
import { applyMonitorIngestionHardened } from './ingestionHardening.js'
import type { PJSDASSnapshot } from './snapshot.js'
import type { IngestionRunSummary } from './model.js'
import { discoverySearchExecutionSchema } from './discoverySearchEvidence.js'

const timestamp = z.string().datetime({ offset: true })
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const field = z.enum(['company', 'role', 'location', 'recruitmentBatch', 'deadline', 'publishedAt', 'postingStatus'])
const fieldProof = z.object({ field, value: z.string().min(1).max(500), sourceUrl: z.string().url().max(2000),
  selector: z.string().min(1).max(300), quote: z.string().min(1).max(500), documentSha256: hash.optional(), verifiedAt: timestamp.optional() }).strict()
const authorityEvidence = z.object({ version: z.literal(1), publisherId: z.literal('cn-moe-affiliated-universities'), institution: z.string().min(1).max(200),
  rootUrl: z.string().url().max(2000), fetchedAt: timestamp, expiresAt: timestamp,
  links: z.array(z.object({ sourceUrl: z.string().url().max(2000), href: z.string().min(1).max(2000), targetUrl: z.string().url().max(2000),
    selector: z.string().min(1).max(300), quote: z.string().min(1).max(500), documentSha256: hash }).strict()).min(1).max(4) }).strict()
const sourceProof = z.object({ version: z.literal(1), authority: z.enum(['employer', 'ats', 'recruiting_platform', 'university_recruiting']),
  authorityUrl: z.string().url().max(2000), requestedUrl: z.string().url().max(2000), finalUrl: z.string().url().max(2000),
  verifiedAt: timestamp, documentSha256: hash, postingIdentity: z.string().min(1).max(2000), sourceNativeId: z.string().min(1).max(500).optional(),
  fields: z.array(fieldProof).min(2).max(7), unresolvedFields:z.array(z.enum(['deadline','recruitmentBatch'])).max(2).optional(), authorityEvidence: authorityEvidence.optional() }).strict()
export const verifiedDiscoveryObservationSchema = z.object({ ...discoveryFactClaimShape,
  sourceRecordId: z.string().min(1).max(2500), sourceVerification: z.enum(['verified', 'unverified']),
  sourceVerifiedAt: timestamp.optional(), discoveredAt: timestamp,
  sourceVerificationReason: z.string().max(500).optional(), sourceProof: sourceProof.optional(),
}).strict().superRefine((value, context) => {
  validateFactPrecision(value, context)
  if (value.sourceVerification !== 'verified') {
    if (value.sourceProof) context.addIssue({ code: 'custom', message: 'An unresolved observation cannot carry trusted source proof.' })
    return
  }
  const proof = value.sourceProof
  if (!proof || proof.verifiedAt !== value.sourceVerifiedAt) {
    context.addIssue({ code: 'custom', message: 'A verified fact requires the independently generated source proof and timestamp.' }); return
  }
  const sourceUrl = canonicalizeVerifiedJobSourceUrl(value.sourceUrl)
  if (![proof.requestedUrl, proof.finalUrl].some(url => canonicalizeVerifiedJobSourceUrl(url) === sourceUrl)) {
    context.addIssue({ code: 'custom', path: ['sourceProof'], message: 'The verified source proof belongs to another requested/final posting URL.' })
  }
  const fields = new Map(proof.fields.map(item => [item.field, item.value]))
  for(const key of proof.unresolvedFields??[])if(value[key]!==undefined)context.addIssue({code:'custom',path:[key],message:'An unresolved source field cannot be asserted as a verified value.'})
  if (fields.size !== proof.fields.length) context.addIssue({ code: 'custom', message: 'Source proof has conflicting repeated fields.' })
  for (const key of ['company', 'role', 'location', 'recruitmentBatch', 'deadline', 'publishedAt'] as const) {
    if (value[key] !== undefined && fields.get(key) !== value[key]) context.addIssue({ code: 'custom', path: [key], message: 'The field is not bound to its source proof.' })
  }
  if (value.postingStatus && value.postingStatus !== 'unknown' && fields.get('postingStatus') !== value.postingStatus) context.addIssue({ code: 'custom', path: ['postingStatus'], message: 'Posting status requires exact source evidence.' })
})

/** Internal command only. External model/MCP payloads cannot invoke this kind or
 * supply source authority; gateways first parse claims and independently fetch. */
export const verifiedDiscoveryCommandSchema = z.object({
  commandId: z.string().min(8).max(300), kind: z.literal('ingest_verified_discovery'), inputFingerprint: hash,
  scopeFingerprint: hash.optional(),
  run: z.object({ runId: z.string().min(1).max(180), sourceId: z.string().min(1).max(180),
    producer: z.enum(['server_scheduler', 'mcp_trusted_ingestion']), startedAt: timestamp, completedAt: timestamp,
    searchExecutions: z.array(discoverySearchExecutionSchema).min(1).max(48).optional(),
    omittedSearchHitCount: z.number().int().min(0).max(1200).optional(),
    sourcePolicy: z.object({ version: z.literal(1), enabled: z.boolean(), label: z.string().max(160).optional(),
      cadenceMinutes: z.number().int().min(10).max(43200), freshnessSlaMinutes: z.number().int().min(10).max(43200) }).strict().optional(),
    observations: z.array(verifiedDiscoveryObservationSchema).max(100),
  }).strict(),
}).strict().superRefine((value,context)=>{
  if(value.run.producer==='server_scheduler'&&!value.run.searchExecutions?.some(item=>item.outcome!=='failed')) {
    context.addIssue({code:'custom',path:['run','searchExecutions'],message:'A scheduled Discovery completion requires successful public-web execution evidence, including empty results.'})
  }
})
export type VerifiedDiscoveryCommand = z.infer<typeof verifiedDiscoveryCommandSchema>

export function discoveryCommandRun(snapshot: PJSDASSnapshot, sourceId: string, runId: string): IngestionRunSummary | undefined {
  return snapshot.data.timeline?.find(item => item.ingestionRun?.sourceKind === 'gpt_monitor'
    && item.ingestionRun.sourceId === sourceId && item.ingestionRun.runId === runId)?.ingestionRun
}

export function applyVerifiedDiscoveryCommand(snapshot: PJSDASSnapshot, raw: VerifiedDiscoveryCommand, now = new Date()) {
  const command = verifiedDiscoveryCommandSchema.parse(raw)
  const previous = discoveryCommandRun(snapshot, command.run.sourceId, command.run.runId)
  if (previous) {
    if (previous.inputFingerprint !== command.inputFingerprint || previous.commandId !== command.commandId) throw new Error('Discovery command ID was reused with different facts or unsupported legacy evidence.')
    return { status: 'ALREADY_APPLIED' as const, snapshot, summary: 'This verified Discovery run is already recorded.',
      ingestion: { snapshot, run: previous, records: [], alreadyApplied: true, createdOpportunityIds: [], touchedOpportunityIds: [], processEventIds: [] } }
  }
  for (const value of command.run.observations) {
    if (value.sourceProof && Date.parse(value.sourceProof.verifiedAt) > now.getTime()) throw new Error('Source verification is later than this domain command.')
    if (value.sourceProof?.authorityEvidence && Date.parse(value.sourceProof.authorityEvidence.expiresAt) <= now.getTime()) throw new Error('Source authority evidence expired before the domain command.')
  }
  // Repeated candidates remain separately accounted for, while source-native
  // posting identity still controls business deduplication.
  const occurrences = new Map<string, number>()
  const observations = command.run.observations.map(value => {
    const id = value.sourceProof?.postingIdentity ?? value.sourceRecordId
    const count = occurrences.get(id) ?? 0; occurrences.set(id, count + 1)
    return { ...value, sourceRecordId: count ? `${id}:duplicate-observation:${count}` : id }
  })
  const result = applyMonitorIngestionHardened(snapshot, { ...command.run, observations, completedAt: now.toISOString() })
  // Discovery can update source facts, never a task, event or personal process.
  for (const collection of ['actions', 'scheduleNodes', 'processEvents', 'processes'] as const) {
    if (JSON.stringify(result.snapshot.data[collection]) !== JSON.stringify(snapshot.data[collection])) throw new Error(`Discovery may not mutate ${collection}.`)
  }
  for (const original of snapshot.data.opportunities) {
    const current = result.snapshot.data.opportunities.find(item => item.id === original.id)
    if (!current || current.processStage !== original.processStage) throw new Error('Discovery may not remove jobs or change personal recruiting state.')
  }
  result.run.inputFingerprint = command.inputFingerprint
  result.run.scopeFingerprint = command.scopeFingerprint
  result.run.commandId = command.commandId
  if (command.run.searchExecutions) {
    if (!command.run.searchExecutions.some(item => item.outcome !== 'failed')) throw new Error('A Discovery completion requires actual successful query evidence, including empty results.')
    result.run.searchExecutions = command.run.searchExecutions
    result.run.retrievalStatus = command.run.searchExecutions.some(item => item.outcome === 'failed') || (command.run.omittedSearchHitCount ?? 0) > 0 ? 'partial' : 'complete'
    result.run.omittedSearchHitCount = command.run.omittedSearchHitCount ?? 0
  }
  const originalIds = new Set(snapshot.data.timeline?.map(record => record.id))
  for (const record of result.snapshot.data.timeline ?? []) {
    if (record.ingestionRun?.runId === command.run.runId && record.ingestionRun.sourceId === command.run.sourceId) record.ingestionRun = result.run
    if (!originalIds.has(record.id)) {
      record.commandId = command.commandId; record.commandOperation = command.kind
    }
  }
  return { status: 'APPLIED' as const, snapshot: result.snapshot, summary: 'Verified Discovery facts were applied through the domain command.', ingestion: result }
}

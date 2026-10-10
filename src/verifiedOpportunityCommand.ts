import {z} from 'zod/v4'
import {verifiedDiscoveryObservationSchema} from './verifiedDiscoveryCommand.js'
import {createMonitorOpportunity} from './autonomousIngestion.js'
import {appendOpportunityOnly} from './opportunityCreation.js'
import {resolveCanonicalPostingIdentity} from './opportunityCanonicalization.js'
import {upgradeSnapshotToLatest,validateSnapshot,type PJSDASSnapshot} from './snapshot.js'
import type {Opportunity} from './model.js'

const schema=z.object({kind:z.literal('save_verified_discovery_opportunity'),commandId:z.string().min(1).max(500),
  opportunityId:z.string().min(1).max(500),observation:verifiedDiscoveryObservationSchema}).strict()
export type VerifiedOpportunityCommand=z.infer<typeof schema>

/** Adapt existing saved/signed evidence; it cannot upgrade a legacy rationale
 * into verification. The enclosing first-party command owns audit and Undo. */
export function observationFromVerifiedOpportunity(opportunity: Opportunity) {
  const discovery=opportunity.detail?.discovery,posting=discovery?.posting
  const proof=posting?.sourceProof??discovery?.sourceProof
  if(!discovery||!proof)throw new Error('DISCOVERY_VERIFICATION_REQUIRED: refresh this recruiting source before saving it as verified facts.')
  const unresolved = new Set(proof.unresolvedFields ?? [])
  const evidencedStatus = proof.fields.find(field => field.field === 'postingStatus')?.value
  return verifiedDiscoveryObservationSchema.parse({sourceRecordId:proof.postingIdentity,company:opportunity.company,role:opportunity.role,
    sourceUrl:discovery.sourceUrl,sourceTitle:discovery.sourceTitle,location:discovery.location,
    deadline:unresolved.has('deadline')?undefined:opportunity.deadline,deadlinePrecision:unresolved.has('deadline')?undefined:opportunity.deadlinePrecision??posting?.deadlinePrecision,
    publishedAt:posting?.publishedAt,publishedPrecision:posting?.publishedPrecision,recruitmentBatch:unresolved.has('recruitmentBatch')?undefined:posting?.recruitmentBatch,
    postingStatus:evidencedStatus===posting?.postingStatus?posting?.postingStatus:'unknown',discoveredAt:discovery.discoveredAt,sourceVerification:'verified',sourceVerifiedAt:proof.verifiedAt,sourceProof:proof})
}

/** Shared validated creation command for reviewed Discovery adapters. Identity
 * and construction reuse the same source-fact core as automatic ingestion. */
export function applyVerifiedOpportunityCommand(snapshot:PJSDASSnapshot,raw:VerifiedOpportunityCommand,now=new Date()){
  const command=schema.parse(raw),observation=command.observation
  if(observation.sourceVerification!=='verified'||!observation.sourceProof)throw new Error('DISCOVERY_VERIFICATION_REQUIRED: independent recruiting-source proof is required.')
  if(Date.parse(observation.sourceProof.verifiedAt)>now.getTime())throw new Error('Source verification is later than this domain command.')
  if(observation.sourceProof.authorityEvidence&&Date.parse(observation.sourceProof.authorityEvidence.expiresAt)<=now.getTime())throw new Error('DISCOVERY_VERIFICATION_REQUIRED: source authority expired; refresh it before saving.')
  const identity=resolveCanonicalPostingIdentity(snapshot,observation)
  if(identity.kind==='ambiguous')throw new Error('Discovery source identity is ambiguous; no job was saved.')
  if(identity.kind==='same_posting')return{status:'ALREADY_APPLIED' as const,snapshot,opportunity:identity.opportunity,summary:'This exact recruiting posting is already saved.'}
  const next=upgradeSnapshotToLatest(snapshot)
  const opportunity=appendOpportunityOnly(next.data,{...createMonitorOpportunity(observation,now.toISOString()),id:command.opportunityId})
  next.exportedAt=now.toISOString();validateSnapshot(next)
  return{status:'APPLIED' as const,snapshot:next,opportunity,summary:`Saved verified job ${opportunity.company}｜${opportunity.role}.`,
    compensation:{operation:'remove_created_opportunity',payload:{opportunityId:opportunity.id,expected:structuredClone(opportunity)}}}
}

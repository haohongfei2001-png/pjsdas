import { describe, expect, it } from 'vitest'
import { createSnapshot, validateSnapshot } from '../src/snapshot.js'
import { invalidateLegacyProcessEvent, readLegacyProcessCorrection } from '../src/legacyProcessCorrection.js'
import { auditWorkspaceIntegrity } from '../src/workspaceIntegrity.js'
import { overlayProcessEventsOnOpportunities } from '../src/processEvents.js'
import { applyUserDomainCommand } from '../src/domainCommands.js'
import type { ProcessEvent } from '../src/model.js'
const now = new Date('2026-10-05T10:00:00Z')
const event: ProcessEvent = { id:'synthetic-legacy-event', opportunityId:'synthetic-missing', company:'Example Company', role:'Research Analyst', type:'rejection', occurredAt:'2026-09-01T10:00:00Z', source:'email', createdAt:now.toISOString(),updatedAt:now.toISOString() }
function base() { return createSnapshot({opportunities:[],processEvents:[structuredClone(event)],processes:[],actions:[],prep:[],applicationGroups:[]}, now.toISOString()) }
async function command(snapshot=base()) { const review=await readLegacyProcessCorrection(snapshot,event.id);return { kind:'invalidate_legacy_process_event' as const,commandId:'synthetic-legacy-correction',eventId:event.id,expectedEventFingerprint:review.expectedEventFingerprint,sourceRefs:review.sourceRefs,reason:'Duplicate legacy record verified against retained source.',evidenceRefs:['synthetic:reviewed-source']} }
describe('audited legacy process evidence correction',()=>{
  it('retains exact original orphan evidence while removing active corruption and replaying idempotently',async()=>{
    const before=base(), c=await command(before)
    expect(auditWorkspaceIntegrity(before,now).criticalCount).toBe(1)
    const after=await invalidateLegacyProcessEvent(before,c,now)
    expect(after.status).toBe('APPLIED');expect(after.snapshot.data.processEvents[0]).toMatchObject(event)
    expect(after.snapshot.data.processEvents[0].invalidation?.sourceReceiptId).toBeUndefined()
    expect(after.snapshot.data.semanticReceipts).toHaveLength(1);expect(after.snapshot.data.timeline).toHaveLength(1)
    expect(auditWorkspaceIntegrity(after.snapshot,now).criticalCount).toBe(0)
    expect(()=>validateSnapshot(after.snapshot)).not.toThrow()
    expect((await invalidateLegacyProcessEvent(after.snapshot,c,now)).status).toBe('ALREADY_APPLIED')
    await expect(invalidateLegacyProcessEvent(after.snapshot,{...c,reason:'different'},now)).rejects.toThrow(/reused/)
  })
  it('does not relax existing source receipt correction or accept any receipt-owned event',async()=>{
    const before=base(), c=await command(before)
    before.data.semanticReceipts!.push({id:'synthetic-receipt',inputId:'synthetic-input',sourceKind:'gmail',sourceId:'gmail:synthetic',sourceRecordId:'synthetic-source',status:'committed',summary:'Original evidence',affectedObjects:[{type:'process_event',id:event.id}],decisionRequestIds:[],undoAvailable:false,createdAt:now.toISOString(),updatedAt:now.toISOString()})
    await expect(invalidateLegacyProcessEvent(before,c,now)).rejects.toThrow(/SOURCE_RECEIPT_PRESENT/)
    expect(()=>applyUserDomainCommand(base(),{kind:'invalidate_process_event',commandId:'synthetic-standard',opportunityId:event.opportunityId,eventId:event.id,receiptId:'missing',expectedEventUpdatedAt:event.updatedAt,reason:'review',evidenceRefs:['synthetic:source']},now)).toThrow(/receipt/)
  })
  it('rejects altered event, provenance, or dependencies after review',async()=>{
    const before=base(), c=await command(before)
    before.data.processEvents[0].notes='new evidence'
    await expect(invalidateLegacyProcessEvent(before,c,now)).rejects.toThrow(/changed/)
    await expect(invalidateLegacyProcessEvent(base(),{...c,sourceRefs:['synthetic:invented']},now)).rejects.toThrow(/changed/)
    const dependent=base();dependent.data.actions.push({id:'synthetic-action',kind:'manual',title:'Work',processEventId:event.id,leverage:1,delayCost:1,status:'todo'})
    await expect(invalidateLegacyProcessEvent(dependent,await command(dependent),now)).rejects.toThrow(/DEPENDENT_SCHEDULE/)
  })
  it('does not hide an unaudited tombstone in the integrity report',()=>{
    const before=base();before.data.processEvents[0].invalidation={commandId:'fake',receiptId:'missing',legacyReview:{expectedEventFingerprint:'0'.repeat(64),sourceRefs:['synthetic:ref']},reason:'fake',evidenceRefs:['synthetic:ref'],invalidatedAt:now.toISOString()}
    expect(auditWorkspaceIntegrity(before,now).criticalCount).toBe(1)
    expect(()=>validateSnapshot(before)).toThrow()
  })
  it('refuses markerless terminal projections rather than claiming a partial repair',async()=>{
    const before=base();before.data.opportunities.push({id:event.opportunityId,company:event.company,role:event.role,processStage:'closed',currentStageLabel:'Closed',roleType:'core',early:false,opportunityValue:80,fitScore:80,importedAt:now.toISOString()})
    expect(await readLegacyProcessCorrection(before,event.id)).toMatchObject({eligible:false,blocked:'UNPROVEN_TERMINAL_PROJECTION'})
    await expect(invalidateLegacyProcessEvent(before,await command(before),now)).rejects.toThrow(/UNPROVEN_TERMINAL_PROJECTION/)
    expect(before.data.processEvents[0].invalidation).toBeUndefined()
  })
  it('does not overwrite later independently owned legitimate terminal progress',async()=>{
    const before=base();before.data.opportunities.push({id:event.opportunityId,company:event.company,role:event.role,processStage:'offer',currentStageLabel:'Offer',roleType:'core',early:false,opportunityValue:80,fitScore:80,importedAt:now.toISOString(),effectiveProcessEventId:'synthetic-later',effectiveProcessEventAt:now.toISOString()})
    before.data.processEvents.push({...event,id:'synthetic-later',type:'offer',occurredAt:now.toISOString()})
    const after=await invalidateLegacyProcessEvent(before,await command(before),now)
    expect(after.snapshot.data.opportunities).toEqual(before.data.opportunities)
    expect(overlayProcessEventsOnOpportunities(after.snapshot.data.opportunities,after.snapshot.data.processEvents)[0].processStage).toBe('offer')
  })
})

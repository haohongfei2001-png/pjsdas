import {createSnapshot} from '../../src/snapshot.js'
import {applyOpportunityManagement,readOpportunityManagement,restoreOpportunityManagement} from '../../src/opportunityManagement.js'
import {diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.js'
/** Real existing v3 archive capability, not an arbitrary snapshot rewrite. */
export async function stagedOpportunityFixture(actionCount=2050,options:{compactIds?:boolean}={}) {
 const at='2030-01-01T00:00:00.000Z'
 const opportunity={id:options.compactIds?'o':'synthetic-large-opp',company:'Synthetic',role:'Analyst',currentStageLabel:'screening',processStage:'screening' as const,roleType:'core' as const,early:false,opportunityValue:50,fitScore:50,locallyManaged:true,importedAt:at}
 const before=createSnapshot({opportunities:[opportunity,{...opportunity,id:options.compactIds?'r':'synthetic-retained-opp'}],processes:[],processEvents:[],actions:Array.from({length:actionCount},(_,i)=>({id:(options.compactIds?'a':'synthetic-action:')+i,kind:'manual' as const,title:'Synthetic retained task',opportunityId:opportunity.id,estimatedMinutes:10,leverage:50,delayCost:50,status:'todo' as const,createdAt:at,updatedAt:at})),prep:[],applicationGroups:[],timeline:[]},at)
 const review=await readOpportunityManagement(before,opportunity.id)
 const commandId='synthetic-staged-archive'
 const input={operations:[{kind:'archive_opportunity' as const,id:opportunity.id,expectedFingerprint:review.archive.fingerprint,dependencies:review.archive.dependencies,reason:'Synthetic explicitly reviewed archive'}]}
 const result=await applyOpportunityManagement(before,input,commandId,new Date(at))
 if(result.status!=='APPLIED'||!result.compensation)throw Error('expected actual v3 archive')
 const undo=restoreOpportunityManagement(result.snapshot,result.compensation,new Date('2030-01-01T00:01:00.000Z'))
 return {at,before,result,undo,commandId,input,delta:diffWorkspaceRows(before,result.snapshot),undoDelta:diffWorkspaceRows(result.snapshot,undo)}
}

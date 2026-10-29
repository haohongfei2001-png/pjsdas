import {createSnapshot} from '../../src/snapshot.js'
import {applyUserDomainCommand,applyDomainCompensation} from '../../src/domainCommands.js'
import {diffWorkspaceRows} from '../../gateway/workspaceRowsCodec.js'
export function largeAbandonFixture() {
 const at='2030-01-01T00:00:00.000Z'
 const before=createSnapshot({opportunities:[{id:'synthetic-opp',company:'Synthetic',role:'Analyst',currentStageLabel:'screening',processStage:'screening',roleType:'core',early:false,opportunityValue:50,fitScore:50,locallyManaged:true,importedAt:at}],processes:[],processEvents:[],actions:Array.from({length:2100},(_,i)=>({id:'synthetic-action:'+i,kind:'follow_up' as const,title:'Synthetic retained task '+('x'.repeat(400)),opportunityId:'synthetic-opp',processStage:'screening' as const,estimatedMinutes:10,leverage:50,delayCost:50,status:'todo' as const,createdAt:at,updatedAt:at})),prep:[],applicationGroups:[],timeline:[]},at)
 const command={commandId:'synthetic-large-abandon',kind:'abandon_opportunity' as const,opportunityId:'synthetic-opp'}
 const result=applyUserDomainCommand(before,command,new Date(at))
 if(result.status!=='APPLIED'||!result.compensation)throw Error('expected real domain effect')
 const undo=applyDomainCompensation(result.snapshot,result.compensation,new Date('2030-01-01T00:01:00.000Z'))
 return {at,before,result,undo,command,delta:diffWorkspaceRows(before,result.snapshot),undoDelta:diffWorkspaceRows(result.snapshot,undo)}
}

import assert from 'node:assert/strict'
import { createWorkspaceRowsStoreBridge } from '../../gateway/workspaceRowsStoreBridge.ts'
import { createTransactionalWorkspaceStore } from '../../gateway/transactionalWorkspaceStore.ts'
import { testDiscoveryRows } from './workspace-rows-discovery-stage-a.mjs'

/** Reuse the verifier/domain/authority/cap race oracle, but execute all its HTTP
 * operations through the actual central store after the row generation activates. */
export async function testActivatedCentralDiscovery({db,origin,token,connectionString}) {
 const requests=[]
 const publicFetch=(url,init={})=>{requests.push(String(url));const headers=new Headers(init.headers);headers.set('accept-profile','public');headers.set('content-profile','public');return fetch(String(url).replace('/rest/v1/','/'),{...init,headers})}
 const bridge=createWorkspaceRowsStoreBridge({supabaseUrl:origin,serviceRoleKey:token,readsEnabled:true,writesEnabled:true,rpcTransport:'public-v1',fetchImpl:publicFetch})
 const store=createTransactionalWorkspaceStore({supabaseUrl:origin,serviceRoleKey:token,fetchImpl:publicFetch,...bridge,emptyGmailCheckpoints:true,emptyGmailCheckpointReads:true})
 const source={
  async read(userId){const value=await store.readForUser(userId,{preserveRawData:true});assert(value?.rowEpoch);return {...value,epoch:value.rowEpoch}},
  async commitDiscovery(before,snapshot,command){
   return store.commitAuthoritativeForUser({userId:before.userId,rowPreimage:before,expectedRevision:before.revision,schemaVersion:4,snapshot,commandId:command.commandId,operation:command.operation,payloadHash:command.payloadHash,principalKind:command.principal,clientId:command.clientId,provenance:command.provenance,receiptContext:command.receiptContext,compensation:command.compensation,discoveryAuthorization:command.authorization})
  },
 }
 await testDiscoveryRows({db,source,connectionString,activate:true})
 assert(requests.some(url=>url.includes('/pjsdas_rows_v1_commit_discovery')))
 assert(!requests.some(url=>url.includes('/pjsdas_commit_discovery_workspace_v1')),'active central calls never send old full snapshot RPC')
 console.log('PASS activated central Discovery bridge: actual verifier/domain, original authority, retained budget/cap race and settlement/replay through public-only service RPC')
}

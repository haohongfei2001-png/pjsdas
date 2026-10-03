import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandInteractionRecord } from '../src/db.js'
const state = vi.hoisted(() => ({ rows: [] as CommandInteractionRecord[], transactions: 0, queries: [] as unknown[], afterFirst: undefined as undefined | (() => void), fail: false, aborts: 0 }))
const matches = (rows: CommandInteractionRecord[], key: [string, string]) => structuredClone(rows.filter(row => row.accountKey === key[0] && row.state === key[1]).sort((a,b) => a.id.localeCompare(b.id)))
vi.mock('idb', () => ({ openDB: async () => ({
  transaction: (store: string, mode: string) => {
    expect(store).toBe('commandInteractions'); expect(mode).toBe('readonly'); state.transactions++
    const snapshot = structuredClone(state.rows)
    return { store: { index: (name: string) => { expect(name).toBe('by-account-state'); return { getAll: async (key: [string,string]) => {
      state.queries.push(key); if(state.fail)throw new Error('Synthetic read refused')
      const result=matches(snapshot,key); if(state.queries.length===1)state.afterFirst?.();return result
    } } } }, done: Promise.resolve(), abort: () => { state.aborts++ } }
  },
  // Frozen baseline API used by the old three-transaction implementation.
  getAllFromIndex: async (_store: string, _index: string, key: [string,string]) => {
    state.transactions++;state.queries.push(key);if(state.fail)throw new Error('Synthetic read refused');const result=matches(state.rows,key);if(state.queries.length===1)state.afterFirst?.();return result
  },
}) }))
import { readPendingCommandInteractions } from '../src/db.js'
import { setAccountCacheSession } from '../src/cloud/accountCacheLease.js'
const row=(id:string, status:CommandInteractionRecord['state'],account='owner'):CommandInteractionRecord=>({id,accountKey:account,commandId:id,state:status,createdAt:'2026-10-03T00:00:00Z',delta:{contract:'delta-v1',baseRevision:0,changes:[]}})
beforeEach(()=>{state.rows=[];state.transactions=0;state.queries=[];state.afterFirst=undefined;state.fail=false;state.aborts=0;setAccountCacheSession(undefined);setAccountCacheSession('owner')})
describe('one atomic pending-journal read',()=>{
 it('matches grouped status/primary-key ordering, excludes terminal and foreign records, and uses one transaction',async()=>{
  state.rows=[row('z','active'),row('a','active'),row('m','rollback_pending'),row('b','projection_pending'),row('terminal','confirmed'),row('other','active','other')]
  const expected=['active','projection_pending','rollback_pending'].flatMap(status=>matches(state.rows,['owner',status]))
  expect(await readPendingCommandInteractions('owner')).toEqual(expected)
  expect(state.transactions).toBe(1)
  expect(state.queries).toEqual([['owner','active'],['owner','projection_pending'],['owner','rollback_pending']])
 })
 it('does not duplicate a command if its persisted state changes between index responses',async()=>{
  state.rows=[row('moving','active')]
  state.afterFirst=()=>{state.rows[0].state='projection_pending'}
  const records=await readPendingCommandInteractions('owner')
  expect(records).toEqual([row('moving','active')]);expect(new Set(records.map(row=>row.id)).size).toBe(records.length)
 })
 it('refuses results after an account lease changes',async()=>{
  state.rows=[row('one','active')];state.afterFirst=()=>setAccountCacheSession('other')
  await expect(readPendingCommandInteractions('owner')).rejects.toThrow(/账号或本地数据已变化/)
 })
 it('propagates failed reads and settles its transaction',async()=>{
  state.fail=true;await expect(readPendingCommandInteractions('owner')).rejects.toThrow('Synthetic read refused');expect(state.aborts).toBe(1)
 })
})

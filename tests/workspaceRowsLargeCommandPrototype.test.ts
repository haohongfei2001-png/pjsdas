import {describe,it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {prepareStagedEffects,stagedEffectPages,stagedPrototypeMigrationDecision} from '../gateway/workspaceRowsLargeCommandPrototype.js'
import {largeAbandonFixture} from './fixtures/workspaceRowsLargeCommand.js'
import {applyUserDomainCommand} from '../src/domainCommands.js'
describe('local staged large-command prototype, not production eligibility',()=>{
 it('preserves actual domain abandonment, all action effects, compensation, replay and Undo above fast-path limits',()=>{
  const f=largeAbandonFixture(),p=prepareStagedEffects(f.delta)
  expect(f.delta.changes.length).toBeGreaterThan(2000);expect(Buffer.byteLength(JSON.stringify(f.delta))).toBeGreaterThan(2_097_152)
  const pages=[...stagedEffectPages(p.parts)]
  expect(pages.length).toBeGreaterThan(1)
  expect(pages.flat().map(x=>JSON.parse(x.wire))).toEqual(f.delta.changes)
  for(const page of pages){expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(240_000);expect(page.length).toBeLessThanOrEqual(127)}
  let digest='0'.repeat(64);for(const part of pages.flat())digest=createHash('sha256').update(digest+createHash('sha256').update(part.wire).digest('hex')).digest('hex')
  expect(digest).toBe(p.finalDigest)
  expect(f.result.snapshot.data.actions.every(x=>x.status==='skipped')).toBe(true)
  expect(f.before.data.actions.every(x=>x.status==='todo')).toBe(true)
  expect(f.undo.data.actions.every(x=>x.status==='todo')).toBe(true)
  expect(f.undo.data.timeline).toEqual(f.result.snapshot.data.timeline)
  expect(applyUserDomainCommand(f.result.snapshot,f.command,new Date(f.at)).status).toBe('ALREADY_APPLIED')
  expect(prepareStagedEffects(f.undoDelta).parts.length).toBeGreaterThan(2000)
 })
 it('counts UTF-8 bytes and JSON escaping, not characters',()=>{
  const parts=Array.from({length:20},(_,ordinal)=>({ordinal,wire:JSON.stringify({text:'汉字😀\\\"'.repeat(40)})}))
  const pages=[...stagedEffectPages(parts,2000)];expect(pages.flat()).toEqual(parts)
  for(const page of pages)expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2000)
 })
 it('does not pretend a huge entity is solved by a larger constant',()=>expect(()=>[...stagedEffectPages([{ordinal:0,wire:'x'.repeat(240_000)}])]).toThrow('FRAGMENT_PROTOCOL'))
 it('always keeps migration closed until all original capabilities are covered',()=>expect(stagedPrototypeMigrationDecision().eligible).toBe(false))
})

import {describe,it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {stagedOpportunityFixture} from './fixtures/workspaceRowsStagedOpportunity.js'
import {prepareStagedEffects,stagedEffectPages,stagedPrototypeMigrationDecision} from '../gateway/workspaceRowsLargeCommandPrototype.js'

describe('offline staged v3 opportunity capability',()=>{
 it('exercises a legal original archive and Undo beyond the unchanged row count cap',async()=>{
  const f=await stagedOpportunityFixture()
  expect(f.delta.changes).toHaveLength(2053)
  expect(f.undoDelta.changes).toHaveLength(2052)
  expect(f.result.compensation!.payload.changes.length).toBeLessThanOrEqual(2500)
  expect(Buffer.byteLength(JSON.stringify(f.result.compensation))).toBeLessThan(1048576)
  expect(Buffer.byteLength(JSON.stringify(f.input))).toBeLessThan(262144)
  expect(f.result.snapshot.data.actions).toEqual([])
  expect(f.undo.data.actions).toEqual(f.before.data.actions)
  expect(f.undo.data.opportunities).toEqual(f.before.data.opportunities)
  expect(f.undo.data.timeline).toEqual(f.result.snapshot.data.timeline)
  const prepared=prepareStagedEffects(f.delta),pages=[...stagedEffectPages(prepared.parts)]
  expect(pages.flat().map(x=>JSON.parse(x.wire))).toEqual(f.delta.changes)
  expect(pages.length).toBeGreaterThan(1)
  for(const page of pages)expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(240000)
  expect(stagedPrototypeMigrationDecision().eligible).toBe(false)
 })
 it('keeps the complete existing v3 guard, changing only the effect relation and transaction envelope',()=>{
  const source=readFileSync(new URL('./sql/candidates/workspace-rows-opportunity-stage-a.sql',import.meta.url),'utf8').match(/create function[\s\S]*?end\$\$;/)![0]
  const staged=readFileSync(new URL('./sql/candidates/workspace-rows-staged-opportunity-prototype.sql',import.meta.url),'utf8').match(/create function pjsdas_rows_internal\.commit_opportunity_staged[\s\S]*?end\$\$;/)![0]
  const normalized=staged
   .replace('pjsdas_rows_internal.commit_opportunity_staged(req jsonb,target_stage uuid,','pjsdas_rows_candidate.commit_opportunity(req jsonb,')
   .replace(' s pjsdas_rows_candidate.large_stage%rowtype; staged_result jsonb;\n','')
   .replaceAll('pjsdas_rows_internal.staged_changes(target_stage)',"jsonb_array_elements(req->'changes')")
   .replace(/\n -- Original lock order is grant -> workspace; stage is last, never before grant\.[\s\S]*?(?=\n if h.revision)/,'')
   .replace(' staged_result:=pjsdas_rows_internal.apply_staged_rows(req||',' return pjsdas_rows_internal.apply_rows(req||')
   .replace("jsonb_build_object('clientId',target_client_id),target_stage,jsonb_build_object","jsonb_build_object('clientId',target_client_id),jsonb_build_object")
   .replace("\n if staged_result->>'outcome' in ('COMMITTED','ALREADY_APPLIED') then update pjsdas_rows_candidate.large_stage set result=staged_result where id=s.id;end if;\n return staged_result;",'')
  expect(normalized).toBe(source)
  expect(staged.indexOf('for share')).toBeLessThan(staged.indexOf('head where'))
  expect(staged.indexOf('head where')).toBeLessThan(staged.indexOf('large_stage where'))
  const base=readFileSync(new URL('./sql/candidates/workspace-rows-stage-a.sql',import.meta.url),'utf8')
  expect(base).toContain("octet_length(req::text)>2097152")
  expect(base).toContain("jsonb_array_length(req->'changes')>2000")
 })
})

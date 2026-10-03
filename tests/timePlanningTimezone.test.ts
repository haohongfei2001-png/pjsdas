import { describe, expect, it } from 'vitest'
import { validPlanningTimezone, normalizePlanningTimezone, resolvePlanningTimezone, validateTimePlanningPreferences } from '../src/timePlanningPreferences.js'
import { createEmptyConsumerWorkspace } from '../src/consumerWorkspaceBootstrap.js'
import { diffCommandObjects, diffCommandFields, readModelInvalidation } from '../gateway/commandObjects.js'
import { diffWorkspaceDelta, applyWorkspaceDelta } from '../src/workspaceDelta.js'
import { createTransactionalWorkspaceSource } from '../gateway/transactionalWorkspaceSource.js'
import { localDateKey } from '../src/todayBrief.js'
const now=new Date('2026-10-02T00:30:00Z')
const empty=()=>createEmptyConsumerWorkspace({expectedAccountId:'00000000-0000-4000-8000-000000000001',action:'initialize_empty',commandId:'synthetic-timezone',timezone:'America/New_York',confirmStartEmpty:true},now)
describe('owner-selected planning timezone contract',()=>{
 it('validates IANA zones and preserves legacy fallback when preference is absent',()=>{
  for(const value of ['UTC','Etc/UTC','Asia/Shanghai','Europe/London','America/New_York'])expect(validPlanningTimezone(value)).toBe(true)
  for(const value of ['Mars/Unknown','+08:00','',null,{},'Europe/London '])expect(validPlanningTimezone(value)).toBe(false)
  expect(normalizePlanningTimezone('Europe/London')).toBe('Europe/London')
  expect(resolvePlanningTimezone(undefined,'Asia/Shanghai')).toBe('Asia/Shanghai')
  expect(resolvePlanningTimezone(empty().data.timePlanning,'UTC')).toBe('America/New_York')
 })
 it('invalid zones fail snapshot preference validation without reinterpreting instants',()=>{
  expect(validateTimePlanningPreferences({version:1,timezone:'Mars/Unknown',updatedAt:now.toISOString()})).toContain('Invalid planning timezone.')
  expect(localDateKey(now,'America/New_York')).toBe('2026-10-01')
  expect(localDateKey(now,'Asia/Shanghai')).toBe('2026-10-02')
  expect(now.toISOString()).toBe('2026-10-02T00:30:00.000Z')
 })
 it('tracks timezone as a conflict/invalidation object and carries it through deltas',()=>{
  const before=empty(),after=structuredClone(before);after.data.timePlanning!.timezone='Europe/London'
  const refs=diffCommandObjects(before,after)
  expect(refs).toContainEqual({type:'time_planning',id:'timezone'})
  expect(diffCommandFields(before,after,refs)).toContainEqual({type:'time_planning',id:'timezone',field:'*'})
  expect(readModelInvalidation(refs)).toEqual(['time_planning', 'time_preferences'])
  expect(applyWorkspaceDelta(before,diffWorkspaceDelta(before,after)).data.timePlanning?.timezone).toBe('Europe/London')
 })
 it('MCP source reads stored timezone ahead of its legacy fallback',async()=>{
  const snapshot=empty()
  const source=createTransactionalWorkspaceSource({userId:'synthetic-a',supabaseUrl:'https://fixture.invalid',serviceRoleKey:'synthetic',principalKind:'delegated_mcp',clientId:'synthetic-client',timezone:'Asia/Shanghai',fetchImpl:async()=>new Response(JSON.stringify([{id:'synthetic-ws',user_id:'synthetic-a',snapshot,revision:1,schema_version:4}]),{status:200})})
  expect((await source.read()).context.timezone).toBe('America/New_York')
 })
})

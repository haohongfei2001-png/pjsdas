import { afterEach, describe, expect, it, vi } from 'vitest'
import { withWorkspaceRowsRuntime } from '../gateway/workspaceRowsRuntime.js'
import * as staged from '../gateway/workspaceRowsStagedBridge.js'
const base={supabaseUrl:'https://synthetic.invalid',serviceRoleKey:'synthetic'}
const enabled={PJSDAS_WORKSPACE_ROWS_READS:'1',PJSDAS_WORKSPACE_ROWS_WRITES:'1',PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS:'1',PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES:'1',PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES:'1',PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:'compatible-pages-v1'}
afterEach(()=>vi.restoreAllMocks())
describe('R1p explicit page-new-admission release entry',()=>{
 it('selects page admission only after all original flags and the compiled server profile are explicit',()=>{
  const create=vi.spyOn(staged,'createWorkspaceRowsStagedBridge'),fetchImpl=vi.fn()
  const resolved=withWorkspaceRowsRuntime({...base,fetchImpl,rowLayoutWriter:undefined},{...enabled,PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT_ADMISSION:'0'})
  expect(create).toHaveBeenCalledWith(expect.objectContaining({auditAdmissionMode:'pages-v1',auditReadsEnabled:true,auditPagesEnabled:true,durableIntent:true,durableIntentAdmissionEnabled:false}))
  expect(resolved.rowLayoutWriter?.resumePrepared).toBeTypeOf('function');expect(fetchImpl).not.toHaveBeenCalled()
 })
 it('refuses page profile without original preloaded capabilities or with conflicting admission mode',()=>{
  for(const flag of ['PJSDAS_WORKSPACE_ROWS_STAGED_DOCUMENTS','PJSDAS_WORKSPACE_ROWS_DURABLE_INTENT','PJSDAS_WORKSPACE_ROWS_AUDIT_BYTES','PJSDAS_WORKSPACE_ROWS_AUDIT_PAGES'])
   expect(()=>withWorkspaceRowsRuntime(base,{...enabled,[flag]:'0'})).toThrow()
  expect(()=>withWorkspaceRowsRuntime(base,{...enabled,PJSDAS_WORKSPACE_ROWS_AUDIT_ADMISSION_MODE:'fragments-v1'})).toThrow('Conflicting server')
 })
 it('does not change default-off behavior or the unselected original flags mapping',()=>{
  const create=vi.spyOn(staged,'createWorkspaceRowsStagedBridge')
  expect(withWorkspaceRowsRuntime(base,{})).toBe(base);expect(create).not.toHaveBeenCalled()
  const {PJSDAS_WORKSPACE_ROWS_RELEASE_PROFILE:_profile,...flags}=enabled
  withWorkspaceRowsRuntime(base,flags)
  expect(create).toHaveBeenCalledWith(expect.objectContaining({auditAdmissionMode:undefined,auditReadsEnabled:true,auditPagesEnabled:true}))
 })
})

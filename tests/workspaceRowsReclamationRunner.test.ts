import { describe, expect, it, vi } from 'vitest'
import { finishReclamationRun } from './sql/reclamation/finish-run.mjs'

describe('reclamation evidence terminal fence', () => {
  it('writes PASS only after owned cleanup and frozen-source verification', async () => {
    const report = { status: 'RUNNING' }, order: string[] = []
    await finishReclamationRun({ report, close: async () => { order.push('cleanup'); expect(report.status).toBe('RUNNING') }, verifySource: () => { order.push('source'); expect(report.status).toBe('RUNNING') }, save: () => order.push(report.status) })
    expect(order).toEqual(['cleanup', 'source', 'PASS'])
  })
  it.each(['primary', 'cleanup', 'source', 'all'])('preserves %s failure and still attempts both finalizers', async failure => {
    const report = { status: 'RUNNING', cases: [{ status: 'PASS' }] }, saved: string[] = []
    const primary = new Error('primary'), cleanup = new Error('cleanup'), source = new Error('source')
    const close = vi.fn(async () => { if (failure === 'cleanup' || failure === 'all') throw cleanup })
    const verifySource = vi.fn(() => { if (failure === 'source' || failure === 'all') throw source })
    const primaryError = failure === 'primary' || failure === 'all' ? primary : undefined
    let caught: unknown
    try { await finishReclamationRun({ report, primaryError, close, verifySource, save: () => saved.push(report.status) }) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual(failure === 'all' ? [primary, cleanup, source] : [{ primary, cleanup, source }[failure as 'primary' | 'cleanup' | 'source']])
    expect(close).toHaveBeenCalledOnce(); expect(verifySource).toHaveBeenCalledOnce()
    expect(saved).toEqual(['FAIL']); expect(report.cases).toEqual([{ status: 'PASS' }])
  })
  it('does not turn failed evidence persistence into a successful exit', async () => {
    const report = { status: 'RUNNING' }, io = new Error('evidence I/O'), close = vi.fn(), verifySource = vi.fn()
    await expect(finishReclamationRun({ report, close, verifySource, save: () => { throw io } })).rejects.toMatchObject({ errors: [io] })
    expect(report.status).toBe('FAIL'); expect(close).toHaveBeenCalledOnce(); expect(verifySource).toHaveBeenCalledOnce()
  })
})

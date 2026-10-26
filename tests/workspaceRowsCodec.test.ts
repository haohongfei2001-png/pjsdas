import { describe, expect, it } from 'vitest'
import { decodeWorkspaceRows, diffReadableWorkspaceRows, diffWorkspaceRows, encodeWorkspaceRows } from '../gateway/workspaceRowsCodec'

describe('stage-A lossless row codec', () => {
  const base = () => ({ version: 4, exportedAt: '2030-01-01', extra: { a: null }, data: { opportunities: [{ id: 'a', unknown: { x: 1 } }, { id: 'b' }], timeline: [], extension: { untouched: true } } })
  it('preserves unknown fields, explicit null, order, missing collections and empty collections', () => {
    const value = base(); Object.defineProperty(value, '__proto__', { enumerable: true, value: { own: true } })
    expect(decodeWorkspaceRows(encodeWorkspaceRows(value))).toEqual(value)
  })
  it('records reorder, exportedAt, removal and presence changes unlike UI-only delta', () => {
    const before = base(), after = structuredClone(before); after.data.opportunities.reverse(); after.exportedAt = '2030-02-01'
    const delta = diffWorkspaceRows(before, after)
    expect(delta.changes).toHaveLength(2); expect(delta.afterEnvelope).not.toEqual(delta.beforeEnvelope)
    expect(decodeWorkspaceRows(encodeWorkspaceRows(after))).toEqual(after)
  })
  it('does not turn JSONB object key reordering into whole-workspace changes', () => {
    const left = { data: { opportunities: [{ id: 'a', company: 'Synthetic', extra: { x: 1, y: 2 } }] } }
    const right = { data: { opportunities: [{ extra: { y: 2, x: 1 }, company: 'Synthetic', id: 'a' }] } }
    expect(diffWorkspaceRows(left, right).changes).toEqual([])
  })
  it('only promises JSON-wire semantics for undefined', () => {
    const value = { absent: undefined, explicit: null, data: { opportunities: [{ id: 'a', absent: undefined, explicit: null }] } }
    expect(decodeWorkspaceRows(encodeWorkspaceRows(value))).toEqual(JSON.parse(JSON.stringify(value)))
  })
  it.each([1, '', null, undefined])('rejects invalid IDs on encode and decode (%s)', id => {
    expect(() => encodeWorkspaceRows({ data: { opportunities: [{ id }] } })).toThrow()
    const encoded = encodeWorkspaceRows(base()); (encoded.rows[0] as unknown as { id: unknown }).id = id; encoded.rows[0].value.id = id
    expect(() => decodeWorkspaceRows(encoded)).toThrow()
  })
  it('rejects missing/duplicate rows, ordinal gaps and malformed manifests', () => {
    const encoded = encodeWorkspaceRows(base())
    expect(() => decodeWorkspaceRows({ ...encoded, rows: encoded.rows.slice(1) })).toThrow()
    expect(() => decodeWorkspaceRows({ ...encoded, rows: [...encoded.rows, encoded.rows[0]] })).toThrow()
    const gap = structuredClone(encoded); gap.rows[1].ordinal = 4; expect(() => decodeWorkspaceRows(gap)).toThrow()
    expect(() => decodeWorkspaceRows({ ...encoded, manifest: [...encoded.manifest, { collection: null, count: 0 }] })).toThrow()
  })
})

describe('candidate write readability admission (not product quotas)', () => {
  const base = { version: 4, data: { timeline: [] } }
  it('rejects oversize headers and individual rows before constructing a write', () => {
    expect(() => diffReadableWorkspaceRows(base, { ...base, extra: 'x'.repeat(1_048_576) })).toThrow('WORKSPACE_ROWS_INVALID')
    expect(() => diffReadableWorkspaceRows(base, { version: 4, data: { timeline: [{ id: 'large', detail: 'x'.repeat(1_048_576) }] } })).toThrow('WORKSPACE_ROWS_INVALID')
  })
  it('accepts many individually bounded rows even when their first count-page exceeds a byte page', () => {
    const after = { version: 4, data: { timeline: Array.from({ length: 120 }, (_, i) => ({ id: String(i), detail: 'x'.repeat(10_000) })) } }
    expect(diffReadableWorkspaceRows(base, after)).toEqual(diffWorkspaceRows(base, after))
  })
  it('rejects total bytes and row counts that the bounded reader cannot complete', () => {
    expect(() => diffReadableWorkspaceRows(base, { version: 4, data: { timeline: Array.from({ length: 40 }, (_, i) => ({ id: String(i), detail: 'x'.repeat(900_000) })) } })).toThrow('WORKSPACE_ROWS_INVALID')
    expect(() => diffReadableWorkspaceRows(base, { version: 4, data: { timeline: Array.from({ length: 65_025 }, (_, i) => ({ id: String(i) })) } })).toThrow('WORKSPACE_ROWS_INVALID')
  })
})

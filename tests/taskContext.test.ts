import { describe, expect, it } from 'vitest'
import { hasRepeatedApplicationContext } from '../src/today/taskContext.js'

const item = { kind: 'apply' as const, opportunityId: 'synthetic-job', company: '示例公司', role: '产品经理', title: '投递 示例公司｜产品经理' }
describe('repeated application context', () => {
  it.each(['投递 示例公司｜产品经理', '投递 示例公司 | 产品经理', '投递 示例公司 · 产品经理', ' 投递  示例公司｜产品经理 '])('removes only the full repeated identity: %s', title => {
    expect(hasRepeatedApplicationContext({ ...item, title })).toBe(true)
  })
  it.each(['投递 产品经理', '投递 示例公司', '准备投递 示例公司｜产品经理', '投递 示例公司｜产品经理（补交资料）', '投递 示例公司｜产品经理助理', '联系 示例公司｜产品经理'])('keeps meaningful or incomplete context: %s', title => {
    expect(hasRepeatedApplicationContext({ ...item, title })).toBe(false)
  })
  it('keeps non-application and missing-identity task context', () => {
    expect(hasRepeatedApplicationContext({ ...item, kind: 'manual' })).toBe(false)
    expect(hasRepeatedApplicationContext({ ...item, role: undefined })).toBe(false)
    expect(hasRepeatedApplicationContext({ ...item, company: undefined })).toBe(false)
    expect(hasRepeatedApplicationContext({ ...item, opportunityId: undefined })).toBe(false)
  })
  it('does not discard punctuation within the actual company or role', () => {
    const nested = { ...item, company: '示例 A · B', role: '产品 | 校招' }
    expect(hasRepeatedApplicationContext({ ...nested, title: '投递 示例 A · B｜产品 | 校招' })).toBe(true)
    expect(hasRepeatedApplicationContext({ ...nested, title: '投递 示例 AB｜产品校招' })).toBe(false)
  })
})

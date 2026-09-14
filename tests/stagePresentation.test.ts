import { describe, expect, it } from 'vitest'
import { presentStageLabel } from '../src/stagePresentation.js'

describe('recruiting stage presentation', () => {
  it('translates canonical stored Chinese labels in English UI', () => {
    expect(presentStageLabel('screening', '筛选中', 'en')).toBe('Screening')
    expect(presentStageLabel('closed', '流程结束', 'en')).toBe('Closed')
    expect(presentStageLabel('not_applied', '待投', 'en')).toBe('Not applied')
  })

  it('preserves custom process wording instead of inventing a translation', () => {
    expect(presentStageLabel('interview', '终面 with VP', 'en')).toBe('终面 with VP')
  })

  it('keeps stored wording in Chinese UI and falls back to the canonical stage when absent', () => {
    expect(presentStageLabel('assessment', '在线测评', 'zh')).toBe('在线测评')
    expect(presentStageLabel('written_test', undefined, 'zh')).toBe('笔试')
    expect(presentStageLabel('written_test', undefined, 'en')).toBe('Written test')
  })
})

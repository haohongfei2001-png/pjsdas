import { describe, expect, it } from 'vitest'
import { readWebPlanningTime } from '../src/webPlanningTime.js'

const receivedAt = '2026-09-21T00:00:00Z'
describe('finite Web preparation-time boundary', () => {
  it.each(['事项：整理面试材料', '待办：修改论文图表。', '事项：整理材料并提交', '整理2027届申请材料', '准备第3轮材料'])('keeps untimed task text without a clock dependency: %s', text => {
    expect(readWebPlanningTime(text, receivedAt)).toEqual({ kind: 'untimed' })
    expect(readWebPlanningTime(text, receivedAt, 'Unknown/Zone')).toEqual({ kind: 'untimed' })
  })
  it.each([
    ['今天修改论文图表', 'date_only', '2026-09-21'],
    ['事项：2026年9月25日准备材料', 'date_only', '2026-09-25'],
    ['2026-09-25 14:30 准备材料', 'fixed_range', '2026-09-25'],
    ['明天 15:00 准备材料', 'fixed_range', '2026-09-22'],
    ['下周一 15时30分整理材料', 'fixed_range', '2026-09-28'],
    ['tomorrow 15:00 prepare materials', 'fixed_range', '2026-09-22'],
  ])('resolves only represented date/clock prefix: %s', (text, shape, date) => {
    for (const timezone of ['UTC', 'Asia/Shanghai']) {
      const result = readWebPlanningTime(text, receivedAt, timezone)
      expect(result.kind).toBe('resolved')
      if (result.kind !== 'resolved') throw new Error('Expected resolved time')
      expect(result.temporal).toMatchObject({ shape, timezone })
      expect(result.temporal.date ?? result.temporal.startAt?.slice(0, 10)).toBe(date)
      expect(result.temporal.endAt).toBeUndefined()
    }
  })
  it.each([
    '事项：3天后整理材料', '事项：今晚整理材料', '事项：2026.10.18整理材料',
    '明早准备材料', '下个月整理材料', '周末准备材料', '三点准备材料',
    'tomorrow 3pm prepare materials', 'in 3 days prepare materials',
    '2026年2月30日准备材料', '2026-09-25 25:30准备材料',
    '明天上午准备材料', '明天15:00-16:00准备材料', '明天15:00 ET准备材料',
    '明天15:00 UTC+09:00准备材料', '明天15:00准备明天面试材料',
    '明天15:00准备材料 PST', '明天15:00准备材料，按美国时间', '明天15:00准备材料 America/New_York',
    '准备材料，明天15:00',
  ])('keeps unsupported calendar, duration, qualifier or placement unresolved: %s', text => {
    for (const timezone of [undefined, 'UTC', 'Asia/Shanghai']) {
      expect(readWebPlanningTime(text, receivedAt, timezone)).toEqual({ kind: 'unresolved' })
    }
  })
  it.each([undefined, '', 'Unknown/Zone'])('never uses host time for a scheduled task with zone %s', timezone => {
    expect(readWebPlanningTime('明天15:00准备材料', receivedAt, timezone)).toEqual({ kind: 'unresolved' })
  })
  it.each(['2026-03-08 02:30准备材料', '2026-11-01 01:30准备材料'])('does not guess DST gaps/folds: %s', text => {
    expect(readWebPlanningTime(text, receivedAt, 'America/New_York')).toEqual({ kind: 'unresolved' })
  })
})

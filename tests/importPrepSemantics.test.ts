import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePJSDASWorkbook } from '../src/importExcelV2.js'
import {
  isWaitingPrepStatus,
  prepPriorityBand,
  prepPriorityWeights,
  prepSourceState,
  presentPrepPriority,
  presentPrepSourceState,
} from '../src/prepSemantics.js'

function sheet(rows: unknown[][]) {
  return XLSX.utils.aoa_to_sheet(rows)
}

function prepWorkbook(): File {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet([['岗位ID']]), '投递总表')
  XLSX.utils.book_append_sheet(workbook, sheet([['岗位ID']]), '岗位详情')
  XLSX.utils.book_append_sheet(workbook, sheet([['公司']]), '在途流程')
  XLSX.utils.book_append_sheet(
    workbook,
    sheet([
      ['能力包', '触发岗位/申请组', '当前优先级', '最近节点', '本周最小产出', '预计投入', '触发/降级规则', '状态'],
      ['中文等待', null, '最高', null, null, '30min', null, '等待触发'],
      ['英文等待', null, 'Highest', null, null, '30min', null, 'Waiting'],
      ['中文进行中', null, '高', null, null, '30min', null, '进行中'],
      ['英文进行中', null, 'Medium-high', null, null, '30min', null, 'Active'],
    ]),
    '准备中心',
  )
  XLSX.utils.book_append_sheet(workbook, sheet([['申请组ID']]), '申请组')

  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return {
    name: 'prep-semantics.xlsx',
    arrayBuffer: async () => bytes,
  } as File
}

describe('Prep canonical semantics', () => {
  it('normalizes source-state and priority aliases without changing presentation facts', () => {
    expect(prepSourceState('等待触发')).toBe('waiting')
    expect(prepSourceState('Waiting')).toBe('waiting')
    expect(isWaitingPrepStatus('pending trigger')).toBe(true)
    expect(prepSourceState('Active')).toBe('active')
    expect(prepPriorityBand('中高')).toBe('medium_high')
    expect(prepPriorityBand('Medium-high')).toBe('medium_high')
    expect(prepPriorityWeights('Highest')).toEqual({ leverage: 96, delayCost: 78 })
    expect(presentPrepPriority('Highest', true)).toBe('最高')
    expect(presentPrepPriority('中高', false)).toBe('Medium-high')
    expect(presentPrepSourceState('Waiting', true)).toBe('等待触发')
    expect(presentPrepSourceState('进行中', false)).toBe('Active')
  })

  it('never activates waiting Prep and maps English/Chinese priority labels to the same action semantics', async () => {
    const bundle = await parsePJSDASWorkbook(prepWorkbook())

    expect(bundle.prep.map((item) => [item.title, item.priorityLabel, item.sourceStatus])).toEqual([
      ['中文等待', '最高', '等待触发'],
      ['英文等待', 'Highest', 'Waiting'],
      ['中文进行中', '高', '进行中'],
      ['英文进行中', 'Medium-high', 'Active'],
    ])

    const prepActions = bundle.actions.filter((item) => item.kind === 'prep')
    expect(prepActions.map((item) => item.prepId)).toEqual([
      'prep:中文进行中',
      'prep:英文进行中',
    ])
    expect(prepActions.map((item) => [item.leverage, item.delayCost])).toEqual([
      [88, 64],
      [80, 52],
    ])
  })
})

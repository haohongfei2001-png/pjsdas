import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePJSDASWorkbook } from '../src/importExcelV2.js'

function sheet(rows: unknown[][]) {
  return XLSX.utils.aoa_to_sheet(rows)
}

function workbookWithPendingVariants(): File {
  const workbook = XLSX.utils.book_new()
  const header = ['岗位ID', '公司', '具体岗位', '当前阶段', '机会角色', '抢先', '截止/保守节点', 'P级', 'Offer成功率', '年包参考', '下一动作', '准备耗时', '申请组ID', '名额状态', '序']
  const variants: Array<[string, string | null]> = [
    ['A-1', '待投'],
    ['A-2', '待投递'],
    ['A-3', '未投递'],
    ['A-4', 'Not applied'],
    ['A-5', null],
  ]

  XLSX.utils.book_append_sheet(
    workbook,
    sheet([
      header,
      ...variants.map(([id, stage], index) => [
        id,
        '测试公司',
        `岗位 ${index + 1}`,
        stage,
        '核心',
        '否',
        '2030-09-20',
        'P2',
        '中高',
        '未知',
        '投递',
        '30min',
        null,
        null,
        index + 1,
      ]),
    ]),
    '投递总表',
  )
  XLSX.utils.book_append_sheet(workbook, sheet([['岗位ID']]), '岗位详情')
  XLSX.utils.book_append_sheet(workbook, sheet([['公司']]), '在途流程')
  XLSX.utils.book_append_sheet(workbook, sheet([['能力包']]), '准备中心')
  XLSX.utils.book_append_sheet(workbook, sheet([['申请组ID']]), '申请组')

  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return {
    name: 'pending-variants.xlsx',
    arrayBuffer: async () => bytes,
  } as File
}

describe('Excel importer canonical pending stage semantics', () => {
  it('normalizes pending label variants and generates apply actions from canonical processStage', async () => {
    const bundle = await parsePJSDASWorkbook(workbookWithPendingVariants())

    expect(bundle.opportunities).toHaveLength(5)
    expect(bundle.opportunities.map((item) => item.processStage)).toEqual([
      'not_applied',
      'not_applied',
      'not_applied',
      'not_applied',
      'not_applied',
    ])
    expect(bundle.opportunities.map((item) => item.currentStageLabel)).toEqual([
      '待投',
      '待投递',
      '未投递',
      'Not applied',
      '待投',
    ])
    expect(bundle.summary.pending).toBe(5)
    expect(bundle.actions.filter((item) => item.kind === 'apply')).toHaveLength(5)
  })
})

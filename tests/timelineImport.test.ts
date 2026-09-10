import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePJSDASWorkbook } from '../src/importExcelV2'

function sheet(rows: unknown[][]) { return XLSX.utils.aoa_to_sheet(rows) }

function syntheticHistoryFile(): File {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet([
    ['岗位ID', '公司', '具体岗位', '当前阶段', '机会角色', '抢先'],
    ['J27-001', '测试公司', '产品经理', '筛选中', '核心', '否'],
  ]), '投递总表')
  XLSX.utils.book_append_sheet(workbook, sheet([['岗位ID'], ['J27-001']]), '岗位详情')
  XLSX.utils.book_append_sheet(workbook, sheet([['公司']]), '在途流程')
  XLSX.utils.book_append_sheet(workbook, sheet([['能力包']]), '准备中心')
  XLSX.utils.book_append_sheet(workbook, sheet([['申请组ID']]), '申请组')
  XLSX.utils.book_append_sheet(workbook, sheet([
    ['说明'],
    ['日期', '类型', '关联岗位', '事件', '结果'],
    ['2026-08-14', '投递', 'J27-001｜测试公司｜产品经理', '完成测试公司产品经理投递。', '已投。'],
    ['2026-08-16', '笔试/测评', 'J27-001｜测试公司｜产品经理', '完成在线测评。', '测评完成。'],
  ]), '秋招经历')
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return { name: 'history.xlsx', arrayBuffer: async () => bytes } as File
}

describe('Excel Timeline import', () => {
  it('imports 秋招经历 into Timeline without generating tasks from it', async () => {
    const bundle = await parsePJSDASWorkbook(syntheticHistoryFile())
    expect(bundle.timeline).toHaveLength(2)
    expect(bundle.timeline?.[0]).toMatchObject({ kind: 'history_imported', opportunityId: 'J27-001' })
    expect(bundle.actions).toHaveLength(0)
  })
})

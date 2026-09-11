import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parsePJSDASWorkbook } from '../src/importExcelV2.js'

function sheet(rows: unknown[][]) {
  return XLSX.utils.aoa_to_sheet(rows)
}

function syntheticFile(): File {
  const workbook = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(
    workbook,
    sheet([
      ['岗位ID', '公司', '具体岗位', '当前阶段', '机会角色', '抢先', '截止/保守节点', 'P级', 'Offer成功率', '年包参考', '下一动作', '准备耗时', '申请组ID', '名额状态', '序'],
      ['A-1', '测试公司', '产品经理', '待投', '核心', '否', '2030-09-20', 'P2', '中高', '未知', '择优投递', '30min', 'GROUP-1', '1/2', 1],
      ['A-2', '测试公司', '战略分析', '待投', '冲刺', '否', '2030-09-21', 'P2', '中', '未知', '择优投递', '30min', 'GROUP-1', '1/2', 2],
    ]),
    '投递总表',
  )

  XLSX.utils.book_append_sheet(
    workbook,
    sheet([
      ['岗位ID'],
      ['A-1'],
      ['A-2'],
    ]),
    '岗位详情',
  )

  XLSX.utils.book_append_sheet(workbook, sheet([['公司']]), '在途流程')
  XLSX.utils.book_append_sheet(workbook, sheet([['能力包']]), '准备中心')

  XLSX.utils.book_append_sheet(
    workbook,
    sheet([
      ['申请组ID', '公司/项目', '覆盖岗位', '名额规则', '总名额', '已用', '剩余', '当前排序/首选', '是否锁定', '下一动作', '备注'],
      ['GROUP-1', '测试公司', '产品经理；战略分析', '最多1岗', 1, 0, 1, '产品经理 > 战略分析', '否', '先比较两岗，只提交一个', '0/1'],
    ]),
    '申请组',
  )

  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return {
    name: 'synthetic.xlsx',
    arrayBuffer: async () => bytes,
  } as File
}

describe('Excel importer application-group constraints', () => {
  it('collapses competing pending opportunities into one group decision', async () => {
    const bundle = await parsePJSDASWorkbook(syntheticFile())

    expect(bundle.opportunities).toHaveLength(2)
    expect(bundle.applicationGroups).toHaveLength(1)
    expect(bundle.actions.filter((item) => item.kind === 'apply')).toHaveLength(0)

    const groupActions = bundle.actions.filter((item) => item.kind === 'group_decision')
    expect(groupActions).toHaveLength(1)
    expect(groupActions[0].applicationGroupId).toBe('GROUP-1')
    expect(groupActions[0].title).toContain('先比较两岗，只提交一个')
    expect(groupActions[0].dueAt).toBeTruthy()
  })
})

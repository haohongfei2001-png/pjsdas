import type { ProcessEventType } from './model.js'
import type { ProgressOperation } from './progressUpdate.js'
import type { UiLanguage } from './uiLanguage.js'

const eventLabelsEn: Record<ProcessEventType, string> = {
  assessment_invite: 'Assessment',
  written_test_invite: 'Written test',
  interview_invite: 'Interview',
  offer: 'Offer',
  rejection: 'Process closed',
  status_update: 'Status update',
  other: 'Other progress',
}

export function progressOperationSummaryForLanguage(operation: ProgressOperation, lang: UiLanguage) {
  if (lang === 'zh') {
    switch (operation.kind) {
      case 'upsert_opportunity':
        return `${operation.mode === 'submitted' ? '已投递/流程开启' : '计划投递'}：${operation.company}｜${operation.role}`
      case 'close_opportunity':
        return `结束流程：${operation.company}｜${operation.role}`
      case 'rename_opportunity':
        return `修改岗位：${operation.company}｜${operation.oldRole} → ${operation.newRole}`
      case 'process_event': {
        const labels: Record<ProcessEventType, string> = {
          assessment_invite: '测评',
          written_test_invite: '笔试',
          interview_invite: '面试',
          offer: 'Offer',
          rejection: '流程结束',
          status_update: '状态更新',
          other: '其他进展',
        }
        return `流程事件：${operation.company}｜${operation.role} · ${labels[operation.eventType]}${operation.completed ? ' · 已完成' : ''}${operation.dueAt ? ` · ${new Date(operation.dueAt).toLocaleString('zh-CN')}` : ''}`
      }
      case 'manual_action':
        return `新增待办：${operation.title}`
      case 'ignored':
        return `无需写入：${operation.reason}`
      case 'unresolved':
        return `待确认：${operation.reason}`
    }
  }

  switch (operation.kind) {
    case 'upsert_opportunity':
      return `${operation.mode === 'submitted' ? 'Application submitted / process started' : 'Planned application'}: ${operation.company} | ${operation.role}`
    case 'close_opportunity':
      return `Close process: ${operation.company} | ${operation.role}`
    case 'rename_opportunity':
      return `Rename role: ${operation.company} | ${operation.oldRole} → ${operation.newRole}`
    case 'process_event':
      return `Process event: ${operation.company} | ${operation.role} · ${eventLabelsEn[operation.eventType]}${operation.completed ? ' · completed' : ''}${operation.dueAt ? ` · ${new Date(operation.dueAt).toLocaleString('en-GB')}` : ''}`
    case 'manual_action':
      return `Add task: ${operation.title}`
    case 'ignored':
      return 'No workspace change required'
    case 'unresolved':
      return 'Needs confirmation'
  }
}

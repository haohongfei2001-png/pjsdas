export type PrepSourceState = 'waiting' | 'active' | 'completed' | 'paused' | 'unknown'
export type PrepPriorityBand = 'highest' | 'high' | 'medium_high' | 'medium' | 'low' | 'unknown'

function normalized(value: string | undefined) {
  return (value ?? '').trim().toLocaleLowerCase().replace(/[\s_-]+/g, '')
}

export function prepSourceState(value: string | undefined): PrepSourceState {
  const key = normalized(value)
  if (!key) return 'unknown'
  if (['等待触发', 'waiting', 'waitingfortrigger', 'pendingtrigger'].includes(key)) return 'waiting'
  if (['active', '已激活', '进行中', 'doing', 'inprogress'].includes(key)) return 'active'
  if (['done', 'completed', 'complete', '已完成'].includes(key)) return 'completed'
  if (['paused', 'pause', '暂停'].includes(key)) return 'paused'
  return 'unknown'
}

export function isWaitingPrepStatus(value: string | undefined) {
  return prepSourceState(value) === 'waiting'
}

export function prepPriorityBand(value: string | undefined): PrepPriorityBand {
  const key = normalized(value)
  if (!key) return 'unknown'
  if (['最高', 'highest', 'top'].includes(key)) return 'highest'
  if (['高', 'high'].includes(key)) return 'high'
  if (['中高', 'mediumhigh', 'midhigh'].includes(key)) return 'medium_high'
  if (['中', 'medium', 'mid'].includes(key)) return 'medium'
  if (['低', 'low'].includes(key)) return 'low'
  return 'unknown'
}

export function prepPriorityWeights(value: string | undefined) {
  switch (prepPriorityBand(value)) {
    case 'highest': return { leverage: 96, delayCost: 78 }
    case 'high': return { leverage: 88, delayCost: 64 }
    case 'medium_high': return { leverage: 80, delayCost: 52 }
    case 'medium': return { leverage: 68, delayCost: 40 }
    case 'low':
    case 'unknown':
      return { leverage: 45, delayCost: 24 }
  }
}

export function prepPriorityRank(value: string | undefined) {
  const rank: Record<PrepPriorityBand, number> = {
    highest: 0,
    high: 1,
    medium_high: 2,
    medium: 3,
    low: 4,
    unknown: 5,
  }
  return rank[prepPriorityBand(value)]
}

export function presentPrepPriority(value: string | undefined, zh: boolean) {
  const band = prepPriorityBand(value)
  const labels: Record<Exclude<PrepPriorityBand, 'unknown'>, [string, string]> = {
    highest: ['最高', 'Highest'],
    high: ['高', 'High'],
    medium_high: ['中高', 'Medium-high'],
    medium: ['中', 'Medium'],
    low: ['低', 'Low'],
  }
  if (band === 'unknown') return value || (zh ? '未设置' : 'Not set')
  return labels[band][zh ? 0 : 1]
}

export function presentPrepSourceState(value: string | undefined, zh: boolean) {
  const state = prepSourceState(value)
  const labels: Record<Exclude<PrepSourceState, 'unknown'>, [string, string]> = {
    waiting: ['等待触发', 'Waiting'],
    active: ['进行中', 'Active'],
    completed: ['已完成', 'Completed'],
    paused: ['暂停', 'Paused'],
  }
  if (state === 'unknown') return value || (zh ? '状态未知' : 'Unknown status')
  return labels[state][zh ? 0 : 1]
}

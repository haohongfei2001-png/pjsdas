import type { ImportBundle } from './model.js'

function text(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function parseMinutes(value: unknown, fallback = 30) {
  const raw = text(value).toLowerCase().replace(/\s+/g, '')
  if (!raw || raw === '—') return fallback

  const minuteRange = raw.match(/(\d+(?:\.\d+)?)[–—-](\d+(?:\.\d+)?)min/)
  if (minuteRange) return Math.round((Number(minuteRange[1]) + Number(minuteRange[2])) / 2)

  const minuteMax = raw.match(/[≤<](\d+(?:\.\d+)?)min/)
  if (minuteMax) return Math.round(Number(minuteMax[1]))

  const minutes = raw.match(/(\d+(?:\.\d+)?)min/)
  if (minutes) return Math.round(Number(minutes[1]))

  const hourRange = raw.match(/(\d+(?:\.\d+)?)[–—-](\d+(?:\.\d+)?)h/)
  if (hourRange) return Math.round(((Number(hourRange[1]) + Number(hourRange[2])) / 2) * 60)

  const hours = raw.match(/(\d+(?:\.\d+)?)h/)
  if (hours) return Math.round(Number(hours[1]) * 60)

  return fallback
}

export async function parsePJSDASWorkbook(file: File): Promise<ImportBundle> {
  const importer = await import('./importExcelHeavy.js')
  return importer.parsePJSDASWorkbook(file)
}

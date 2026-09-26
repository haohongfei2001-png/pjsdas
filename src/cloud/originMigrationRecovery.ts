import { validateSnapshot, type PJSDASSnapshot } from '../snapshot.js'
import { fingerprintWorkspace } from './workspaceFingerprint.js'

export interface OriginMigrationRecoveryBundle {
  schema: 'pjsdas-origin-migration-recovery'
  version: 1
  createdAt: string
  origin: string
  selectedSource: 'local' | 'drive' | 'reconciled'
  selectedFingerprint: string
  local: PJSDASSnapshot
  drive: PJSDASSnapshot | null
}

export function createOriginMigrationRecoveryBundle(input: {
  origin: string
  selectedSource: OriginMigrationRecoveryBundle['selectedSource']
  selectedFingerprint: string
  local: PJSDASSnapshot
  drive?: PJSDASSnapshot
  createdAt?: string
}): OriginMigrationRecoveryBundle {
  validateSnapshot(input.local)
  if (input.drive) validateSnapshot(input.drive)
  if (!input.origin.trim()) throw new Error('Migration recovery origin is required.')
  if (!input.selectedFingerprint.trim()) throw new Error('Migration recovery fingerprint is required.')
  if (input.selectedSource === 'drive' && !input.drive) {
    throw new Error('Drive-selected migration recovery requires a Drive snapshot.')
  }
  return {
    schema: 'pjsdas-origin-migration-recovery',
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    origin: input.origin,
    selectedSource: input.selectedSource,
    selectedFingerprint: input.selectedFingerprint,
    local: input.local,
    drive: input.drive ?? null,
  }
}

export async function parseOriginMigrationRecoveryText(text: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('无法解析迁移恢复文件：JSON 格式无效。')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('迁移恢复文件根对象无效。')
  }
  const raw = parsed as Partial<OriginMigrationRecoveryBundle>
  if (raw.schema !== 'pjsdas-origin-migration-recovery' || raw.version !== 1) {
    throw new Error('这不是受支持的 TodayAction 域名迁移恢复文件。')
  }
  if (!raw.createdAt || Number.isNaN(new Date(raw.createdAt).getTime())) {
    throw new Error('迁移恢复文件 createdAt 无效。')
  }
  if (!raw.origin?.trim() || !raw.selectedFingerprint?.trim()) {
    throw new Error('迁移恢复文件身份字段不完整。')
  }
  if (!['local', 'drive', 'reconciled'].includes(String(raw.selectedSource))) {
    throw new Error('迁移恢复文件 selectedSource 无效。')
  }
  validateSnapshot(raw.local)
  if (raw.drive !== null && raw.drive !== undefined) validateSnapshot(raw.drive)

  const source = raw.selectedSource as OriginMigrationRecoveryBundle['selectedSource']
  const recoverySnapshot = source === 'drive' ? raw.drive : raw.local
  if (!recoverySnapshot) throw new Error('迁移恢复文件缺少选定的 Drive 快照。')
  const fingerprint = await fingerprintWorkspace(recoverySnapshot)
  if (fingerprint !== raw.selectedFingerprint) {
    throw new Error('迁移恢复文件 fingerprint 与选定快照不一致；文件可能已被修改。')
  }

  return {
    bundle: raw as OriginMigrationRecoveryBundle,
    recoverySnapshot,
  }
}

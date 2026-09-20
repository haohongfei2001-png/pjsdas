import type { CloudSyncOutcome } from './cloudSync.js'

export type SyncNow = () => Promise<CloudSyncOutcome | undefined>

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

export async function ensureAuthoritativePersistence(
  connected: boolean,
  syncNow: SyncNow,
  options: { attempts?: number; intervalMs?: number } = {},
) {
  if (!connected) return undefined
  const attempts = options.attempts ?? 12
  const intervalMs = options.intervalMs ?? 150

  for (let index = 0; index < attempts; index += 1) {
    const result = await syncNow()
    if (!result) {
      await sleep(intervalMs)
      continue
    }
    if (result.kind === 'pushed' || result.kind === 'synced' || result.kind === 'created') return result
    if (result.kind === 'conflict') {
      throw new Error('工作区出现同步冲突。当前改动已暂存在本机，但在解决冲突前不会显示为已可靠保存。')
    }
    if (result.kind === 'account_mismatch') {
      throw new Error('当前浏览器工作区属于另一个账号；为避免写错账户，远端保存已停止。')
    }
    if (result.kind === 'pulled') {
      throw new Error('同步期间远端状态覆盖了本地状态；请重新确认刚才的操作。')
    }
  }
  throw new Error('工作区同步仍在进行。当前改动已暂存在本机，但尚未确认写入权威工作区。')
}

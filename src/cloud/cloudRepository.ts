import type { PJSDASSnapshot } from '../snapshot'
import { getCloudClient } from './cloudClient'

export interface RemoteWorkspaceRow {
  userId: string
  revision: number
  schemaVersion: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  updatedByDevice: string
  updatedAt: string
}

type RawRemoteRow = {
  user_id: string
  revision: number | string
  schema_version: number | string
  fingerprint: string
  snapshot: PJSDASSnapshot
  updated_by_device: string
  updated_at: string
}

function client() {
  const value = getCloudClient()
  if (!value) throw new Error('云端尚未配置。')
  return value
}

function normalize(row: RawRemoteRow): RemoteWorkspaceRow {
  return {
    userId: row.user_id,
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    fingerprint: row.fingerprint,
    snapshot: row.snapshot,
    updatedByDevice: row.updated_by_device,
    updatedAt: row.updated_at,
  }
}

const selectFields = 'user_id,revision,schema_version,fingerprint,snapshot,updated_by_device,updated_at'

export async function fetchRemoteWorkspace(userId: string): Promise<RemoteWorkspaceRow | null> {
  const { data, error } = await client()
    .from('pjsdas_workspaces')
    .select(selectFields)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`读取云端工作区失败：${error.message}`)
  return data ? normalize(data as RawRemoteRow) : null
}

export async function createRemoteWorkspace(input: {
  userId: string
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  const now = new Date().toISOString()
  const { data, error } = await client()
    .from('pjsdas_workspaces')
    .insert({
      user_id: input.userId,
      revision: 1,
      schema_version: 1,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      updated_by_device: input.deviceId,
      updated_at: now,
    })
    .select(selectFields)
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return null
    throw new Error(`创建云端工作区失败：${error.message}`)
  }
  return data ? normalize(data as RawRemoteRow) : null
}

export async function updateRemoteWorkspace(input: {
  userId: string
  expectedRevision: number
  fingerprint: string
  snapshot: PJSDASSnapshot
  deviceId: string
}): Promise<RemoteWorkspaceRow | null> {
  const nextRevision = input.expectedRevision + 1
  const { data, error } = await client()
    .from('pjsdas_workspaces')
    .update({
      revision: nextRevision,
      schema_version: 1,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      updated_by_device: input.deviceId,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', input.userId)
    .eq('revision', input.expectedRevision)
    .select(selectFields)
    .maybeSingle()
  if (error) throw new Error(`写入云端工作区失败：${error.message}`)
  return data ? normalize(data as RawRemoteRow) : null
}

import { fetchBackend } from './backendEndpoints.js'
import { getAccountAccessToken } from './cloud/cloudClient.js'

export interface AudienceStatus {
  authenticated: boolean
  allowed: boolean
  mode: 'legacy' | 'allowlist'
  role: 'owner' | 'beta' | 'legacy' | null
  email?: string | null
  reason?: string
}

export async function fetchAudienceStatus(): Promise<AudienceStatus> {
  const response = await fetchBackend('/api/access', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await getAccountAccessToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'read' }),
  })
  const body = await response.json().catch(() => undefined) as AudienceStatus | { message?: string } | undefined
  if (!response.ok) {
    throw new Error(body && 'message' in body && body.message ? body.message : `TodayAction audience status failed (HTTP ${response.status}).`)
  }
  return body as AudienceStatus
}

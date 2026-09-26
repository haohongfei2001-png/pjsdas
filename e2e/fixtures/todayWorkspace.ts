import type { BrowserContext, Route } from '@playwright/test'
import { upgradeSnapshotToLatest, type PJSDASSnapshot } from '../../src/snapshot.js'
export const AUTH_KEY = 'sb-yyrzwpoxlxpafdlbkdtg-auth-token'
export const BACKEND = 'https://pjsdas-remote-alpha.vercel.app'

export function session(accountKey: string, token: string) {
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 31_536_000,
    expires_at: Math.floor(Date.now() / 1000) + 31_536_000,
    refresh_token: `refresh-${token}`,
    user: {
      id: accountKey,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${accountKey}@example.test`,
      email_confirmed_at: '2026-09-23T00:00:00.000Z',
      phone: '',
      confirmed_at: '2026-09-23T00:00:00.000Z',
      last_sign_in_at: '2026-09-23T00:00:00.000Z',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { sub: accountKey, full_name: accountKey },
      identities: [],
      created_at: '2026-09-23T00:00:00.000Z',
      updated_at: '2026-09-23T00:00:00.000Z',
      is_anonymous: false,
    },
  }
}

export async function seedSession(context: BrowserContext, accountKey = 'account-a', token = 'token-a') {
  await context.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, { key: AUTH_KEY, value: session(accountKey, token) })
}

export function opportunity(id: string, company: string, role: string) {
  return {
    id,
    company,
    role,
    currentStageLabel: '待投递',
    processStage: 'not_applied' as const,
    roleType: 'core' as const,
    participationStatus: 'active' as const,
    early: false,
    opportunityValue: 80,
    fitScore: 80,
    assessmentStatus: 'unassessed' as const,
    locallyManaged: true,
    importedAt: '2026-09-23T00:00:00.000Z',
  }
}

export function action(id: string, title: string, opportunityId?: string, leverage = 70) {
  return {
    id,
    kind: 'manual' as const,
    title,
    opportunityId,
    estimatedMinutes: 20,
    leverage,
    delayCost: leverage,
    status: 'todo' as const,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  }
}

export function workspace(): PJSDASSnapshot {
  return upgradeSnapshotToLatest({
    schema: 'pjsdas-local-snapshot',
    version: 1,
    exportedAt: '2026-09-23T00:00:00.000Z',
    data: {
      opportunities: [
        opportunity('A-opp-1', 'A公司', '产品经理'),
        opportunity('A-opp-2', '第二公司', '策略产品'),
      ],
      processes: [],
      processEvents: [],
      actions: [
        action('A-action-1', 'A第一任务', 'A-opp-1', 86),
        action('A-action-2', 'A第二任务', 'A-opp-2', 60),
      ],
      prep: [],
      applicationGroups: [],
      semanticReceipts: [],
      timeline: [],
    },
  })
}

export function health() {
  return {
    status: 'ok',
    version: '1.10.0-alpha.1',
    mode: 'transactional-connected',
    workspaceAuthority: 'transactional',
    capabilities: { deploymentPortability: true },
  }
}

export function cors(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}


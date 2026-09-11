import { verifySignedProposalToken } from '../gateway/proposalToken.js'

const ALLOWED_ORIGINS = [
  'https://haohongfei2001-png.github.io',
  'http://localhost:5173',
]

function cors(origin: string | null) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    vary: 'Origin',
  })
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-headers', 'content-type')
    headers.set('access-control-allow-methods', 'POST, OPTIONS')
  }
  return headers
}

function json(status: number, body: unknown, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) })
}

export default {
  async fetch(request: Request) {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: !origin || ALLOWED_ORIGINS.includes(origin) ? 204 : 403,
        headers: cors(origin),
      })
    }
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' }, origin)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'This origin cannot review PJSDAS proposals.' }, origin)

    const signingKey = process.env.PJSDAS_TOKEN_ENCRYPTION_KEY?.trim() ?? ''
    if (!signingKey) return json(503, { code: 'PROPOSAL_VERIFY_UNAVAILABLE', message: 'PJSDAS proposal verification is not configured.' }, origin)

    let token = ''
    try {
      const body = await request.json() as { token?: unknown }
      token = typeof body.token === 'string' ? body.token.trim() : ''
    } catch {
      return json(400, { code: 'INVALID_ARGUMENT', message: 'Proposal verification body must be valid JSON.' }, origin)
    }
    if (!token) return json(400, { code: 'INVALID_ARGUMENT', message: 'Proposal token is required.' }, origin)

    try {
      const proposal = await verifySignedProposalToken(token, signingKey)
      return json(200, { status: 'verified', proposal }, origin)
    } catch (caught) {
      return json(400, {
        code: 'PROPOSAL_INVALID',
        message: caught instanceof Error ? caught.message : 'PJSDAS proposal verification failed.',
      }, origin)
    }
  },
}

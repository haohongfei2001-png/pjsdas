type Check = {
  module: string
  ok: boolean
  errorName?: string
  errorMessage?: string
}

async function check(module: string, load: () => Promise<unknown>): Promise<Check> {
  try {
    await load()
    return { module, ok: true }
  } catch (caught) {
    return {
      module,
      ok: false,
      errorName: caught instanceof Error ? caught.name : 'UnknownError',
      errorMessage: caught instanceof Error ? caught.message : String(caught),
    }
  }
}

export default {
  async fetch() {
    const checks: Check[] = []
    checks.push(await check('supabaseIdentity', () => import('../gateway/supabaseIdentity.js')))
    checks.push(await check('serverFactory', () => import('../gateway/serverFactory.js')))
    checks.push(await check('tokenCrypto', () => import('../gateway/tokenCrypto.js')))
    checks.push(await check('driveWorkspaceSource', () => import('../gateway/driveWorkspaceSource.js')))
    checks.push(await check('authenticatedDriveSource', () => import('../gateway/authenticatedDriveSource.js')))
    checks.push(await check('authenticatedRemoteHttp', () => import('../gateway/authenticatedRemoteHttp.js')))

    return new Response(JSON.stringify({ checks }), {
      status: checks.every((item) => item.ok) ? 200 : 500,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  },
}

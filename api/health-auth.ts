function configured(name: string) {
  return Boolean(process.env[name]?.trim())
}

export default {
  fetch() {
    const secretsConfigured = {
      tokenEncryptionKey: configured('PJSDAS_TOKEN_ENCRYPTION_KEY'),
      googleClientId: configured('PJSDAS_GOOGLE_CLIENT_ID'),
      googleClientSecret: configured('PJSDAS_GOOGLE_CLIENT_SECRET'),
    }
    const ready = Object.values(secretsConfigured).every(Boolean)

    return new Response(JSON.stringify({
      service: 'pjsdas-authenticated-mcp',
      mode: 'google-drive-readonly',
      auth: 'supabase-oauth-2.1',
      secretsConfigured,
      ready,
    }), {
      status: ready ? 200 : 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  },
}

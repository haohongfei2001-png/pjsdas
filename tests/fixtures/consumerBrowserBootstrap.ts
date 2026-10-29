/** Serialized by Playwright; no imports or closure state inside this function. */
export function installConsumerBrowserBootstrap(input: { origin: string; authKey: string; session: unknown }) {
  // context.newPage first creates an opaque about:blank document. Never read
  // storage or crypto there, or on any origin outside this synthetic fixture.
  if (window.location.origin !== input.origin) return
  window.localStorage.setItem(input.authKey, JSON.stringify(input.session))
  const key = 'pjsdas-google-drive-sync-state-v2'
  if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, JSON.stringify({
    version: 2, deviceId: window.crypto.randomUUID(), autoSync: false, accounts: {},
  }))
}

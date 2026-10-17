import { request, type APIRequestContext } from '@playwright/test'
import { MOCK_PROXY } from './mockCloudProxySetup.mjs'
type Options = NonNullable<Parameters<typeof request.newContext>[0]>
const methods = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'])

/** A wrapper around public API methods, never a patched browser object. */
export function noRedirectApiContext(context: APIRequestContext): APIRequestContext {
  return new Proxy(context, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof key === 'string' && methods.has(key) && typeof value === 'function') return (url: unknown, options: Record<string, unknown> = {}) => {
        if (options.maxRedirects !== undefined && options.maxRedirects !== 0) throw new Error('Mock API requests cannot follow redirects; inspect the response explicitly.')
        return Reflect.apply(value, target, [url, { ...options, maxRedirects: 0 }])
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
export async function createMockApiRequest(options: Omit<Options, 'proxy' | 'maxRedirects'> = {}) {
  if ('proxy' in options || 'maxRedirects' in options) throw new Error('Mock API transport settings cannot be overridden.')
  return noRedirectApiContext(await request.newContext({ ...options, proxy: MOCK_PROXY, maxRedirects: 0 }))
}

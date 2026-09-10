export interface CloudConfig {
  url: string
  publishableKey: string
}

export function readCloudConfig(): CloudConfig | null {
  const env = import.meta.env as Record<string, string | undefined>
  const url = (env.VITE_SUPABASE_URL ?? '').trim()
  const publishableKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !publishableKey) return null
  return { url, publishableKey }
}

export function cloudRedirectUrl() {
  if (typeof window === 'undefined') return ''
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString()
}

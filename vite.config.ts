import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export function resolveViteBase(
  environment: Record<string, string | undefined> = process.env,
) {
  const configured = environment.PJSDAS_VITE_BASE?.trim()
  if (configured) {
    if (!configured.startsWith('/') || !configured.endsWith('/')) {
      throw new Error('PJSDAS_VITE_BASE must be an absolute path ending with /.')
    }
    return configured
  }

  return environment.VERCEL === '1' ? '/' : '/pjsdas/'
}

export default defineConfig({
  plugins: [react()],
  base: resolveViteBase(),
})

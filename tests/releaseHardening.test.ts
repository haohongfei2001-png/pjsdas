import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const importer = readFileSync(new URL('../src/importExcelV2.ts', import.meta.url), 'utf8')
const heavyImporter = readFileSync(new URL('../src/importExcelHeavy.ts', import.meta.url), 'utf8')
const aiAccess = readFileSync(new URL('../src/aiAccess/AiAccessContext.tsx', import.meta.url), 'utf8')
const consent = readFileSync(new URL('../src/aiAccess/OAuthConsentPage.tsx', import.meta.url), 'utf8')
const heavyConsent = readFileSync(new URL('../src/aiAccess/OAuthConsentPageHeavy.tsx', import.meta.url), 'utf8')
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const smoke = readFileSync(new URL('../.github/workflows/v13-production-smoke.yml', import.meta.url), 'utf8')

describe('v1.8 release hardening', () => {
  it('keeps XLSX out of the eager Excel API module', () => {
    expect(importer).not.toContain("from 'xlsx'")
    expect(importer).toContain("import('./importExcelHeavy.js')")
    expect(heavyImporter).toContain("from 'xlsx'")
  })

  it('keeps Supabase off the ordinary startup path', () => {
    expect(aiAccess).not.toContain("from './supabaseClient.js'")
    expect(aiAccess).toContain("import('./supabaseClient.js')")
    expect(consent).toContain("import('./OAuthConsentPageHeavy.js')")
    expect(heavyConsent).toContain("from './supabaseClient.js'")
  })

  it('uses current Node-runtime GitHub actions in every project workflow', () => {
    for (const workflow of [ci, pages, smoke]) {
      expect(workflow).toContain('actions/checkout@v7')
      expect(workflow).toContain('actions/setup-node@v7')
      expect(workflow).not.toContain('actions/checkout@v4')
      expect(workflow).not.toContain('actions/setup-node@v4')
    }
  })

  it('keeps Pages deployment reproducible from package-lock', () => {
    expect(pages).toContain('npm ci')
    expect(pages).not.toContain('npm install')
  })
})

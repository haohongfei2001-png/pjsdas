import React from 'react'
import { createRoot } from 'react-dom/client'
import CoverageIndicatorHeavy from '../../src/CoverageIndicatorHeavy.js'
import { restoreLocalSnapshot } from '../../src/db.js'
import type { PJSDASSnapshot } from '../../src/snapshot.js'
import { UiLanguageProvider } from '../../src/uiLanguage.js'

/** Browser integration harness only; this does not add a product route. */
export async function mount(snapshot?: PJSDASSnapshot) {
  if (snapshot) await restoreLocalSnapshot(snapshot)
  localStorage.setItem('pjsdas-ui-language', 'en')
  const host = document.createElement('div')
  host.id = 'r02-coverage-browser-harness'
  document.body.append(host)
  createRoot(host).render(React.createElement(UiLanguageProvider, null, React.createElement(CoverageIndicatorHeavy)))
}

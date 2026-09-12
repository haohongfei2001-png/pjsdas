import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV8.js'
import FixedEventGuard from './FixedEventGuard.js'
import { UiLanguageProvider } from './uiLanguage.js'
import { CloudProvider } from './cloud/CloudContext.js'
import { AiAccessProvider } from './aiAccess/AiAccessContext.js'
import McpProposalReview from './aiAccess/McpProposalReview.js'
import OAuthConsentPage from './aiAccess/OAuthConsentPage.js'
import './styles.css'
import './designSystem.css'
import './visualPolish.css'
import './usabilityFriction.css'

function Root() {
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision((value) => value + 1)
  useEffect(() => {
    const handleWorkspaceReplace = () => setRevision((value) => value + 1)
    window.addEventListener('pjsdas:workspace-replaced', handleWorkspaceReplace)
    return () => window.removeEventListener('pjsdas:workspace-replaced', handleWorkspaceReplace)
  }, [])
  return (
    <>
      <App key={revision} />
      <FixedEventGuard key={`fixed-${revision}`} onChanged={refresh} />
    </>
  )
}

function Entry() {
  const authorizationId = typeof window !== 'undefined'
    ? new URL(window.location.href).searchParams.get('authorization_id')
    : null

  if (authorizationId) return <OAuthConsentPage />

  return (
    <CloudProvider>
      <AiAccessProvider>
        <McpProposalReview />
        <Root />
      </AiAccessProvider>
    </CloudProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiLanguageProvider>
      <Entry />
    </UiLanguageProvider>
  </StrictMode>,
)

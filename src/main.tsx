import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV8.js'
import { UiLanguageProvider } from './uiLanguage.js'
import { CloudProvider, useCloud } from './cloud/CloudContext.js'
import { AiAccessProvider } from './aiAccess/AiAccessContext.js'
import McpProposalReview from './aiAccess/McpProposalReview.js'
import OAuthConsentPage from './aiAccess/OAuthConsentPage.js'
import './styles.css'
import './designSystem.css'
import './visualPolish.css'
import './usabilityFriction.css'
import './productTruth.css'

function Root() {
  return <App />
}

function CloudReadyMcpProposalReview() {
  const cloud = useCloud()
  if (cloud.loading) return null
  return <McpProposalReview />
}

function Entry() {
  const authorizationId = typeof window !== 'undefined'
    ? new URL(window.location.href).searchParams.get('authorization_id')
    : null

  if (authorizationId) return <OAuthConsentPage />

  return (
    <CloudProvider>
      <AiAccessProvider>
        <CloudReadyMcpProposalReview />
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

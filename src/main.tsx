import ScopedManagementConsentPage from './aiAccess/ScopedManagementConsentPage.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV8.js'
import { RootErrorBoundary } from './StartupRecovery.js'
import { UiLanguageProvider } from './uiLanguage.js'
import { CloudProvider, useCloud } from './cloud/CloudContext.js'
import { AiAccessProvider } from './aiAccess/AiAccessContext.js'
import McpProposalReview from './aiAccess/McpProposalReview.js'
import OAuthConsentPage from './aiAccess/OAuthConsentPage.js'
import ReviewerSignInPage from './aiAccess/ReviewerSignInPage.js'
import OwnerManagementConsentPage from './aiAccess/OwnerManagementConsentPage.js'
import './styles.css'
import './designSystem.css'
import './visualPolish.css'
import './usabilityFriction.css'
import './productTruth.css'
import './secondarySurfaces.css'

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
  if (typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('reviewer_login') === '1') return <ReviewerSignInPage />
  if (typeof window !== 'undefined' && (new URL(window.location.href).searchParams.get('scoped_access') === '1' || new URL(window.location.href).searchParams.get('connect') === '1')) return <ScopedManagementConsentPage />
  if (typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('manage_access') === '1') return <OwnerManagementConsentPage />

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
    <RootErrorBoundary>
      <UiLanguageProvider>
        <Entry />
      </UiLanguageProvider>
    </RootErrorBoundary>
  </StrictMode>,
)

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV5'
import FixedEventGuard from './FixedEventGuard'
import LocalBackupDock from './LocalBackupDock'
import ProcessEventDock from './ProcessEventDock'
import ProgressInbox from './ProgressInbox'
import { UiLanguageProvider } from './uiLanguage'
import { CloudProvider } from './cloud/CloudContext'
import { AiAccessProvider } from './aiAccess/AiAccessContext'
import OAuthConsentPage from './aiAccess/OAuthConsentPage'
import './styles.css'
import './designSystem.css'

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
      <ProgressInbox onChanged={refresh} />
      <ProcessEventDock onChanged={refresh} />
      <LocalBackupDock onChanged={refresh} />
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

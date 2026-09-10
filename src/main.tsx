import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV5'
import FixedEventGuard from './FixedEventGuard'
import LocalBackupDock from './LocalBackupDock'
import ProcessEventDock from './ProcessEventDock'
import ProgressInbox from './ProgressInbox'
import { UiLanguageProvider } from './uiLanguage'
import './styles.css'
import './designSystem.css'

function Root() {
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision((value) => value + 1)
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiLanguageProvider>
      <Root />
    </UiLanguageProvider>
  </StrictMode>,
)

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV5'
import FixedEventGuard from './FixedEventGuard'
import ProcessEventDock from './ProcessEventDock'
import './styles.css'

function Root() {
  const [revision, setRevision] = useState(0)
  const refresh = () => setRevision((value) => value + 1)
  return (
    <>
      <App key={revision} />
      <ProcessEventDock onChanged={refresh} />
      <FixedEventGuard key={`fixed-${revision}`} onChanged={refresh} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

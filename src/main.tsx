import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './AppV4'
import ProcessEventDock from './ProcessEventDock'
import './styles.css'

function Root() {
  const [revision, setRevision] = useState(0)
  return (
    <>
      <App key={revision} />
      <ProcessEventDock onChanged={() => setRevision((value) => value + 1)} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)

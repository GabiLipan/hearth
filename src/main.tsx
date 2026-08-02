import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { initSession } from './lib/session'

// Nothing is seeded, migrated or de-duplicated here any more. The old boot
// chain ran migrateIdsToUuid → ensureDefaults → dedupeSyncedData →
// autoPostDueBills BEFORE the first pull, which is precisely why a fresh device
// could recreate categories the other person had deleted and win the merge.
// This device now knows nothing until the server tells it.
void initSession()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)

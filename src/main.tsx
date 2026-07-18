import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { ensureDefaults, migrateIdsToUuid } from './lib/db'
import { autoPostDueBills } from './lib/bills'
import { initSync } from './lib/sync'

void migrateIdsToUuid()
  .then(ensureDefaults)
  .then(autoPostDueBills)
  .then(initSync)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)

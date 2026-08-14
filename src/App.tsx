import { Routes, Route } from 'react-router-dom'
import { AppProvider } from './state/AppContext'
import { AuthGate } from './components/AuthGate'
import { Layout } from './components/Layout'
import { Toaster } from './components/toast'
import { ConfirmHost } from './components/confirm'
import Dashboard from './pages/Dashboard'
import Activity from './pages/Activity'
import Budgets from './pages/Budgets'
import Bills from './pages/Bills'
import Goals from './pages/Goals'
import Reports from './pages/Reports'
import SettingsPage, { SettingsGroupPage } from './pages/Settings'
import RulesPage from './pages/Rules'

export default function App() {
  return (
    <AppProvider>
      {/* Outside `AuthGate`, so the sign-in screens can raise one too — and
          outside `Layout`, because both portal to `<body>` and neither should
          be unmounted by a page change. */}
      <Toaster />
      <ConfirmHost />
      <AuthGate>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/budgets" element={<Budgets />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Static beats dynamic in React Router's ranking, so `rules`
                keeps its own page whichever order these two are written in. */}
            <Route path="/settings/rules" element={<RulesPage />} />
            <Route path="/settings/:group" element={<SettingsGroupPage />} />
          </Routes>
        </Layout>
      </AuthGate>
    </AppProvider>
  )
}

import { Routes, Route } from 'react-router-dom'
import { AppProvider } from './state/AppContext'
import { Layout } from './components/Layout'
import Dashboard from './pages/Dashboard'
import Activity from './pages/Activity'
import Budgets from './pages/Budgets'
import Bills from './pages/Bills'
import Reports from './pages/Reports'
import SettingsPage from './pages/Settings'

export default function App() {
  return (
    <AppProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout>
    </AppProvider>
  )
}

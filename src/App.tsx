import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { resolveBackground } from './lib/modalRoute'
import { dismissSplash } from './lib/splash'
import { AppProvider } from './state/AppContext'
import { AuthGate } from './components/AuthGate'
import { useWide } from './components/ui'
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
  /**
   * The boot splash comes off here, and here is the whole of the condition:
   * something has painted. A passive effect runs after the first commit has
   * reached the screen, so by the time this fires there is an app behind the
   * fireplace — whichever branch of `AuthGate` it turned out to be. Anything
   * further down would be waiting on the network. See `lib/splash.ts`.
   */
  useEffect(dismissSplash, [])

  /**
   * Settings is presented over the page you were on, so these routes have to go
   * on rendering that page while the address bar says `/settings`. That is what
   * keeps it mounted — and therefore what makes closing the modal give you back
   * the scroll position rather than the top of a rebuilt page.
   *
   * `Layout` renders the settings routes themselves, because the control that
   * closes them is the disc in its header. When there is no background — a cold
   * load straight onto `/settings`, or the app shortcut — nothing here changes
   * and Settings is an ordinary page, which on a phone looks the same anyway.
   */
  const location = useLocation()
  // Phone only. A wide screen has the sidebar, so Settings is a page like any
  // other there — and the X that closes the modal lives in a header that is
  // `md:hidden`, so presenting one above `md` would be a layer nothing could
  // dismiss. An iPad Mini crosses that breakpoint on rotation, which is exactly
  // how you would find out. `resolveBackground` is still CALLED either way, so
  // its memory of the subtree cannot go stale while the window is wide.
  const wide = useWide()
  const background = wide ? undefined : resolveBackground(location)

  return (
    <AppProvider>
      {/* Outside `AuthGate`, so the sign-in screens can raise one too — and
          outside `Layout`, because both portal to `<body>` and neither should
          be unmounted by a page change. */}
      <Toaster />
      <ConfirmHost />
      <AuthGate>
        <Layout>
          <Routes location={background ?? location}>
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

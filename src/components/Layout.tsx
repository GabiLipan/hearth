import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Home, Receipt, PiggyBank, CalendarClock, ChartPie, Settings, Plus, CloudOff, AlertTriangle } from 'lucide-react'
import { useSyncState } from '../hooks/useSync'
import { cx } from './ui'
import { BrandMark } from './BrandMark'
import { TransactionForm } from './TransactionForm'

const NAV = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/activity', label: 'Activity', icon: Receipt },
  { to: '/budgets', label: 'Budgets', icon: PiggyBank },
  { to: '/bills', label: 'Bills', icon: CalendarClock },
  { to: '/reports', label: 'Reports', icon: ChartPie },
]

const TITLES: Record<string, string> = {
  '/': 'Home',
  '/activity': 'Activity',
  '/budgets': 'Budgets',
  '/bills': 'Bills',
  '/reports': 'Reports',
  '/settings': 'Settings',
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <BrandMark size={30} className="drop-shadow-sm" />
      <span className="text-lg font-bold tracking-tight">Hearth</span>
    </div>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const [addOpen, setAddOpen] = useState(false)
  const { pathname } = useLocation()
  const title = TITLES[pathname] ?? 'Hearth'

  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop / iPad sidebar. Sticky (not fixed) so it takes part in the flex
          row — main then simply fills whatever width is left, at any viewport. */}
      <aside className="sticky top-0 z-40 hidden h-dvh w-52 shrink-0 flex-col gap-0.5 self-start border-r border-hairline bg-surface p-2.5 md:flex xl:w-56">
        <div className="mb-4 mt-1">
          <Logo />
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="mb-2.5 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-accent-ink transition hover:brightness-110"
        >
          <Plus size={16} /> Add transaction
        </button>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
                isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
              )
            }
          >
            <Icon size={17} strokeWidth={2} />
            {label}
          </NavLink>
        ))}
        <div className="flex-1" />
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
              isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
            )
          }
        >
          <Settings size={17} />
          Settings
        </NavLink>
      </aside>

      {/* Mobile top bar */}
      <header className="pt-safe sticky top-0 z-30 border-b border-hairline bg-page/80 backdrop-blur-md md:hidden">
        <div className="flex h-13 items-center justify-between px-4 py-2.5">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          <NavLink
            to="/settings"
            aria-label="Settings"
            className={({ isActive }) =>
              cx('grid size-9 place-items-center rounded-full', isActive ? 'bg-surface-2 text-ink' : 'text-ink-2')
            }
          >
            <Settings size={20} />
          </NavLink>
        </div>
      </header>

      <SyncBanner />

      {/* Content — fills every pixel the sidebar leaves, at any viewport width.
          Pages decide their own column counts from there. */}
      <main className="w-full min-w-0 flex-1 px-4 pb-32 pt-4 md:px-5 md:pb-8 md:pt-4 xl:px-6">
        {/* Desktop page title. Mobile gets the same title in its top bar. */}
        <h1 className="mb-3 hidden text-xl font-bold tracking-tight md:block">{title}</h1>
        {children}
      </main>

      {/* Mobile FAB */}
      <button
        onClick={() => setAddOpen(true)}
        aria-label="Add transaction"
        className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 z-40 grid size-14 place-items-center rounded-2xl bg-accent text-accent-ink shadow-lg shadow-accent/30 transition active:scale-95 md:hidden"
      >
        <Plus size={26} />
      </button>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-surface/90 backdrop-blur-md md:hidden">
        <div className="pb-safe flex">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cx(
                  'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                  isActive ? 'text-accent' : 'text-ink-3',
                )
              }
            >
              <Icon size={22} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      <TransactionForm open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}

/**
 * Says out loud when the app is not in step with the server.
 *
 * Deliberately a persistent strip rather than a toast: a write usually fails
 * while offline, minutes after the phone was put down, and a message that
 * disappears after three seconds is a message nobody sees. Silence here is what
 * "my change vanished" feels like from the inside.
 */
function SyncBanner() {
  const { online, pending, deadLetters } = useSyncState()
  if (deadLetters === 0 && (online || pending === 0)) return null

  const failed = deadLetters > 0
  return (
    <div
      className={cx(
        'flex items-center gap-2 px-4 py-2 text-sm md:px-5',
        failed ? 'bg-critical/10 text-critical-text' : 'bg-surface-2 text-ink-2',
      )}
    >
      {failed ? <AlertTriangle size={15} className="shrink-0" /> : <CloudOff size={15} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">
        {failed
          ? `${deadLetters} change${deadLetters === 1 ? '' : 's'} couldn\u2019t be saved`
          : `Offline — ${pending} change${pending === 1 ? '' : 's'} will go up when you reconnect`}
      </span>
      {failed && (
        <NavLink to="/settings" className="shrink-0 font-medium underline underline-offset-2">
          Review
        </NavLink>
      )}
    </div>
  )
}

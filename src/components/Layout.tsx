import { useState, type MouseEvent, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Home, Receipt, PiggyBank, CalendarClock, ChartPie, Settings, Plus, CloudOff, AlertTriangle,
  PanelLeftClose, PanelLeftOpen, Target,
} from 'lucide-react'
import { useSyncState } from '../hooks/useSync'
import { cx, originOf, type Origin } from './ui'
import { BrandMark } from './BrandMark'
import { TransactionForm } from './TransactionForm'

const NAV = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/activity', label: 'Activity', icon: Receipt },
  { to: '/budgets', label: 'Budgets', icon: PiggyBank },
  { to: '/bills', label: 'Bills', icon: CalendarClock },
  { to: '/goals', label: 'Goals', icon: Target },
  { to: '/reports', label: 'Reports', icon: ChartPie },
]

const TITLES: Record<string, string> = {
  '/': 'Home',
  '/activity': 'Activity',
  '/budgets': 'Budgets',
  '/bills': 'Bills',
  '/goals': 'Goals',
  '/reports': 'Reports',
  '/settings': 'Settings',
}

/**
 * Whether the desktop sidebar is collapsed to icons.
 *
 * Read synchronously from localStorage rather than restored in an effect, so
 * the rail never paints wide and then snaps narrow on load. It is a property of
 * this screen, not of the household, so it stays device-local and unsynced —
 * the same reasoning as the theme.
 */
const COLLAPSED_KEY = 'hearth-sidebar-collapsed'
const readCollapsed = () => localStorage.getItem(COLLAPSED_KEY) === '1'

/**
 * Where a page sits in the tab order, so a page change can travel the way the
 * tap did. Settings isn't a tab; it lives off the end, to the right, which is
 * also where its button sits in the mobile top bar.
 */
const tabIndex = (path: string) => {
  const i = NAV.findIndex((n) => n.to === path)
  return i === -1 ? NAV.length : i
}

export function Layout({ children }: { children: ReactNode }) {
  const [addOpen, setAddOpen] = useState(false)
  const [addOrigin, setAddOrigin] = useState<Origin | undefined>()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { pathname } = useLocation()
  const title = TITLES[pathname] ?? 'Hearth'

  // Which way the page travels on arrival. Derived during render rather than in
  // an effect: the animation has to be on the very first frame of the new page,
  // and an effect only runs after it has already painted in place.
  const [nav, setNav] = useState({ path: pathname, dir: 0 })
  if (nav.path !== pathname) {
    setNav({ path: pathname, dir: tabIndex(pathname) > tabIndex(nav.path) ? 1 : -1 })
  }

  // The sheet grows out of whichever control was pressed — the FAB on a phone,
  // the sidebar button on a desktop.
  function openAdd(e: MouseEvent<HTMLButtonElement>) {
    setAddOrigin(originOf(e))
    setAddOpen(true)
  }

  function toggleSidebar() {
    setCollapsed((was) => {
      const next = !was
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }

  // Collapsed items lose their visible label, so the accessible name has to come
  // from somewhere — `title` also gives a native tooltip on hover.
  const navItem = (isActive: boolean) =>
    cx(
      'flex items-center rounded-lg py-1.5 text-sm font-medium transition-colors',
      collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
      isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
    )

  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop / iPad sidebar. Sticky (not fixed) so it takes part in the flex
          row — main then simply fills whatever width is left, at any viewport. */}
      <aside
        className={cx(
          'sticky top-0 z-40 hidden h-dvh shrink-0 flex-col gap-0.5 self-start border-r border-hairline bg-surface p-2.5 md:flex',
          'transition-[width] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'w-[3.75rem] items-stretch' : 'w-52 xl:w-56',
        )}
      >
        <div className={cx('mb-4 mt-1 flex items-center', collapsed ? 'flex-col gap-2' : 'justify-between gap-1 px-2')}>
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark size={30} className="shrink-0 drop-shadow-sm" />
            {!collapsed && <span className="truncate text-lg font-bold tracking-tight">Hearth</span>}
          </div>
          <button
            onClick={toggleSidebar}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <button
          onClick={openAdd}
          title={collapsed ? 'Add transaction' : undefined}
          aria-label="Add transaction"
          className={cx(
            'mb-2.5 inline-flex h-9 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition hover:brightness-110',
            !collapsed && 'gap-2',
          )}
        >
          <Plus size={16} />
          {!collapsed && 'Add transaction'}
        </button>

        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={collapsed ? label : undefined}
            className={({ isActive }) => navItem(isActive)}
          >
            <Icon size={17} strokeWidth={2} className="shrink-0" />
            {!collapsed && label}
          </NavLink>
        ))}

        <div className="flex-1" />

        <NavLink to="/settings" title={collapsed ? 'Settings' : undefined} className={({ isActive }) => navItem(isActive)}>
          <Settings size={17} className="shrink-0" />
          {!collapsed && 'Settings'}
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
        {/* Keyed on the path so the animation restarts on every page change:
            re-running one means a new element, not a re-applied class. */}
        <div
          key={pathname}
          className={nav.dir === 0 ? 'animate-page' : nav.dir > 0 ? 'animate-page-forward' : 'animate-page-back'}
        >
          {children}
        </div>
      </main>

      {/* Mobile FAB. It withdraws while the sheet is open, so the sheet reads as
          the button itself having opened up rather than as something covering it. */}
      <button
        onClick={openAdd}
        aria-label="Add transaction"
        aria-expanded={addOpen}
        className={cx(
          'fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 z-40 grid size-14 place-items-center',
          'rounded-2xl bg-accent text-accent-ink shadow-lg shadow-accent/30 md:hidden',
          'transition duration-200 ease-out active:scale-95 motion-reduce:transition-none',
          addOpen && 'pointer-events-none scale-50 opacity-0',
        )}
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
              {({ isActive }) => (
                <>
                  {/* The class arrives with the active state, and adding an
                      animation class to a live element is what starts it. */}
                  <Icon size={22} strokeWidth={2} className={isActive ? 'animate-tab' : undefined} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <TransactionForm open={addOpen} onClose={() => setAddOpen(false)} origin={addOrigin} />
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

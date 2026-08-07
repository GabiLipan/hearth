import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import {
  Home, Receipt, PiggyBank, CalendarClock, ChartPie, Settings, Plus, CloudOff, AlertTriangle,
  PanelLeftClose, PanelLeftOpen, Target,
} from 'lucide-react'
import { useSyncState } from '../hooks/useSync'
import { cx, useViewportInset } from './ui'
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
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { pathname } = useLocation()
  const title = TITLES[pathname] ?? 'Hearth'
  // Zero unless iOS has anchored `bottom: 0` above the bottom of the screen.
  const { below } = useViewportInset()
  const toScreenBottom = below ? { transform: `translateY(${below}px)` } : undefined

  // Which way the page travels on arrival. Derived during render rather than in
  // an effect: the animation has to be on the very first frame of the new page,
  // and an effect only runs after it has already painted in place.
  const [nav, setNav] = useState({ path: pathname, dir: 0 })
  if (nav.path !== pathname) {
    setNav({ path: pathname, dir: tabIndex(pathname) > tabIndex(nav.path) ? 1 : -1 })
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
          onClick={() => setAddOpen(true)}
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
      {/* `max-md:overflow-x-clip` catches the sideways travel of a page change.
          On a phone this element is exactly the width of the viewport, so it
          clips where the viewport would have — and unlike the same rule on
          <html>, it does not propagate to the viewport and take the fixed tab
          bar's positioning with it. Desktop needs no clip: its page padding is
          wider than the travel, and nothing there is full-bleed. */}
      <main className="w-full min-w-0 flex-1 px-4 pb-32 pt-4 max-md:overflow-x-clip md:px-5 md:pb-8 md:pt-4 xl:px-6">
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
        onClick={() => setAddOpen(true)}
        aria-label="Add transaction"
        aria-expanded={addOpen}
        style={toScreenBottom}
        className={cx(
          'fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 z-40 grid size-14 place-items-center',
          'rounded-2xl bg-accent text-accent-ink shadow-lg shadow-accent/30 md:hidden',
          // Named properties rather than `transition`: the bottom-of-screen
          // correction above is a `transform`, and it has to land at once
          // rather than easing into place.
          'transition-[scale,opacity] duration-200 ease-out active:scale-95 motion-reduce:transition-none',
          addOpen && 'pointer-events-none scale-50 opacity-0',
        )}
      >
        <Plus size={26} />
      </button>

      <BottomTabs pathname={pathname} style={toScreenBottom} />

      <TransactionForm open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}

const TAB_MS = 460
/** Damped: overshoots by a few per cent and settles, so the pill lands with weight. */
const TAB_SPRING = 'cubic-bezier(0.33, 1.35, 0.5, 1)'
/**
 * How far the pill is drawn outside the tab it belongs to.
 *
 * The room around the icon and its label is drawn, not laid out: the tabs are
 * spread across the bar, so padding them enough for the pill to breathe would
 * push the whole row wider rather than fatten the pill. Painting it a few
 * pixels larger than its tab costs the layout nothing.
 */
const PILL_BLEED = 5

/**
 * The mobile tab bar: icons alone, and the current one opened into a pill with
 * its name in it.
 *
 * The pill is a single element that travels, not a background that blinks on
 * whichever tab you tapped — and the labels are what push the tabs around as
 * they open and close, so where the pill is *going* isn't known until those
 * widths have settled. Hence the order in `place`: read where everything
 * actually is, put the labels at the widths they are heading for, read the
 * geometry *that* produces, and only then animate between the two. Measuring
 * first and animating second is the whole reason the pill lands on the tab.
 *
 * The alternative — a CSS transition on the pill, retargeted as the labels grow
 * — restarts on every frame of the label animation, so the pill never gets far
 * enough into its curve to overshoot and just drifts to a halt.
 */
function BottomTabs({ pathname, style }: { pathname: string; style?: CSSProperties }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)

  const place = (animate: boolean) => {
    const wrap = wrapRef.current
    const pill = pillRef.current
    if (!wrap || !pill) return
    const active = wrap.querySelector<HTMLElement>('[data-tab="active"]')
    // Nothing to measure while the bar is display:none on a desktop width.
    if (!active || !active.offsetWidth) return
    const labels = [...wrap.querySelectorAll<HTMLElement>('[data-label]')]

    // 1. Where things are *at this instant*. Tapping a third tab while the
    //    second is still travelling has to pick the journey up from wherever
    //    it got to, so every starting value is read from the live geometry
    //    rather than remembered from the last transition — a remembered target
    //    is a place the pill may never have reached.
    const origin = wrap.getBoundingClientRect().left
    const pillNow = pill.getBoundingClientRect()
    const from = placed.current ? { left: pillNow.left - origin, width: pillNow.width } : null
    const was = labels.map((el) => el.getBoundingClientRect().width)
    // The inner span is `w-max`, so its width is the natural width of the text
    // even while the label around it is clipped to nothing.
    const goes = labels.map((el) =>
      el.dataset.label === 'on' ? (el.firstElementChild as HTMLElement).getBoundingClientRect().width : 0,
    )

    // 2. Stop everything still running. Until this happens the animations own
    //    these properties and the resting widths written below would have no
    //    effect on the layout — which would make the measurement in step 4 a
    //    reading of the *old* transition, mid-flight.
    labels.forEach((el) => el.getAnimations().forEach((a) => a.cancel()))
    pill.getAnimations().forEach((a) => a.cancel())

    // 3. The resting state — `auto` rather than the pixels just measured, so a
    //    font arriving late or the text changing still leaves the label the
    //    right size. Everything after this is decoration over a layout that is
    //    already correct: the animations carry no `fill`, so however they end,
    //    this is what the bar goes back to. Which matters more than it sounds,
    //    because a finish event is never delivered while the app is in the
    //    background — an animation left holding the final value would strand
    //    the bar mid-transition.
    labels.forEach((el, i) => {
      el.style.width = goes[i] ? 'auto' : '0px'
    })

    // 4. Now the geometry means something.
    const to = { left: active.offsetLeft, width: active.offsetWidth }
    pill.style.left = `${to.left - PILL_BLEED}px`
    pill.style.width = `${to.width + PILL_BLEED * 2}px`
    pill.style.opacity = '1'
    placed.current = true

    if (!animate || !from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    labels.forEach((el, i) => {
      if (Math.abs(was[i] - goes[i]) < 0.5) return
      el.animate([{ width: `${was[i]}px` }, { width: `${goes[i]}px` }], {
        duration: TAB_MS,
        easing: TAB_SPRING,
      })
    })

    pill.animate(
      [
        { left: `${from.left}px`, width: `${from.width}px` },
        { left: `${to.left - PILL_BLEED}px`, width: `${to.width + PILL_BLEED * 2}px` },
      ],
      { duration: TAB_MS, easing: TAB_SPRING },
    )
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => place(true), [pathname])

  // A rotation, or the bar appearing at all when a window narrows past the
  // breakpoint, moves everything without changing the route.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(() => {
      // Re-measuring mid-flight would fight the animation for the same values.
      if (pillRef.current?.getAnimations().length) return
      place(false)
    })
    observer.observe(wrap)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <nav
      style={style}
      className={cx(
        'pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-surface/90 backdrop-blur-md md:hidden',
        // iOS does not always hand a standalone app a viewport that reaches the
        // bottom of the screen, and a bar anchored to a viewport that stops
        // short leaves a bare strip of page below it. Continuing the bar's own
        // surface past its bottom edge costs nothing when the viewport is right
        // — it is off-screen — and turns that strip into more of the bar when
        // it isn't.
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-32 after:bg-surface/90 after:content-['']",
      )}
    >
      <div ref={wrapRef} className="relative flex items-center justify-between px-2 py-1.5">
        <span
          ref={pillRef}
          aria-hidden
          className="pointer-events-none absolute inset-y-1 rounded-full bg-accent/12 opacity-0"
        />
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)
          return (
            <Link
              key={to}
              to={to}
              data-tab={active ? 'active' : 'idle'}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              className={cx(
                'relative z-10 flex items-center rounded-full px-2 py-2.5 font-medium transition-colors',
                // Six tabs and the longest label spread edge to edge leave a
                // 320px phone about ten pixels of slack. A point smaller there
                // keeps the label off its own clip edge.
                'text-[12px] min-[360px]:text-[13px]',
                active ? 'text-accent' : 'text-ink-3',
              )}
            >
              <Icon size={22} strokeWidth={2} className={cx('shrink-0', active && 'animate-tab')} />
              {/* Clipped by the outer span, whose width the effect owns; the
                  inner one keeps the text at its natural width throughout. */}
              <span data-label={active ? 'on' : 'off'} className="overflow-hidden">
                <span className="block w-max whitespace-nowrap pl-2">{label}</span>
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
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

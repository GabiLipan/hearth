import {
  useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Home, Receipt, PiggyBank, CalendarClock, ChartPie, Settings, Plus, CloudOff, AlertTriangle,
  PanelLeftClose, PanelLeftOpen, Target, ArrowDownToLine,
} from 'lucide-react'
import { useSyncState } from '../hooks/useSync'
import { installUpdate, useUpdateState } from '../lib/updates'
import { DrillSheet } from './DrillSheet'
import { cx } from './ui'
import { BrandMark } from './BrandMark'
import { TransactionForm } from './TransactionForm'
import { SETTINGS_GROUP_TITLES } from '../pages/Settings'
import { APP_SCROLLER_ID } from '../lib/scroll'
import { BookLens } from './BookSwitcher'

const NAV = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/activity', label: 'Activity', icon: Receipt },
  { to: '/budgets', label: 'Budgets', icon: PiggyBank },
  { to: '/bills', label: 'Bills', icon: CalendarClock },
  { to: '/goals', label: 'Goals', icon: Target },
  { to: '/reports', label: 'Reports', icon: ChartPie },
]

/**
 * Pages whose figures depend on which book you are looking at.
 *
 * Settings and Rules are not about money, so a lens in their header would be a
 * control with nothing to act on.
 */
const LENS_PATHS = new Set(['/', '/activity', '/budgets', '/bills', '/goals', '/reports'])

const TITLES: Record<string, string> = {
  '/': 'Home',
  '/activity': 'Activity',
  '/budgets': 'Budgets',
  '/bills': 'Bills',
  '/goals': 'Goals',
  '/reports': 'Reports',
  '/settings': 'Settings',
  '/settings/rules': 'Rules',
  // Settings' six groups each get their own screen on a phone, and the top bar
  // is where they are named — the pages render no heading of their own.
  ...SETTINGS_GROUP_TITLES,
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
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const title = TITLES[pathname] ?? 'Hearth'

  /**
   * The window's title, which never changed.
   *
   * Every history entry, every tab and every bookmark read "Hearth — Family
   * Finance", so a browser with three of them open offered three identical
   * things to choose between. Home stays the bare name: "Home · Hearth" is a
   * tautology, and the front page of an app is the one place its own name is
   * the whole answer.
   */
  useEffect(() => {
    document.title = pathname === '/' ? 'Hearth' : `${title} · Hearth`
  }, [pathname, title])

  /**
   * `?add=1` — the app icon's "Add transaction" shortcut.
   *
   * Read once and cleared, so it cannot re-open the sheet every time this
   * component happens to re-render, and so that closing the sheet and pressing
   * Back does not open it again. The same discipline `drill.ts` params follow,
   * and for the same reason: a parameter nobody can see must not go on
   * overriding something somebody then does.
   */
  useEffect(() => {
    if (!new URLSearchParams(search).has('add')) return
    setAddOpen(true)
    navigate(pathname, { replace: true })
  }, [search, pathname, navigate])
  /**
   * The mobile top bar's height, published as `--header-h`.
   *
   * Anything else that wants to stick below it — the month headings in Activity
   * — needs a number, and there isn't one to hard-code: the bar is a fixed row
   * plus `env(safe-area-inset-top)`, which differs between a notched phone, a
   * flat one, and the same phone in a browser tab with its own chrome. Measured
   * rather than assumed, and re-measured on rotation, because a stale value
   * leaves the heading either overlapping the bar or floating below it.
   *
   * Zero on desktop, where the bar is `md:hidden` and there is nothing to clear.
   */
  const headerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const write = () =>
      document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`)
    const ro = new ResizeObserver(write)
    ro.observe(el)
    write()
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--header-h')
    }
  }, [])


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
    /**
     * The frame, which is exactly one viewport tall and never scrolls.
     *
     * The document does not scroll either — the column below does. That is what
     * holds the tab bar still through a rubber band: a bounce moves the thing a
     * `fixed` element is positioned against, and the only way to stop that is to
     * leave nothing for the bounce to move. See `lib/scroll.ts` for the two
     * cheaper fixes that were tried first and why neither survived.
     */
    /* `relative` so the top bar can be positioned against the FRAME. Safe in a
       way it would not be on the scroller: this element's box is the viewport's
       box, so anything absolutely positioned elsewhere in the app that resolves
       here instead of the initial containing block lands in exactly the same
       place. */
    <div className="app-frame relative flex flex-col overflow-hidden md:flex-row">
      {/* Desktop / iPad sidebar. An ordinary flex item in a frame that does not
          scroll, so it needs nothing to hold it in place — `main` simply fills
          whatever width it leaves, at any viewport. */}
      <aside
        className={cx(
          'z-40 hidden h-full shrink-0 flex-col gap-0.5 border-r border-hairline bg-surface p-2.5 md:flex',
          // The status bar sits over the app on an installed iPad, where the
          // phone header that normally absorbs it is hidden (`md:hidden`) and
          // there is nothing else between the clock and the first nav item.
          // `env()` is its own media query — it resolves to 0 in a desktop
          // browser and in Safari's tabs, so this needs no breakpoint of its own.
          'pt-[calc(0.625rem_+_env(safe-area-inset-top))]',
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
            type="button"
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
          type="button"
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

      {/*
        Mobile top bar, over the scroller rather than inside it.

        It was `sticky top-0` within the scroller, which is not a place a bounce
        leaves alone: sticky never rises above its own natural position, so
        pulling down past the top of a page carried the bar down with the
        content — the same complaint as the tab bar, at the other end.

        Absolute over the frame instead, with the scroller padded to match, so
        the rows still pass BEHIND it and it keeps its frosted edge. A bar in
        flow above the scroller would hold still just as well and would cut the
        content off at a hard line instead, which is a different-looking app.

        `--header-h` is what pads the scroller, so the measurement is now
        load-bearing in a second place — Activity's month headings already stick
        to it, and they still sit exactly where they did.
      */}
      <header
        ref={headerRef}
        className="pt-safe absolute inset-x-0 top-0 z-30 border-b border-hairline bg-page/80 backdrop-blur-md md:hidden"
      >
        <div className="flex h-13 items-center gap-2 px-4 py-2.5">
          <h1 className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight">{title}</h1>
          {/* The book lens, on the pages that have one. It used to be a
              full-width row inside each page; here it costs nothing and is
              always in the same place. */}
          {LENS_PATHS.has(pathname) && <BookLens />}
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

      {/* The one thing that scrolls.
          `overscroll-behavior` is deliberately left alone: this is the element
          that rubber-bands now, and the bounce is the point.
          `min-w-0` because this is the flex item beside the sidebar now, and a
          flex item's automatic minimum is its CONTENT's width — without it one
          wide table pushes the whole row instead of scrolling inside itself.
          Deliberately NOT `relative`: that would make this the containing block
          for every absolutely positioned descendant in the app.
          The padding is the top bar's own height, since the bar sits OVER this
          element rather than inside it. Zero on desktop, where the bar is
          `md:hidden` and therefore measures nothing.
          Above `md` the inset is the status bar instead, and it belongs to the
          COLUMN rather than to `main`: the banners are the first thing in here
          now, so an inset on `main` alone left "A new version of Hearth is
          ready" sitting under the clock on an installed iPad. `env()` resolves
          to 0 in a browser tab, so this costs a desktop nothing. */}
      <div
        id={APP_SCROLLER_ID}
        className="min-w-0 flex-1 overflow-y-auto pt-[var(--header-h,0px)] md:pt-[env(safe-area-inset-top)]"
      >
        <SyncBanner />
        <UpdateBanner />

        {/* Content — fills every pixel the sidebar leaves, at any viewport width.
            Pages decide their own column counts from there. */}
        {/* `max-md:overflow-x-clip` catches the sideways travel of a page change.
            On a phone this element is exactly the width of the viewport, so it
            clips where the viewport would have — and unlike the same rule on
            <html>, it does not propagate to the viewport. */}
        {/* The status-bar inset used to be stated here. It is on the scroller
            above instead, so that whatever is first in the column — a banner,
            or this — clears the clock. Stating it twice would double it. */}
        {/* `pb-20` clears the FAB and nothing else. It was `pb-32`, for a tab
            bar that used to be `fixed` and therefore lay OVER the end of the
            page; the bar is in flow below this scroller now, so most of that
            was simply a dead band under the last card. */}
        <main className="w-full min-w-0 flex-1 px-4 pb-20 pt-4 max-md:overflow-x-clip md:px-5 md:pb-8 xl:px-6">
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
      </div>

      {/* The rows behind whatever figure was last pressed. Mounted here rather
          than per page: it is a modal over the whole app, and the charts that
          raise it sit three components deep inside a widget catalogue. Outside
          the scroller with everything else that must not move with it — it
          portals to `<body>` anyway, so this is where it reads correctly rather
          than where it renders. */}
      <DrillSheet />

      {/*
        The phone's bottom furniture, anchored to the FRAME rather than to the
        viewport.

        Both of these used to be `position: fixed`, which resolves against the
        browser's viewport — and on a cold start of an installed iOS PWA that
        viewport is short, so the bar sat well above the bottom of the screen
        until the first scroll settled it. Nothing measurable was wrong: the
        page was the right height, `visualViewport` agreed with `innerHeight`,
        and `below` was correctly zero. The bar was being placed against a
        number the app never sees.

        In flow at the bottom of a frame the app controls, there is no such
        number. It also costs nothing now: the frame stopped scrolling when the
        scroll moved inside it, so "outside the scroller" and "fixed" are no
        longer the same requirement — which is what made the bar immune to the
        rubber band, and it still is.
      */}
      <div className="relative z-40 shrink-0 md:hidden">
        {/* Withdraws while the sheet is open, so the sheet reads as the button
            itself having opened up rather than as something covering it.
            `bottom-full` puts it on the bar's top edge — the old
            `4.75rem + safe-area` had to add up to the same place by hand. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label="Add transaction"
          aria-expanded={addOpen}
          className={cx(
            'absolute bottom-full right-4 mb-4 grid size-14 place-items-center',
            'rounded-2xl bg-accent text-accent-ink shadow-lg shadow-accent/30',
            'transition-[scale,opacity] duration-200 ease-out active:scale-95 motion-reduce:transition-none',
            addOpen && 'pointer-events-none scale-50 opacity-0',
          )}
        >
          <Plus size={26} />
        </button>

        <BottomTabs pathname={pathname} />
      </div>

      <TransactionForm open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}

const TAB_MS = 460
/** Damped: overshoots by a few per cent and settles, so the pill lands with weight. */
const TAB_SPRING = 'cubic-bezier(0.33, 1.35, 0.5, 1)'
/**
 * At most how far the pill is drawn outside the tab it belongs to.
 *
 * The room inside the pill is drawn, not laid out. Padding the tabs themselves
 * pads all six, and with the row spread edge to edge that spends the width
 * budget without fattening the pill — the free space just moves into the gaps.
 * Painting the pill larger than its tab costs the layout nothing, and takes the
 * padding out of the gap either side, which is the space going spare anyway.
 *
 * A maximum rather than a promise: it is clamped to the gap actually available,
 * so a narrow phone with six tabs and no room to give quietly gets none.
 */
const PILL_BLEED = 9

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
function BottomTabs({ pathname }: { pathname: string }) {
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

    // 4. Now the geometry means something. The pill takes its padding out of
    //    the gap to its neighbours, so it can only have what the gap has —
    //    keeping a couple of pixels back so the two never quite touch.
    const tabs = [...wrap.querySelectorAll<HTMLElement>('[data-tab]')]
    const gap = Math.min(
      ...tabs.slice(1).map((el, i) => el.offsetLeft - (tabs[i].offsetLeft + tabs[i].offsetWidth)),
    )
    const bleed = Math.max(0, Math.min(PILL_BLEED, gap - 2))
    const to = { left: active.offsetLeft, width: active.offsetWidth }
    pill.style.left = `${to.left - bleed}px`
    pill.style.width = `${to.width + bleed * 2}px`
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
        { left: `${to.left - bleed}px`, width: `${to.width + bleed * 2}px` },
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
    // The tabs as well as the bar: a font arriving late changes how wide they
    // are without changing the bar at all, and the pill would be left behind
    // pointing at where the tab used to be.
    observer.observe(wrap)
    wrap.querySelectorAll('[data-tab]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <nav
      className={cx(
        // `pb-safe` is the whole story now: the bar sits at the bottom of a
        // frame the app sizes itself, so there is no strip left under it to
        // paint over. It used to carry an 8rem filler below its own edge, for
        // the times iOS handed a standalone app a viewport that stopped short
        // of the display — dead weight once the bar stopped being positioned
        // against that viewport, and clipped by the frame in any case.
        'pb-safe border-t border-hairline bg-surface/90 backdrop-blur-md',
      )}
    >
      {/* The padding here has to cover the pill's bleed as well as the tab, or
          the first and last pills sit closer to the edge than the icons did.
          Narrower below 360px, where six tabs and a label need the width more
          than the margin does. */}
      <div ref={wrapRef} className="relative flex items-center justify-between px-3 py-1.5 min-[360px]:px-5">
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
/**
 * A new version is downloaded and waiting.
 *
 * Above the page rather than in Settings, because the whole problem was that
 * nothing ever said so: the app would sit on an old bundle for days with no way
 * to know. One tap takes it, and the bar is gone for good — it only ever
 * appears when there is genuinely something newer already on the device.
 *
 * It reloads, which is why it asks rather than doing it: queued changes are
 * safe in IndexedDB, but a half-typed transaction is not.
 */
function UpdateBanner() {
  const { status } = useUpdateState()
  const [taking, setTaking] = useState(false)
  // `stale` is the same news — a newer version exists — and differs only in
  // what taking it costs. See `installUpdate`.
  if (status !== 'ready' && status !== 'stale') return null
  return (
    <div className="flex items-center gap-2 bg-accent/10 px-4 py-2 text-sm text-ink-2 md:px-5">
      <ArrowDownToLine size={15} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">A new version of Hearth is ready</span>
      <button
        type="button"
        onClick={() => {
          setTaking(true)
          void installUpdate()
        }}
        disabled={taking}
        className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-ink disabled:opacity-60"
      >
        {taking ? 'Updating\u2026' : 'Update now'}
      </button>
    </div>
  )
}

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

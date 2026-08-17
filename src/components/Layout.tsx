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
import { cx, CHROME_FROST, PILL_MS, PILL_SPRING } from './ui'
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
  const dockRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const pairs: [HTMLElement | null, string][] = [
      [headerRef.current, '--header-h'],
      // The mirror at the other end. Both bars float over the scroller now, so
      // both have to hand back the room they no longer occupy, and neither
      // height is a constant: one is a row plus `env(safe-area-inset-top)`, the
      // other a capsule plus the home indicator's inset, and every phone,
      // orientation and browser tab answers differently.
      [dockRef.current, '--tabbar-h'],
    ]
    const write = () => {
      for (const [el, prop] of pairs) {
        if (el) document.documentElement.style.setProperty(prop, `${el.offsetHeight}px`)
      }
    }
    const ro = new ResizeObserver(write)
    for (const [el] of pairs) if (el) ro.observe(el)
    write()
    return () => {
      ro.disconnect()
      for (const [, prop] of pairs) document.documentElement.style.removeProperty(prop)
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
        Mobile top controls — a layer over the scroller, not a bar.

        There is no plate and no title here any more. The tab bar names the page
        already, in the other most valuable strip of the screen, so a permanent
        title bar was spending 52px saying the same word twice; the title is a
        large heading at the top of the CONTENT now (see `main`), where it opens
        the page and then scrolls away. What is left is the two controls that
        have to stay reachable wherever you are, floating over the rows with a
        frosted disc each.

        The consequence to remember: this element spans the full width of every
        page and is mostly empty, so it MUST be `pointer-events-none` with its
        children opting back in. As a solid bar it could afford to swallow taps
        across the top of the screen because there was nothing behind it; as a
        transparent layer, the first card is behind it.

        It was `sticky top-0` within the scroller, which is not a place a bounce
        leaves alone: sticky never rises above its own natural position, so
        pulling down past the top of a page carried the bar down with the
        content — the same complaint as the tab bar, at the other end.

        Absolute over the frame instead, so the rows pass BEHIND the discs. Note
        `absolute`, never `fixed`: the frame is a box this app sizes itself, so
        positioning against it survives the rubber band that moves the viewport
        out from under anything `fixed`. That distinction is the whole reason
        the bottom bar sits where it does, and it is what lets both edges float
        now.

        `--header-h` is what pads the scroller, so the measurement is
        load-bearing in a second place — Activity's month headings stick to it,
        and they still sit exactly where they did, now just under the discs
        rather than under a bar.
      */}
      <header
        ref={headerRef}
        className="pt-safe pointer-events-none absolute inset-x-0 top-0 z-30 md:hidden"
      >
        <div className="flex items-center gap-2 px-3.5 pb-3 pt-2">
          {/* The book lens, on the pages that have one. Absent rather than
              disabled elsewhere: `LENS_PATHS` decides, and Settings has no
              figures for a lens to act on. */}
          {LENS_PATHS.has(pathname) && <BookLens />}
          {/* A group, not a slot. Anything added later joins from the right
              edge inward, so Settings never moves out from under the thumb
              that has learned where it is. */}
          <div className="ml-auto flex items-center gap-2">
            <NavLink
              to="/settings"
              aria-label="Settings"
              className={({ isActive }) =>
                cx(
                  'pointer-events-auto grid size-11 place-items-center rounded-full',
                  CHROME_FROST,
                  isActive ? 'text-accent' : 'text-ink-2',
                )
              }
            >
              <Settings size={20} />
            </NavLink>
          </div>
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
          to 0 in a browser tab, so this costs a desktop nothing. Below `md` the
          same reasoning is what puts a banner clear of the floating discs —
          `--header-h` is their whole clearance, and a banner is the first thing
          it applies to.
          `--tabbar-h` is the mirror at the other end: the tab bar floats over
          this element now rather than sitting in flow below it, so the room it
          used to occupy has to be given back or the last row of every page ends
          up underneath it. Zero on desktop, where the dock is `md:hidden`. */}
      <div
        id={APP_SCROLLER_ID}
        className="min-w-0 flex-1 overflow-y-auto pt-[var(--header-h,0px)] pb-[var(--tabbar-h,0px)] md:pt-[env(safe-area-inset-top)]"
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
        {/* `pb-16` clears the FAB and nothing else — the bar's own room is the
            scroller's `pb-[--tabbar-h]` above, and stacking both here would put
            a dead band under the last card. 64px is the button (44) plus the
            gap it keeps from the bar (12) plus a little air. */}
        <main className="w-full min-w-0 flex-1 px-4 pb-16 pt-4 max-md:overflow-x-clip md:px-5 md:pb-8 xl:px-6">
          {/* The page title, in the content on every width now.
              It used to be desktop-only, with a phone reading its title off the
              top bar; there is no top bar to read any more. Large on a phone and
              then gone — an opening statement rather than chrome, which is what
              lets the top edge be two floating discs instead of a strip. The tab
              bar is what says where you are once this has scrolled away. */}
          <h1 className="mb-2 text-[1.75rem] font-bold leading-tight tracking-tight md:mb-3 md:text-xl">{title}</h1>
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

        Positioned against a frame the app controls, there is no such number. It
        also costs nothing: the frame stopped scrolling when the scroll moved
        inside it, so "outside the scroller" and "fixed" are no longer the same
        requirement — which is what made the bar immune to the rubber band, and
        it still is.

        `absolute` here rather than in flow, which is the one thing that changed
        with the shape. A capsule only means anything if content passes behind
        it, and in flow nothing could; the room it stops occupying is handed
        back to the scroller as `--tabbar-h`. The bounce is untouched by this:
        `.app-frame` is not what moves during one, so an element positioned
        against it holds just as still as it did in flow. `fixed` would still be
        wrong, for exactly the reasons above.
      */}
      <div
        ref={dockRef}
        className="pb-dock pointer-events-none absolute inset-x-0 bottom-0 z-40 px-3.5 md:hidden"
      >
        {/* The scrim: the page fading out under the bar rather than running
            sharply into it. Absolute and FIRST, so the two positioned siblings
            after it paint on top in document order.

            `-top-8` puts its leading edge above the bar, where it is still
            completely clear — the fade has to begin before the bar does or you
            see the join. The blur ramps because the mask ramps: a masked
            `backdrop-filter` composites the blurred result through the mask, so
            an element with one blur and a gradient mask reads as a progressive
            one, for a single filter rather than the stack of them a true
            gradient blur needs. Worth the restraint — this is on screen the
            entire time the app is. */}
        <span aria-hidden className="dock-scrim pointer-events-none absolute inset-x-0 -top-8 bottom-0" />

        {/* Withdraws while the sheet is open, so the sheet reads as the button
            itself having opened up rather than as something covering it.
            `bottom-full` puts it on the bar's top edge — the old
            `4.75rem + safe-area` had to add up to the same place by hand.

            A circle, at `size-11` like the settings disc and the lens, so the
            three floating controls are one size all round the screen; and
            `right-3.5`, which is this element's own horizontal padding, so its
            right edge lines up with the bar's rather than with the screen's. It
            keeps the accent fill and the plus: it is the one thing here that
            makes something rather than showing something, and a frosted disc
            among frosted discs would bury that. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label="Add transaction"
          aria-expanded={addOpen}
          className={cx(
            'pointer-events-auto absolute bottom-full right-3.5 mb-3 grid size-11 place-items-center',
            'rounded-full bg-accent text-accent-ink shadow-lg shadow-accent/30',
            'transition-[scale,opacity] duration-200 ease-out active:scale-95 motion-reduce:transition-none',
            addOpen && 'pointer-events-none scale-50 opacity-0',
          )}
        >
          <Plus size={22} />
        </button>

        <BottomTabs pathname={pathname} />
      </div>

      <TransactionForm open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  )
}

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
 * so a narrow phone with six tabs and no room to give quietly gets none — and,
 * since the bar became a capsule, to the ROW as well. The bar's 5px padding is
 * the margin the pill is supposed to keep from the rim; unclamped, the first
 * and last tabs would spend their bleed pushing straight through it and the two
 * end pills would touch the edge while the four in the middle did not.
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
    // …and clamped to the row, so the end pills stop where the bar's padding
    // says rather than eating through it. `clientWidth` is the row's content
    // box, which is exactly the space inside the capsule's 5px.
    const left = Math.max(0, active.offsetLeft - bleed)
    const right = Math.min(wrap.clientWidth, active.offsetLeft + active.offsetWidth + bleed)
    const to = { left, width: right - left }
    pill.style.left = `${to.left}px`
    pill.style.width = `${to.width}px`
    pill.style.opacity = '1'
    placed.current = true

    if (!animate || !from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    labels.forEach((el, i) => {
      if (Math.abs(was[i] - goes[i]) < 0.5) return
      el.animate([{ width: `${was[i]}px` }, { width: `${goes[i]}px` }], {
        duration: PILL_MS,
        easing: PILL_SPRING,
      })
    })

    pill.animate(
      [
        { left: `${from.left}px`, width: `${from.width}px` },
        { left: `${to.left}px`, width: `${to.width}px` },
      ],
      { duration: PILL_MS, easing: PILL_SPRING },
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
        // A capsule: `rounded-full` on a bar whose height is the tab row plus
        // 5px each side, so the radius is half the height at both levels and
        // the travelling pill nests inside the bar's own corner rather than
        // fighting it. Five is where the gap reads as a margin and is still too
        // small to read as a second surface — at nothing the pill becomes the
        // bar's own edge, and much past eight the bar becomes a tray with a
        // separate pill sitting in it.
        // `relative` so it paints over the scrim, which is an absolute sibling
        // earlier in the DOM. Two positioned elements at `z-index: auto` are
        // painted in document order, so no z-index is needed either side — and
        // adding one would only invite the next person to add a bigger one.
        'pointer-events-auto relative rounded-full p-[5px]',
        // The frost, which finally has something to be frosted about now that
        // the page runs underneath. Thinner than the strip it replaces
        // (`bg-surface/90 backdrop-blur-md`) so that a row travelling behind it
        // stays legible as a row: a floating object wants to look thin, and a
        // solid one is just a pill-shaped hole in the page.
        CHROME_FROST,
      )}
    >
      {/* No padding of its own any more — the bar's 5px is the margin, stated
          once, and the pill's bleed is clamped to this box in `place`. */}
      <div ref={wrapRef} className="relative flex items-center justify-between">
        <span
          ref={pillRef}
          aria-hidden
          // `inset-y-0`, not `inset-y-1`: the clearance is the bar's padding
          // now, so stating it again here would double it.
          className="pointer-events-none absolute inset-y-0 rounded-full bg-accent/12 opacity-0"
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

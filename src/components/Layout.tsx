import {
  useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type Ref,
} from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Home, Receipt, PiggyBank, CalendarClock, ChartPie, Settings, Plus, X, CloudOff, AlertTriangle,
  PanelLeftClose, PanelLeftOpen, Target, ArrowDownToLine,
} from 'lucide-react'
import { useSyncState } from '../hooks/useSync'
import { installUpdate, useUpdateState } from '../lib/updates'
import { DrillSheet } from './DrillSheet'
import { cx, useWide, motionOk, CHROME_FROST, PILL_MS, PILL_SPRING } from './ui'
import { BrandMark } from './BrandMark'
import { TransactionForm } from './TransactionForm'
import { SETTINGS_GROUP_TITLES } from '../pages/Settings'
import { APP_SCROLLER_ID } from '../lib/scroll'
import { useHeadlineValue } from '../lib/headline'
import { backgroundHref, resolveBackground } from '../lib/modalRoute'
import { SettingsOverlay, SETTINGS_EXIT_MS } from './SettingsOverlay'
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
  // What the page underneath says it is showing, and whether the lens is
  // covering the place it goes. Both only mean anything below `md`.
  const headline = useHeadlineValue()
  const [lensOpen, setLensOpen] = useState(false)
  const location = useLocation()
  const { search } = location
  const navigate = useNavigate()

  /**
   * Settings, over the page rather than instead of it.
   *
   * `background` is the location the modal was opened from, and while it is set
   * that is the page actually on screen — so everything this component derives
   * about "which page am I on" has to read `pathname`, the background's, and
   * not `location.pathname`, which says `/settings`. Getting that wrong lights
   * no tab, titles the window "Settings" over the Activity list, and offers the
   * book lens on a screen that has no figures.
   */
  const wide = useWide()
  const background = wide ? undefined : resolveBackground(location)
  const pathname = background?.pathname ?? location.pathname
  const settingsOpen = Boolean(background) && location.pathname.startsWith('/settings')

  /**
   * The modal outlives `settingsOpen` by `SETTINGS_EXIT_MS`, so it has
   * something to animate out over — the same freeze `Sheet` uses, and for the
   * same reason: the route has already changed by the time the exit begins.
   */
  const [settingsShown, setSettingsShown] = useState(settingsOpen)
  useEffect(() => {
    if (settingsOpen) {
      setSettingsShown(true)
      return
    }
    const t = setTimeout(() => setSettingsShown(false), SETTINGS_EXIT_MS)
    return () => clearTimeout(t)
  }, [settingsOpen])

  /**
   * Out, from however deep in Settings you got.
   *
   * Deliberately not `navigate(-1)`: that is one step, and the group screens are
   * real routes, so from `/settings/data` it would land back on the Settings
   * index with the modal still up. The X closes the whole thing wherever it is
   * pressed. `replace` keeps the modal from stacking a second copy of the page
   * on top of itself, and costs nothing visually — the page underneath has been
   * mounted the entire time, so this changes which location the routes are read
   * from and not what is rendered.
   */
  function closeSettings() {
    navigate(background ? backgroundHref(background) : '/', { replace: true })
  }

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
  const railRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const pairs: [HTMLElement | null, string][] = [
      [headerRef.current, '--header-h'],
      // The desktop rail's footprint, so a layer floating over the CONTENT can
      // start where the content does. Zero on a phone, where the rail is
      // `md:hidden` and measures nothing — the same trick as the two bars.
      [railRef.current, '--rail-w'],
      // The mirror at the other end. Both bars float over the scroller now, so
      // both have to hand back the room they no longer occupy, and neither
      // height is a constant: one is a row plus `env(safe-area-inset-top)`, the
      // other a capsule plus the home indicator's inset, and every phone,
      // orientation and browser tab answers differently.
      [dockRef.current, '--tabbar-h'],
    ]
    const write = () => {
      for (const [el, prop] of pairs) {
        if (!el) continue
        // Width for the rail, height for the two bars: each is measured across
        // the axis it takes room away on.
        // The rail's far edge rather than its width: it floats now, with a
        // gutter of its own either side, and what a layer over the content
        // needs to know is where the content STARTS. `.app-frame` is the whole
        // viewport, so the rail's right edge in client coordinates is exactly
        // that. Zero while it is `display: none` on a phone, which is right.
        const px = prop === '--rail-w' ? el.getBoundingClientRect().right : el.offsetHeight
        document.documentElement.style.setProperty(prop, `${px}px`)
      }
    }
    const ro = new ResizeObserver(write)
    // `border-box`, and it is load-bearing. A ResizeObserver watches the
    // CONTENT box by default, and both of these are a fixed row inside padding
    // that is entirely `env(safe-area-inset-*)` — so on the one event that
    // changes them, a rotation taking the top inset from 59px to 0, the content
    // box does not move and the callback never runs. `--header-h` would then
    // keep the portrait number in landscape: a scroller padded for a header
    // that is no longer that tall.
    for (const [el] of pairs) if (el) ro.observe(el, { box: 'border-box' })
    write()
    return () => {
      ro.disconnect()
      for (const [, prop] of pairs) document.documentElement.style.removeProperty(prop)
    }
  }, [])


  /**
   * The floating chrome does not move. Ever.
   *
   * Both bars sit OUTSIDE `#app-scroll`, positioned against the frame, so a drag
   * starting on one has no scroller to act on — and iOS answers that by
   * rubber-banding the viewport itself, which carries the whole app with it,
   * bars included. They were being dragged up and down and snapping back, which
   * is the one thing this arrangement exists to prevent. `overscroll-behavior`
   * cannot help: on `<body>` it does nothing in Safari, and on `<html>` it takes
   * the page's own bounce away with it (see `lib/scroll.ts`).
   *
   * Two halves, deliberately. `touch-none` on each control is the declarative
   * answer and is enough almost everywhere. This listener is the guarantee:
   * WebKit has been unreliable about `touch-action` on an element with no
   * scrollable ancestor — which is exactly the case here — and a bar that holds
   * still on nine devices is not a bar that holds still.
   *
   * Attached to the header and the dock rather than to each control, because
   * both are `pointer-events-none` with their children opting back in: a touch
   * on a bar bubbles through here, and a touch on the empty space beside one
   * never enters this subtree at all. Which is the behaviour wanted — the page
   * behind the chrome stays scrollable everywhere the chrome is not.
   */
  useEffect(() => {
    const nodes = [headerRef.current, dockRef.current].filter((n): n is HTMLElement => Boolean(n))
    const hold = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault()
    }
    for (const n of nodes) n.addEventListener('touchmove', hold, { passive: false })
    return () => {
      for (const n of nodes) n.removeEventListener('touchmove', hold)
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
      {/* Desktop / iPad sidebar — a floating rail rather than a wall.
          Still an ordinary flex item in a frame that does not scroll, so it
          needs nothing to hold it in place and `main` fills whatever width it
          leaves. What changed is that it no longer reaches any edge of the
          screen: it is inset on all four sides with the page showing round it,
          rounded like a sheet, and wearing the same frost as the phone's tab
          bar. Those two are the same object at two ends of the same app — the
          thing that says where you are and lets you go somewhere else — and
          they now say so in the same voice. */}
      <Rail ref={railRef} collapsed={collapsed} onToggle={toggleSidebar} onAdd={() => setAddOpen(true)} pathname={pathname} />

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
      {/* Anything the app has to say about ITSELF — a version waiting to be
          taken, writes that could not be sent — floating over the page rather
          than pushing it down. See `Notices`. */}
      <Notices />

      <header
        ref={headerRef}
        className={cx(
          'pt-safe pointer-events-none absolute inset-x-0 top-0 md:hidden',
          // Above the settings modal while it is up, because the disc in here
          // has become the X that closes it. Still under a `Sheet` (z-50)
          // either way: a confirmation raised from inside Settings has to cover
          // the control that opened it.
          settingsShown ? 'z-[46]' : 'z-30',
        )}
      >
        {/* The same fade as the dock's, upside down: clear below the discs and
            fully blurred by the top of the screen, so rows leave under the
            status bar the way they leave under the tab bar.

            `bottom-0` — the fade ends exactly where the content begins, since
            `--header-h` is both this element's height and the scroller's top
            padding. That is not tidiness, it is the fix for a real artefact:
            reaching 40px further down put the large page title inside the ramp
            at rest, and layer 1 cross-fading 1px of blur against sharp text is
            invisible on a row and plainly visible on 28px bold — a doubled
            ghost along the top of every letter, which is the exact fault this
            whole stack exists to remove. Anything inside the ramp at rest wants
            to be either fully blurred or fully sharp; here it is fully sharp.
            (On a phone this is still a long ramp — `env(safe-area-inset-top)`
            is most of it — and it comes out within a few pixels of the dock's.)

            Absolutely positioned, so it does not enter `--header-h`: that
            measurement is `offsetHeight` on this element and an absolute child
            contributes nothing to it. If this ever becomes a flow child, the
            scroller's top padding grows by 40px and every page gains a gap. */}
        <span
          aria-hidden
          className="edge-scrim scrim-up pointer-events-none absolute inset-x-0 bottom-0 top-0"
        >
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>

        <div className="relative flex items-center gap-2 px-3.5 pb-3 pt-2">
          {/* Whatever the page says it is showing, once it has been scrolled
              into — today that is Activity's month, and it is here because with
              no bar left to butt into, a sticky heading in the list was a
              full-width band with square edges separating nothing from nothing.

              Absolutely centred rather than a flex child, so the line is
              centred on the SCREEN rather than in whatever room the two
              controls happen to leave — the lens is 88px and the settings disc
              44, and a middle measured between them is visibly off. First in
              the DOM so both controls, which are positioned, paint over it.

              It hides while the lens is open, because the lens expands from 44
              to something over 200 and would otherwise cover the left half of
              this and leave the rest poking out. */}
          <span
            aria-hidden
            className={cx(
              'pointer-events-none absolute inset-x-0 flex justify-center px-16',
              'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
              // Gone while Settings is up: the page underneath is still
              // mounted and still publishing its month, and a month floating
              // over the Appearance card belongs to nothing on screen.
              headline && !lensOpen && !settingsOpen ? 'opacity-100' : 'scale-90 opacity-0',
            )}
          >
            <span
              className={cx(
                'max-w-full truncate rounded-full px-3 py-1.5 text-[13px] font-semibold text-ink',
                CHROME_FROST,
              )}
            >
              {headline}
            </span>
          </span>

          {/* The book lens, on the pages that have one. Absent rather than
              disabled elsewhere: `LENS_PATHS` decides, and Settings has no
              figures for a lens to act on. */}
          {/* `pathname` is the page underneath, so this survives the modal
              opening — which is wrong, since the lens acts on figures that are
              now covered. Hidden rather than unmounted, so it does not lose its
              place in the row while the X is being pressed. */}
          {LENS_PATHS.has(pathname) && !settingsOpen && <BookLens onOpenChange={setLensOpen} />}
          {/* A group, not a slot. Anything added later joins from the right
              edge inward, so Settings never moves out from under the thumb
              that has learned where it is. */}
          <div className="relative ml-auto flex items-center gap-2">
            {/* One disc, two glyphs, and it is the same element throughout —
                the gear turns into the X rather than being swapped for it, so
                the thing you pressed to get here is visibly the thing that
                takes you back.

                The two rotate in opposite directions through the crossover,
                which is what stops it reading as a fade: the gear winds a
                quarter turn clockwise as it shrinks away and the X unwinds into
                place behind it. `--ease-settle` overshoots slightly, so the X
                arrives with a small bounce. */}
            <button
              type="button"
              aria-label={settingsOpen ? 'Close settings' : 'Settings'}
              aria-expanded={settingsOpen}
              onClick={() => {
                if (settingsOpen) closeSettings()
                else navigate('/settings', { state: { background: location } })
              }}
              className={cx(
                'pointer-events-auto relative grid size-11 place-items-center rounded-full touch-none',
                CHROME_FROST,
                settingsOpen || location.pathname.startsWith('/settings')
                  ? 'text-accent'
                  : 'text-ink-2',
              )}
            >
              <span
                aria-hidden
                className={cx(
                  'absolute transition-[transform,opacity] duration-300 motion-reduce:transition-none',
                  settingsOpen ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100',
                )}
                style={{ transitionTimingFunction: 'var(--ease-settle)' }}
              >
                <Settings size={20} />
              </span>
              <span
                aria-hidden
                className={cx(
                  'absolute transition-[transform,opacity] duration-300 motion-reduce:transition-none',
                  settingsOpen ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0',
                )}
                style={{ transitionTimingFunction: 'var(--ease-settle)' }}
              >
                <X size={21} strokeWidth={2.4} />
              </span>
            </button>
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
        className="min-w-0 flex-1 overflow-y-auto pt-[var(--header-h,0px)] pb-[var(--tabbar-h,0px)] md:pt-[var(--safe-top)]"
      >
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

      {/* Settings, over the page and under a sheet. Positioned against the
          FRAME, like everything else here that must not move with the scroll —
          and phone only, because a wide screen has the sidebar and Settings
          there is a page like any other. */}
      {settingsShown && <SettingsOverlay leaving={!settingsOpen} onDismiss={closeSettings} />}

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

            `-top-10` puts its leading edge above the bar, where it is still
            completely clear — the fade has to begin before the bar does or you
            see the join, and the ramp needs the room to arrive gradually.

            Five children, because a masked `backdrop-filter` cross-fades
            between the blurred backdrop and the sharp one rather than ramping
            the radius: one layer under a gradient is half a blur laid over
            legible text. Four stacked blurs and a wash instead — see
            `.edge-scrim` for why the bands overlap the way they do. */}
        <span aria-hidden className="edge-scrim scrim-down pointer-events-none absolute inset-x-0 -top-10 bottom-0">
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>

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
            'pointer-events-auto absolute bottom-full right-3.5 mb-3 grid size-11 place-items-center touch-none',
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

/** The rail pill's geometry, in the list's own coordinates. */
type PillBox = { top: number; height: number; originX: number; width: number }

/**
 * How the rail's mark leaves one row and arrives at another.
 *
 * Not `PILL_MS`, which is the length of a JOURNEY — a pill crossing the tab bar
 * has ground to cover and 460ms of spring is what stops it looking flung. These
 * two go nowhere: one collapses where it stands and the other grows where it is
 * pressed, so the same duration would read as hesitation. Out is quick and gets
 * out of the way; in overlaps its tail and takes the bounce, because the arrival
 * is the half that answers the press.
 *
 * `SEED_SCALE` is the shape both ends meet at, as a fraction of the row's own
 * height: a disc a little smaller than the icon, centred on it. Zero is the
 * obvious value and the wrong one — a pill scaled to nothing has no rounded
 * corners left to read and the collapse ends as a vanishing line.
 */
const RAIL_OUT_MS = 200
const RAIL_OUT_EASE = 'cubic-bezier(0.36, 0, 0.66, -0.4)'
const RAIL_IN_MS = 380
const RAIL_IN_DELAY = 110
const SEED_SCALE = 0.55

/**
 * The desktop rail: the tab bar's opposite number, standing up.
 *
 * It used to be a full-height wall with a hairline down its right edge and the
 * page butted against it. Floating it costs a gutter of white space and buys
 * three things the phone already had: the page reads as one object with the
 * chrome laid over it rather than as two panes stitched together, the frost
 * lets the page's own colour through so light and dark themes need no separate
 * treatment, and the current page is marked by a PILL that travels rather than
 * by a background that blinks on wherever you clicked.
 *
 * That pill does NOT travel, and this is the one place the rail deliberately
 * parts company with `BottomTabs`. A pill sliding sideways between six tabs an
 * inch apart reads as one object moving; the same slide down a 300px column of
 * rows reads as a lift travelling past the floors you did not ask for, and the
 * further it goes the more it looks like the app is thinking about it. So the
 * mark is not carried from one row to the next: the old one collapses into its
 * own icon and goes, and the new one grows out of the icon you actually
 * pressed, which is where the eye already is.
 *
 * Two elements rather than one, because the two halves overlap in time — the
 * outgoing pill is a ghost that only ever exists while it is leaving. Both are
 * scaled about the icon's centre rather than resized, so the whole thing is
 * composited, and both still write their RESTING state first and animate over
 * the top of it with no `fill` forwards: a finish event is never delivered
 * while the app is in the background, and an animation holding the final value
 * would strand the pill mid-collapse. The ghost's resting state is "gone",
 * which is what makes that safe for the half that ends invisible.
 */
function Rail({
  ref,
  collapsed,
  onToggle,
  onAdd,
  pathname,
}: {
  ref: Ref<HTMLElement>
  collapsed: boolean
  onToggle: () => void
  onAdd: () => void
  pathname: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const ghostRef = useRef<HTMLSpanElement>(null)
  /** Where the pill is resting, so the next change knows what to collapse. */
  const placed = useRef<PillBox | null>(null)

  /**
   * The active row's box, and the point both halves of the animation scale
   * about: the centre of its icon.
   *
   * The icon rather than the row's own centre, because that is the thing that
   * stays put — the label beside it comes and goes with the rail collapsing,
   * and a mark that grew from the middle of a 200px row would be growing from
   * a point with nothing under it.
   */
  const measure = (): PillBox | null => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[data-rail="active"]')
    // Nothing to measure while the rail is `display: none` on a phone.
    if (!list || !active || !active.offsetHeight) return null
    const icon = active.querySelector('svg')
    const listLeft = list.getBoundingClientRect().left
    const iconBox = icon?.getBoundingClientRect()
    return {
      top: active.offsetTop,
      height: active.offsetHeight,
      // The pill is `inset-x-0`, so its own box starts at the list's left edge.
      originX: iconBox ? iconBox.left + iconBox.width / 2 - listLeft : list.clientWidth / 2,
      width: list.clientWidth,
    }
  }

  /** The shape the pill collapses into: a small disc over the icon. */
  const seed = (box: PillBox) =>
    `scale(${((box.height * SEED_SCALE) / Math.max(box.width, 1)).toFixed(4)}, ${SEED_SCALE})`

  const put = (el: HTMLElement, box: PillBox) => {
    el.style.top = `${box.top}px`
    el.style.height = `${box.height}px`
    el.style.transformOrigin = `${box.originX}px 50%`
  }

  const place = (animate: boolean) => {
    const pill = pillRef.current
    const ghost = ghostRef.current
    if (!pill || !ghost) return
    const to = measure()
    if (!to) {
      pill.style.opacity = '0'
      placed.current = null
      return
    }

    const from = placed.current
    for (const el of [pill, ghost]) el.getAnimations().forEach((a) => a.cancel())

    // The resting state, written before anything is animated over it.
    put(pill, to)
    pill.style.opacity = '1'
    ghost.style.opacity = '0'
    placed.current = to

    const moved = from && from.top !== to.top
    if (!animate || !moved || !motionOk()) return

    // Out: the mark you are leaving, shrinking into the icon it belonged to.
    // A touch of anticipation on the way in — it swells a hair before it goes,
    // which is what makes a collapse read as one gesture rather than as a
    // window closing.
    put(ghost, from)
    ghost.animate(
      [
        { transform: 'scale(1, 1)', opacity: 1 },
        { transform: seed(from), opacity: 0 },
      ],
      { duration: RAIL_OUT_MS, easing: RAIL_OUT_EASE },
    )

    // In: the new one out of the icon you pressed, overlapping the tail of the
    // collapse rather than queueing behind it. `backwards` fill only reaches
    // the delay — without it the pill would sit at full size for that moment
    // and then jump back to nothing to start.
    pill.animate(
      [
        { transform: seed(to), opacity: 0 },
        { transform: seed(to), opacity: 1, offset: 0.12 },
        { transform: 'scale(1, 1)', opacity: 1 },
      ],
      { duration: RAIL_IN_MS, delay: RAIL_IN_DELAY, easing: PILL_SPRING, fill: 'backwards' },
    )
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => place(true), [pathname])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(() => {
      // Re-measuring mid-flight would fight the animation for the same values.
      if (pillRef.current?.getAnimations().length) return
      place(false)
    })
    // The list covers the window resizing and the rail appearing at all when
    // one widens past the breakpoint; each row covers a label arriving late or
    // the rail collapsing, neither of which changes the list's own height.
    ro.observe(list)
    list.querySelectorAll('[data-rail]').forEach((el) => ro.observe(el))
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const row = (isActive: boolean) =>
    cx(
      'relative z-10 flex items-center rounded-full py-2 text-sm font-medium transition-colors',
      collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
      // No background of its own: the travelling pill is what marks the page,
      // exactly as in the tab bar. A row that also filled would leave two marks
      // on screen for the length of the journey.
      isActive ? 'text-accent' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
    )

  return (
    <aside
      ref={ref}
      className={cx(
        'z-40 hidden shrink-0 flex-col gap-0.5 rounded-[1.75rem] p-2.5 md:flex',
        // Inset on all four sides, so the page shows round it. Margins rather
        // than a height: the frame stretches its flex items, and a margin is
        // what turns "as tall as the frame" into "as tall as the frame, less
        // the gutter" without any arithmetic to keep in step.
        'mb-2.5 ml-2.5',
        // The status bar is painted OVER the app on an installed iPad, where
        // the phone header that absorbs it elsewhere is hidden (`md:hidden`) —
        // so the clock sat inside this card's own top corner. The inset goes
        // into the top MARGIN rather than the padding: pushing the content down
        // inside the card leaves the card itself under the clock, frosted
        // background and rounded corner and all, which is the thing that read
        // as an overlap. Moving the whole card down puts the status bar over
        // the page's ground, where it belongs. `--safe-top` rather than the raw
        // inset because iPadOS reports 0 for a bar it is nevertheless drawing.
        'mt-[calc(0.625rem_+_var(--safe-top))]',
        // The same four properties the tab bar wears, stated once in `ui.tsx`.
        CHROME_FROST,
        // Bouncy, like the pill: the width is the one thing about this rail
        // that moves on purpose, and `ease-out` made a 200ms slide that read as
        // a panel being dragged. Overshooting slightly and settling reads as
        // the rail snapping open.
        'transition-[width] motion-reduce:transition-none',
        collapsed ? 'w-[3.75rem] items-stretch' : 'w-52 xl:w-56',
      )}
      style={{ transitionDuration: `${PILL_MS}ms`, transitionTimingFunction: PILL_SPRING }}
    >
      <div className={cx('mb-4 mt-1 flex items-center', collapsed ? 'flex-col gap-2' : 'justify-between gap-1 px-2')}>
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark size={30} className="shrink-0 drop-shadow-sm" />
          {!collapsed && <span className="truncate text-lg font-bold tracking-tight">Hearth</span>}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <button
        type="button"
        onClick={onAdd}
        title={collapsed ? 'Add transaction' : undefined}
        aria-label="Add transaction"
        className={cx(
          'mb-2.5 inline-flex h-9 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-ink transition hover:brightness-110',
          !collapsed && 'gap-2',
        )}
      >
        <Plus size={16} />
        {!collapsed && 'Add transaction'}
      </button>

      {/* Every row the pill can travel between, in one positioned box —
          including Settings, which is why the spacer between them is inside
          here rather than around it. `offsetTop` is read against this element,
          so anything the pill can land on has to be a child of it. */}
      <div ref={listRef} className="relative flex min-h-0 flex-1 flex-col gap-0.5">
        <span
          ref={pillRef}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-full bg-accent/12 opacity-0"
        />
        {/* The pill being left behind. At rest it is nothing at all; it exists
            for the 200ms it spends collapsing into the icon it belonged to. */}
        <span
          ref={ghostRef}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-full bg-accent/12 opacity-0"
        />
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={collapsed ? label : undefined}
            data-rail={
              (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)) ? 'active' : 'idle'
            }
            className={({ isActive }) => row(isActive)}
          >
            <Icon size={17} strokeWidth={2} className="shrink-0" />
            {!collapsed && label}
          </NavLink>
        ))}

        <div className="flex-1" />

        <NavLink
          to="/settings"
          title={collapsed ? 'Settings' : undefined}
          data-rail={pathname.startsWith('/settings') ? 'active' : 'idle'}
          className={({ isActive }) => row(isActive)}
        >
          <Settings size={17} className="shrink-0" />
          {!collapsed && 'Settings'}
        </NavLink>
      </div>
    </aside>
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
        'pointer-events-auto relative touch-none rounded-full p-[5px]',
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

/* ---------- What the app has to say for itself ---------- */

/**
 * The two standing notices, floating over the top of the page.
 *
 * They were full-width strips at the top of the scroller, in flow, which had
 * two faults. They pushed every page down by 37px the moment they appeared and
 * let it back up when they went, so the thing you were reading moved twice for
 * a message that was not about it; and being in flow they scrolled away, which
 * for "eleven changes could not be saved" is exactly backwards — the one
 * message worth keeping on screen was the one that left it.
 *
 * So: a card, over the page, at the top, dismissible. Everything else in the
 * app that floats is a capsule wearing `CHROME_FROST`; these are cards, because
 * they carry a sentence and an action rather than a control, and a frosted
 * capsule with two lines of text in it reads as a button that has gone wrong.
 *
 * Positioned against the FRAME, like the header and the dock, and for the same
 * reason — `fixed` resolves against a viewport iOS moves out from under it
 * during a rubber band, and a notice that slides with the bounce is exactly the
 * fault the frame arrangement exists to remove. `Toaster` stays `fixed` because
 * a toast appears in response to something you just did, by which time the
 * viewport has long settled; these two appear on their own.
 *
 * `--rail-w` is where the content starts on a desktop, so the stack is centred
 * over the PAGE rather than over the whole window with the sidebar counted in.
 * It is zero on a phone. `--header-h` is the phone's floating discs, so a
 * notice sits under them rather than over them.
 */
function Notices() {
  return (
    <div
      className={cx(
        'pointer-events-none absolute right-0 z-[45] flex flex-col gap-2 px-4 md:px-5 xl:px-6',
        'left-[var(--rail-w,0px)]',
        'top-[calc(var(--header-h,0px)_+_0.5rem)] md:top-[calc(var(--safe-top)_+_0.75rem)]',
        // Centred on a phone, where the top of the screen is two floating discs
        // and a gap; against the right edge on a wide screen, where the top of
        // the content is the page's own title and a notice parked over it would
        // be a standing condition covering the name of the page it is not
        // about. Which is also where every desktop notification anybody has
        // seen appears.
        'items-center md:items-end',
      )}
    >
      <UpdateNotice />
      <SyncNotice />
    </div>
  )
}

/**
 * One floating notice.
 *
 * `signature` is what makes the dismissal honest. A cross that hides a standing
 * condition for ever is a cross that loses the news: the sync notice would be
 * dismissed while three writes were queued and stay dismissed when the count
 * reached fifty, or when queued turned into failed. So the cross remembers the
 * state it was pressed against, and the notice comes back the moment that
 * state says something new. Nothing is persisted — a reload is a fresh look at
 * the world, and both of these are conditions the app can re-derive in a frame.
 */
function Notice({
  tone = 'neutral',
  icon,
  signature,
  children,
}: {
  tone?: 'neutral' | 'accent' | 'critical'
  icon: ReactNode
  signature: string
  children: ReactNode
}) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (dismissed === signature) return null
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cx(
        'animate-sheet pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-sm',
        'bg-surface shadow-[var(--elev-2)] ring-1',
        tone === 'critical' ? 'text-critical-text ring-critical/25' : 'text-ink-2 ring-hairline',
      )}
    >
      <span className={cx('shrink-0', tone === 'accent' && 'text-accent')}>{icon}</span>
      {children}
      <button
        type="button"
        onClick={() => setDismissed(signature)}
        aria-label="Dismiss"
        className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  )
}

/**
 * A new version is downloaded and waiting.
 *
 * Over the page rather than in Settings, because the whole problem was that
 * nothing ever said so: the app would sit on an old bundle for days with no way
 * to know. One press takes it, and it is gone for good — it only ever appears
 * when there is genuinely something newer already on the device.
 *
 * It reloads, which is why it asks rather than doing it: queued changes are
 * safe in IndexedDB, but a half-typed transaction is not. Dismissing it is
 * therefore a real answer — "not now, I am in the middle of something" — and
 * the Settings version card is where it can be taken later.
 */
function UpdateNotice() {
  const { status } = useUpdateState()
  const [taking, setTaking] = useState(false)
  // `stale` is the same news — a newer version exists — and differs only in
  // what taking it costs. See `installUpdate`.
  if (status !== 'ready' && status !== 'stale') return null
  return (
    <Notice tone="accent" icon={<ArrowDownToLine size={15} />} signature={status}>
      <span className="min-w-0 flex-1">A new version of Hearth is ready</span>
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
    </Notice>
  )
}

/**
 * Says out loud when the app is not in step with the server.
 *
 * Deliberately not a toast: a write usually fails while offline, minutes after
 * the phone was put down, and a message that disappears after three seconds is
 * a message nobody sees. Silence here is what "my change vanished" feels like
 * from the inside. It stays until it is either resolved or dismissed — and a
 * dismissal only covers the state it was pressed against, so a fourth failure
 * after three were waved away says so again.
 */
function SyncNotice() {
  const { online, pending, deadLetters } = useSyncState()
  if (deadLetters === 0 && (online || pending === 0)) return null

  const failed = deadLetters > 0
  return (
    <Notice
      tone={failed ? 'critical' : 'neutral'}
      icon={failed ? <AlertTriangle size={15} /> : <CloudOff size={15} />}
      signature={failed ? `failed:${deadLetters}` : `offline:${pending}`}
    >
      <span className="min-w-0 flex-1">
        {failed
          ? `${deadLetters} change${deadLetters === 1 ? '' : 's'} couldn\u2019t be saved`
          : `Offline \u2014 ${pending} change${pending === 1 ? '' : 's'} will go up when you reconnect`}
      </span>
      {failed && (
        <NavLink to="/settings" className="shrink-0 font-medium underline underline-offset-2">
          Review
        </NavLink>
      )}
    </Notice>
  )
}

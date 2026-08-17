import { Routes, Route, useLocation } from 'react-router-dom'
import SettingsPage, { SettingsGroupPage, SETTINGS_GROUP_TITLES } from '../pages/Settings'
import RulesPage from '../pages/Rules'
import { cx } from './ui'

/**
 * How long the modal takes to leave, in ms.
 *
 * Load-bearing rather than a preference: `Layout` keeps this mounted for
 * exactly this long after the route has already changed, so the exit has
 * something to animate. Shorten the keyframes here and the last frames are cut
 * off; lengthen them past this and the modal is removed mid-slide.
 */
export const SETTINGS_EXIT_MS = 260

/**
 * Settings, over the page you were on rather than instead of it.
 *
 * On a phone Settings is a place you dip into and come straight back out of —
 * change the theme, check a dead letter — and as an ordinary route that meant
 * unmounting whatever you were reading and rebuilding it, at the top, when you
 * came back. It is a route still (the group screens navigate, and a link to one
 * has to work), but presented over a background location, so the page
 * underneath stays mounted and closing puts you back exactly where you were,
 * scroll position included.
 *
 * There is no dim behind it and no gap around it: this covers the screen. The
 * one thing that stays visible is the settings disc in the header, which has
 * become the X that closes it — which is why the header is raised above this
 * layer while it is open rather than this being raised above everything.
 *
 * `md:hidden` is not needed here because `Layout` only renders this below `md`;
 * a wide screen has a sidebar, and Settings there is a page like any other.
 */
export function SettingsOverlay({ leaving }: { leaving: boolean }) {
  /**
   * The heading, which the pages themselves deliberately do not render — they
   * were written for a top bar that said where you were, and `main` says it on
   * every other screen. This layer has its own scroller, so it has to say it
   * too, or a group screen arrives with a back link and no name on it.
   */
  const { pathname } = useLocation()
  const title =
    pathname === '/settings/rules' ? 'Rules' : (SETTINGS_GROUP_TITLES[pathname] ?? 'Settings')

  return (
    <div
      className={cx(
        // Under a `Sheet` (z-50) and over the tab bar and the FAB (z-40): a
        // confirmation raised from inside Settings has to cover Settings, and
        // Settings has to cover the bar it is standing in front of.
        'absolute inset-0 z-[45] overflow-hidden bg-page',
        leaving ? 'animate-settings-out' : 'animate-settings-in',
      )}
    >
      {/* Its own scroller, with the same top inset as the app's so the first
          card clears the header the X lives in. It deliberately does NOT reuse
          `#app-scroll` — that one belongs to the page underneath, which is
          still sitting at the scroll position we are going to give back. */}
      <div className="h-full overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[var(--header-h,0px)]">
        <div className="px-4 pb-8 pt-4">
          {/* The same treatment `main` gives every other page's title: large,
              at the top of the content, scrolling away with it. */}
          <h1 className="mb-2 text-[1.75rem] font-bold leading-tight tracking-tight">{title}</h1>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            {/* Static beats dynamic in React Router's ranking, so `rules`
                keeps its own page whichever order these two are written in. */}
            <Route path="/settings/rules" element={<RulesPage />} />
            <Route path="/settings/:group" element={<SettingsGroupPage />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}

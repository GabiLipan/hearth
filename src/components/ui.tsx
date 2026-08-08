import {
  Children,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react'
import { X, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import type { Category } from '../lib/db'
import { CategoryIcon } from './CategoryIcon'

export function cx(...parts: (string | false | undefined | null)[]) {
  return parts.filter(Boolean).join(' ')
}

/* ---------- Column layout ---------- */
/**
 * How many columns fit, from a list of `[minWidth, columns]` steps.
 *
 * The column count has to be known in JS rather than left to CSS, because the
 * distribution of items into columns happens in JS — see `Columns`.
 */
export function useColumnCount(steps: [number, number][], base = 1) {
  const read = () => {
    let n = base
    for (const [min, count] of steps) {
      if (window.matchMedia(`(min-width: ${min}px)`).matches) n = count
    }
    return n
  }
  const [count, setCount] = useState(read)
  const key = steps.map(([m, c]) => `${m}:${c}`).join(',')
  useEffect(() => {
    const queries = steps.map(([min]) => window.matchMedia(`(min-width: ${min}px)`))
    const update = () => setCount(read())
    queries.forEach((q) => q.addEventListener('change', update))
    update()
    return () => queries.forEach((q) => q.removeEventListener('change', update))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return count
}

/**
 * Lay children out in balanced columns, shortest column first.
 *
 * This replaced CSS `columns`, which was the right tool and worked everywhere
 * except where it mattered: Safari ignores `break-inside: avoid` in a
 * multi-column layout and cuts cards in half at a column boundary, stranding
 * the bottom border of one card at the top of the next column. `column-span`
 * is unreliable there too. Flex columns cannot fragment a child in any engine,
 * because there is no fragmentation context to begin with.
 *
 * The cost is that balancing is ours to do. Children are measured after layout
 * and each is assigned to whichever column is currently shortest, which is what
 * the browser was doing for us before.
 */
export function Columns({
  count,
  gap,
  children,
  className,
}: {
  count: number
  /** Tailwind gap classes, applied both between columns and within them. */
  gap: string
  children: ReactNode
  className?: string
}) {
  const items = Children.toArray(children)
  const [heights, setHeights] = useState<number[]>([])
  const nodes = useRef<(HTMLDivElement | null)[]>([])

  useLayoutEffect(() => {
    const measure = () =>
      setHeights((prev) => {
        // A ref can be momentarily null while React moves a node between
        // columns; keeping the last known height stops that reading as zero
        // and reshuffling everything.
        const next = nodes.current.map((el, i) => el?.offsetHeight ?? prev[i] ?? 0)
        return next.length === prev.length && next.every((h, i) => h === prev[i]) ? prev : next
      })
    const observer = new ResizeObserver(measure)
    nodes.current.forEach((el) => el && observer.observe(el))
    measure()
    return () => observer.disconnect()
  }, [items.length])

  const columns = useMemo(() => {
    const buckets: number[][] = Array.from({ length: count }, () => [])
    // Fill the columns *in order*, the way CSS columns did — an item goes to
    // the column its own midpoint lands in, so reading down column one and on
    // to column two follows the order the items were arranged in. Assigning
    // each item to whichever column is currently shortest balances marginally
    // better and scrambles that order, which on a dashboard someone has
    // arranged by hand is the worse trade.
    let total = 0
    for (let i = 0; i < items.length; i++) total += heights[i] ?? 1
    const target = total / count
    let filled = 0
    items.forEach((_, i) => {
      const height = heights[i] ?? 1
      const col = target > 0 ? Math.min(count - 1, Math.floor((filled + height / 2) / target)) : i % count
      buckets[col].push(i)
      filled += height
    })
    return buckets
  }, [items.length, count, heights])

  return (
    <div className={cx('flex items-start', gap, className)}>
      {columns.map((indices, col) => (
        <div key={col} className={cx('flex min-w-0 flex-1 flex-col', gap)}>
          {indices.map((i) => (
            <div
              key={i}
              ref={(el) => {
                nodes.current[i] = el
              }}
              // A child that renders nothing must not still occupy a gap.
              className="empty:hidden"
            >
              {items[i]}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/* ---------- Card ---------- */
export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cx(
        'rounded-2xl bg-surface ring-1 ring-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)] md:rounded-xl',
        onClick && 'cursor-pointer transition-transform active:scale-[0.99]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * The heading above a settings block.
 *
 * It carries no top margin: the space above a section belongs to the section,
 * not to its title. This used to be `mt-6 first:mt-0`, written when the titles
 * were siblings in one long column — once each was wrapped in its own
 * `<section>` for the column layout, every title became a `:first-child` and
 * the reset silently cancelled the margin on all of them, leaving each heading
 * jammed against the card above it. The gap now lives on the section.
 */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between px-1 md:mb-1.5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-3 md:text-xs">{children}</h2>
      {action}
    </div>
  )
}

/* ---------- Buttons ---------- */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: BtnProps) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors md:rounded-lg',
        'disabled:opacity-40 disabled:pointer-events-none',
        // Touch targets on mobile, tighter hit areas for a precise cursor.
        size === 'sm' && 'h-8 px-3 text-sm desktop:h-7 desktop:px-2.5 desktop:text-xs',
        size === 'md' && 'h-10 px-4 text-sm desktop:h-9 desktop:px-3.5',
        size === 'lg' && 'h-12 px-5 text-base desktop:h-10 desktop:px-4 desktop:text-sm',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2',
        variant === 'subtle' && 'bg-surface-2 text-ink hover:brightness-97 dark:hover:brightness-110',
        variant === 'danger' && 'bg-critical/10 text-critical-text hover:bg-critical/15',
        className,
      )}
      {...rest}
    />
  )
}

/* ---------- Inputs ---------- */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props
  return (
    <input
      className={cx(
        'h-11 w-full rounded-xl bg-surface-2 px-3.5 text-ink placeholder:text-ink-3',
        'desktop:h-9 md:rounded-lg desktop:px-3 md:text-sm',
        'ring-1 ring-transparent outline-none focus:ring-2 focus:ring-accent/60 transition-shadow',
        className,
      )}
      {...rest}
    />
  )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props
  return (
    <select
      className={cx(
        'h-11 w-full appearance-none rounded-xl bg-surface-2 px-3.5 text-ink',
        'desktop:h-9 md:rounded-lg desktop:px-3 md:text-sm',
        'ring-1 ring-transparent outline-none focus:ring-2 focus:ring-accent/60',
        className,
      )}
      {...rest}
    />
  )
}

/* ---------- Segmented control ---------- */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  const selected = Math.max(0, options.findIndex((o) => o.value === value))
  const trackRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)

  /**
   * Options are sized to their content, not to an equal share.
   *
   * Equal shares are cheaper — the thumb is then pure arithmetic and needs no
   * measurement — but they make the LONGEST label decide the width of the whole
   * control. "Our household · Mine · Everything" then needs room for three
   * "Our household"s, and what does not fit gets clipped mid-word, which looks
   * like a rendering fault rather than a space problem. `flex: 1 1 auto` starts
   * from each label's own width and shares the slack, so everything fits and a
   * long option is simply wider than a short one.
   *
   * The cost is that the thumb has to be measured. Two things follow, both of
   * which have bitten this codebase before:
   *
   *   - it is read from live geometry rather than remembered, so a resize, a
   *     font finally loading, or the labels swapping at a breakpoint all put it
   *     back in the right place;
   *   - it does not animate until it has been measured once, or the first paint
   *     would slide it in from the left edge of a control nobody has touched.
   */
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return

    const measure = () => {
      const el = track.querySelectorAll<HTMLElement>('[role="tab"]')[selected]
      if (!el) return
      setThumb({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()

    // The track resizing covers a window resize and a breakpoint change; the
    // buttons resizing covers a web font arriving after first paint, which
    // changes their widths without changing the track's.
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    for (const el of track.querySelectorAll('[role="tab"]')) ro.observe(el)
    return () => ro.disconnect()
  }, [selected, options.length])

  return (
    <div
      ref={trackRef}
      className={cx(
        'relative flex rounded-xl bg-surface-2 p-1 [--seg-pad:0.25rem] md:rounded-lg md:p-0.5 md:[--seg-pad:0.125rem]',
        className,
      )}
      role="tablist"
    >
      <span
        aria-hidden
        className={cx(
          'absolute inset-y-1 rounded-lg bg-surface shadow-sm ring-1 ring-hairline md:inset-y-0.5 md:rounded-md',
          thumb && 'transition-[left,width] duration-200 ease-out motion-reduce:transition-none',
        )}
        style={
          thumb
            ? { left: thumb.left, width: thumb.width }
            : // Before the first measurement, an equal share is the best guess
              // and is exactly right whenever the labels happen to be the same
              // length. It never animates from here.
              {
                left: `calc(var(--seg-pad) + (100% - var(--seg-pad) * 2) * ${selected} / ${options.length})`,
                width: `calc((100% - var(--seg-pad) * 2) / ${options.length})`,
              }
        }
      />
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            // `min-w-0` + `truncate` rather than letting a long label wrap: the
            // sliding thumb is positioned arithmetically from an equal share of
            // the width, so a two-line option makes the control taller than the
            // thumb and the selection stops covering what it selected.
            // `flex-auto` (1 1 auto), not `flex-1` (1 1 0%): width starts from
            // the label and the slack is shared, so a long option is wider than
            // a short one instead of every option being as wide as the longest.
            'relative min-w-0 flex-auto truncate whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors md:rounded-md md:px-2.5 desktop:py-1',
            value === o.value ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Modal / bottom sheet ---------- */

/**
 * Tracks the visual viewport so a sheet stays inside the space the on-screen
 * keyboard leaves behind. On iOS the layout viewport doesn't shrink when the
 * keyboard opens, so a bottom-anchored sheet would otherwise slide behind it —
 * hiding its inputs and action button. Sizing the sheet's frame to
 * `visualViewport` keeps everything above the keyboard.
 *
 * `keyboard` is what the keyboard covers: the layout viewport is still the full
 * screen and the page keeps painting behind it, so a sheet that stops at the
 * visual viewport's edge leaves the page showing through underneath. See the
 * filler in `Sheet`.
 *
 * `below` is the opposite and much rarer: the screen carrying on *past* the
 * bottom of the layout viewport, which is iOS handing a standalone app a
 * viewport that stops short of the display. Anything anchored to `bottom: 0`
 * then floats above the bottom of the screen. It is zero in every ordinary
 * case, including with the keyboard up — a keyboard never makes the visible
 * area larger than the viewport — so it is only ever a correction.
 */
export function useViewportInset() {
  const measure = () => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport
    if (!vv) return { height: typeof window === 'undefined' ? 0 : window.innerHeight, top: 0, keyboard: 0, below: 0 }
    return {
      height: vv.height,
      top: vv.offsetTop,
      keyboard: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
      below: Math.max(0, vv.height + vv.offsetTop - window.innerHeight),
    }
  }
  const [inset, setInset] = useState(measure)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setInset(measure)
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return inset
}

/** Where a sheet grows from: the centre of the control that opened it, in viewport coordinates. */
export type Origin = { x: number; y: number }

/** Reads the origin off the event that opened a sheet. */
export function originOf(e: { currentTarget: Element }): Origin {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/**
 * The last control pressed, so a sheet can grow out of whatever opened it
 * without being told which button that was.
 *
 * A sheet nearly always opens because something was pressed, and that something
 * is where it belongs — but the button and the sheet are usually far apart in
 * the tree, and handing an origin down from seventeen openers is a great deal
 * of ceremony for one animation, with a new place to forget it every time a
 * sheet is added. One capture-phase listener knows the answer for all of them.
 *
 * `pointerdown` rather than `click`, because a press that turns into a scroll
 * never becomes a click — and the press is the moment the user pointed at
 * something. A sheet that opens for any other reason finds nothing recent here
 * and slides up instead, which is the right thing: there is nowhere to grow
 * from.
 */
const TAP_GRACE_MS = 800
let lastTap: (Origin & { at: number }) | null = null
let listening = false

function watchTaps() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener(
    'pointerdown',
    (e) => {
      const control = (e.target as Element | null)?.closest?.('button, a, [role="button"], label')
      const box = control?.getBoundingClientRect()
      lastTap =
        box && box.width
          ? { x: box.left + box.width / 2, y: box.top + box.height / 2, at: performance.now() }
          : { x: e.clientX, y: e.clientY, at: performance.now() }
    },
    true,
  )
}

function tapOrigin(): Origin | undefined {
  if (!lastTap || performance.now() - lastTap.at > TAP_GRACE_MS) return undefined
  return { x: lastTap.x, y: lastTap.y }
}

/**
 * Keeps a sheet mounted long enough to animate itself out.
 *
 * `open` going false is the *start* of the close, not the end of it — unmount
 * on the spot and the sheet vanishes mid-gesture. The extra phase must outlast
 * the longest exit animation in `index.css`.
 */
const EXIT_MS = 260
function useSheetPhase(open: boolean) {
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>(open ? 'open' : 'closed')
  useEffect(() => {
    if (open) {
      setPhase('open')
      return
    }
    setPhase((was) => (was === 'closed' ? 'closed' : 'closing'))
    const timer = setTimeout(() => setPhase('closed'), EXIT_MS)
    return () => clearTimeout(timer)
  }, [open])
  return phase
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  origin,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Sticky action bar pinned to the bottom of the sheet, always above the keyboard. */
  footer?: ReactNode
  wide?: boolean
  /**
   * Expand out of (and collapse back into) this point. Optional: without it the
   * sheet grows from whatever was pressed just before it opened.
   */
  origin?: Origin
}) {
  const inset = useViewportInset()
  const phase = useSheetPhase(open)
  const shown = phase !== 'closed'
  useEffect(watchTaps, [])

  /**
   * Where this sheet grew from, settled at the moment it opened.
   *
   * It has to be remembered rather than asked for again on the way out: by then
   * the most recent press is the close button, and the sheet would collapse
   * into its own corner rather than back into whatever opened it.
   */
  const grewFrom = useRef<Origin | undefined>(undefined)
  const wasOpen = useRef(false)
  if (open !== wasOpen.current) {
    if (open) grewFrom.current = origin ?? tapOrigin()
    wasOpen.current = open
  }
  const from = grewFrom.current

  /**
   * What the sheet looked like when it was last open.
   *
   * Callers clear the thing being edited in the same breath as they close —
   * `onClose={() => setEditing(null)}` — so by the time the exit animation
   * starts the title has become "New account" and the delete button has gone.
   * A sheet on its way out should look like the sheet that was there; it is
   * leaving, not changing.
   */
  const held = useRef({ title, children, footer })
  if (open) held.current = { title, children, footer }
  const view = open ? { title, children, footer } : held.current

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Held for the whole of the exit too — releasing it early lets the page
  // behind jump back to its scroll position while the sheet is still leaving.
  useEffect(() => {
    if (!shown) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [shown])

  if (!shown) return null
  const leaving = phase === 'closing'
  return (
    <div className="fixed inset-0 z-50">
      <div
        className={cx('absolute inset-0 bg-black/40', leaving ? 'animate-fade-out' : 'animate-fade')}
        onClick={onClose}
      />
      {/* The sheet's surface, continued past the bottom of the visual viewport.
          iOS shrinks that viewport for the keyboard but keeps painting the page
          behind it, so without this the sheet stops dead at the keyboard's top
          edge and the dimmed page shows through the strip below it. Overshoots
          deliberately: the gap is sometimes taller than the keyboard alone, and
          anything past the screen simply isn't painted. */}
      {inset.keyboard > 0 && (
        <div
          aria-hidden
          className={cx('absolute inset-x-0 h-[60vh] bg-surface sm:hidden', leaving ? 'animate-fade-out' : 'animate-fade')}
          style={{ top: inset.top + inset.height }}
        />
      )}
      <div
        onClick={onClose}
        className={cx(
          'absolute inset-x-0 flex items-end justify-center sm:items-center',
          // Clear of the status bar and the dynamic island: without this the
          // sheet's top edge lands underneath the island on a modern iPhone,
          // and the keyboard shrinking the viewport pulls it higher still.
          'pt-[max(calc(env(safe-area-inset-top)+0.75rem),1.5rem)] sm:pt-0',
          from && (leaving ? 'animate-origin-out' : 'animate-origin'),
        )}
        style={{
          top: inset.top,
          height: inset.height || undefined,
          // Relative to this frame's own box, which starts at the viewport inset.
          transformOrigin: from ? `${from.x}px ${from.y - inset.top}px` : undefined,
        }}
      >
        <div
          role="dialog"
          aria-label={view.title}
          onClick={(e) => e.stopPropagation()}
          className={cx(
            // Always leave a strip of backdrop above the sheet so tap-to-dismiss
            // has a target, even when the keyboard has shrunk the viewport.
            'relative flex max-h-full w-full flex-col overflow-hidden bg-surface sm:max-h-[92%]',
            'rounded-t-3xl sm:rounded-3xl sm:shadow-2xl md:rounded-2xl',
            wide ? 'sm:max-w-2xl lg:max-w-3xl' : 'sm:max-w-md lg:max-w-lg',
            // With an origin the whole frame scales out of the button, so the
            // sheet must not also travel inside it.
            !from && (leaving ? 'animate-sheet-out' : 'animate-sheet'),
            // Nothing in a sheet that has already been dismissed is clickable —
            // what is on screen during the exit is a picture of the old one.
            leaving && 'pointer-events-none',
          )}
        >
          <div className="flex items-center justify-between px-5 pb-2 pt-4 md:px-4 md:pt-3">
            <h2 className="text-lg font-semibold md:text-base">{view.title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink active:scale-95"
            >
              <X size={16} />
            </button>
          </div>
          <div
            className={cx(
              'overflow-y-auto px-5 md:px-4',
              view.footer ? 'pb-3' : 'pb-[max(1.5rem,env(safe-area-inset-bottom))]',
            )}
          >
            {view.children}
          </div>
          {view.footer && (
            // Real bottom padding (not just the safe-area inset, which is 0 on
            // desktop) so the action never jams against the sheet's edge.
            <div className="border-t border-hairline bg-surface px-5 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:px-4 md:pb-3.5">
              {view.footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------- Category chip / icon ---------- */
/**
 * Sized through the `--dot` custom property rather than a fixed pixel prop, so
 * callers can shrink it per breakpoint (e.g. `md:[--dot:26px]`) — desktop rows
 * are denser than the touch-sized ones on a phone. The glyph scales with it.
 */
export function CategoryDot({ category, size = 36, className }: { category?: Category; size?: number; className?: string }) {
  const colour = category ? `var(--series-${category.slot})` : 'var(--ink-3)'
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center rounded-full',
        'size-[var(--dot)] [&_svg]:size-[calc(var(--dot)*0.52)]',
        className,
      )}
      style={{
        ['--dot' as string]: `${size}px`,
        background: category ? `color-mix(in oklab, ${colour} 16%, var(--surface-2))` : 'var(--surface-2)',
        color: colour,
      }}
      aria-hidden
    >
      <CategoryIcon icon={category?.icon} size={Math.round(size * 0.52)} />
    </span>
  )
}

/* ---------- Progress bar (budgets) ---------- */
export function Progress({ fraction, tone, className }: { fraction: number; tone: 'ok' | 'warn' | 'over'; className?: string }) {
  const color = tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warning)' : 'var(--critical)'
  return (
    <div className={cx('h-2 w-full overflow-hidden rounded-full bg-surface-2 md:h-1.5', className)}>
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%`, background: color }}
      />
    </div>
  )
}

/* ---------- Chip ---------- */
/**
 * A small label: a permission level, a role, the "you" marker.
 *
 * These were three hand-rolled spans in three files before permissions arrived
 * and needed a fourth.
 */
export function Chip({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'warn'
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-surface-2 text-ink-3',
        tone === 'accent' && 'bg-accent/10 text-accent',
        tone === 'warn' && 'bg-warning/15 text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ---------- Empty state ---------- */
export function Empty({ icon: Icon, title, hint, action }: { icon: LucideIcon; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 py-12 text-center md:gap-2 md:py-10">
      <div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-ink-3 md:size-12 md:rounded-xl" aria-hidden>
        <Icon size={26} strokeWidth={1.75} />
      </div>
      <p className="font-medium text-ink-2">{title}</p>
      {hint && <p className="max-w-xs text-sm text-ink-3 md:max-w-md">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/* ---------- Toolbar ---------- */
/**
 * The row of controls that sits above a page's content. Centred and roomy on a
 * phone, left-aligned and compact under a cursor — every page uses this so the
 * two form factors stay consistent with each other.
 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-3 flex flex-wrap items-center gap-2 md:mb-2.5 md:gap-1.5', className)}>{children}</div>
  )
}

/* ---------- Month stepper ---------- */
export function MonthStepper({
  month,
  onChange,
  label,
  canGoForward = true,
}: {
  month: string
  onChange: (next: string) => void
  /** Formats the month key for display. */
  label: (key: string) => string
  canGoForward?: boolean
}) {
  const step = (delta: number) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return (
    <div className="flex h-11 items-center rounded-xl bg-surface-2 desktop:h-9 md:rounded-lg">
      <button
        className="grid h-full w-9 place-items-center rounded-l-xl text-ink-2 hover:text-ink desktop:w-7 md:rounded-l-lg"
        aria-label="Previous month"
        onClick={() => step(-1)}
      >
        <ChevronLeft size={17} />
      </button>
      <span className="w-32 text-center text-sm font-semibold md:w-28">{label(month)}</span>
      <button
        className="grid h-full w-9 place-items-center rounded-r-xl text-ink-2 hover:text-ink disabled:opacity-30 desktop:w-7 md:rounded-r-lg"
        aria-label="Next month"
        disabled={!canGoForward}
        onClick={() => step(1)}
      >
        <ChevronRight size={17} />
      </button>
    </div>
  )
}

/* ---------- Dense table (desktop) ---------- */
/** Shared classes so every desktop table in the app reads as one component. */
export const table = {
  head: 'border-b border-hairline text-left text-xs font-medium uppercase tracking-wide text-ink-3',
  th: 'py-1.5 font-medium',
  row: 'group border-b border-hairline last:border-0 hover:bg-surface-2/50',
  cell: 'py-2 desktop:py-1.5',
  /**
   * Put on the first `th` and `td` of a scrolling table to pin that column.
   *
   * It needs its own background: a sticky cell is painted over by the cells
   * sliding beneath it otherwise. `--surface` is the Card it sits in, so the
   * pinned column looks continuous with the card rather than like a panel.
   *
   * Both backgrounds must be **opaque**. It repeats the row's hover tint, and
   * the first version used `surface-2/50` to match the row exactly — 50% alpha,
   * through which the scrolled-under columns were plainly visible the moment
   * you hovered a row. `--row-hover` is that same tint resolved to a solid
   * colour.
   */
  pinned: 'sticky left-0 z-10 bg-surface group-hover:bg-row-hover',
}

/**
 * A table that scrolls sideways rather than squashing.
 *
 * Below `minWidth` the columns would start crushing their contents — long
 * payees truncate to nothing, charts shrink past the point of being readable —
 * so past that the table keeps its width and the container scrolls, with the
 * first column pinned so you never lose track of which row you are reading.
 */
export function ScrollTable({
  minWidth,
  className,
  children,
}: {
  /** Width below which the table stops shrinking and starts scrolling. */
  minWidth: number
  className?: string
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto overscroll-x-contain">
      <table className={cx('w-full text-sm', className)} style={{ minWidth }}>
        {children}
      </table>
    </div>
  )
}

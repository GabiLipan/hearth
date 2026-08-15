import {
  Children,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, ChevronDown, Info, type LucideIcon } from 'lucide-react'
import type { Account, Category } from '../lib/db'
import { accountFace } from '../lib/accounts'
import { slotVar } from '../lib/palette'
import { viewportInset, type Inset } from '../lib/viewport'
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
 * A screen wide enough for the `md:` layouts — a tablet or a desktop.
 *
 * Deliberately width only, where `useDesktop` is width AND a precise pointer.
 * The two answer different questions: `useDesktop` gates hit targets and
 * hover-driven behaviour, so an iPad must fail it; this gates *how much fits on
 * one screen*, where an iPad is on the roomy side of the line. Settings is the
 * case that needs the distinction — a tablet gets the whole page in columns, a
 * phone gets an index of sections it can walk into.
 */
export function useWide(): boolean {
  const query = '(min-width: 768px)'
  const [is, setIs] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setIs(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return is
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
/**
 * The resting shadow is a token, not a literal.
 *
 * It used to be `0 1px 2px rgba(0,0,0,0.04)` in both themes, which in the dark
 * one is a shadow against a #0d0d0d page — invisible, so every card was
 * separated from the page by its 10%-white hairline and nothing else. See
 * `--elev-1` / `--elev-2` in index.css.
 *
 * A card that does something on being pressed also says so before it is
 * pressed: it lifts to the raised step under a cursor and settles back on
 * press. The lift is `translate` and the press is `scale`, which in Tailwind v4
 * are separate CSS properties rather than two halves of one `transform`, so
 * they compose instead of overwriting each other. `desktop:` on the hover half,
 * since a lift is a hover affordance and a finger has no hover to give it.
 */
export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cx(
        'rounded-2xl bg-surface ring-1 ring-hairline shadow-card md:rounded-xl',
        onClick &&
          cx(
            'cursor-pointer transition-[box-shadow,translate,scale] duration-200 ease-out motion-reduce:transition-none',
            'desktop:hover:-translate-y-px desktop:hover:shadow-raised',
            'active:scale-[0.99] active:shadow-card desktop:active:translate-y-0',
          ),
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * A card's own heading: a title on the left, and whatever the card wants to say
 * about itself on the right — a total, a link to the full page.
 *
 * This was six hand-rolled copies of the same flex row, with the gap under it
 * written `mb-1`, `mb-2` and `mb-3` and only one of them carrying a `md:` step.
 * Stacked in a masonry column, adjacent cards had title-to-content gaps eight
 * pixels apart — the same argument `CONTROL_H` exists for, one row further up.
 *
 * `items-baseline` so a small figure on the right sits on the title's baseline
 * rather than being centred against its cap height.
 */
export function CardHeader({
  title,
  action,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('mb-2 flex items-baseline justify-between gap-2 md:mb-1.5', className)}>
      <h3 className="min-w-0 truncate font-semibold md:text-sm">{title}</h3>
      {action}
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

/**
 * The height of anything that can sit in a row with anything else.
 *
 * Toolbars mix a search box, a select, a segmented control, a month stepper and
 * a button, and each of those used to arrive at its height its own way — some
 * from `h-*`, some from padding plus a line box. They landed 4px apart, which
 * is not enough to look deliberate and is plenty to look broken.
 *
 * So: one token, and every control in that list wears it. A control sized by
 * padding is the thing to avoid — its height then depends on the font, the
 * label and the breakpoint, and it drifts the moment any of those change.
 */
export const CONTROL_H = 'h-11 desktop:h-9'

/* ---------- Buttons ---------- */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  size?: 'sm' | 'md' | 'lg'
  /**
   * React 19 passes `ref` as an ordinary prop, so it rides along in `rest` and
   * needs no `forwardRef` — it just has to be declared, because
   * `ButtonHTMLAttributes` does not carry it.
   */
  ref?: Ref<HTMLButtonElement>
}

/**
 * `type` defaults to `button`, not to the platform's `submit`.
 *
 * A sheet that takes an `onSubmit` wraps its body and footer in a real `<form>`,
 * and inside a form every button with no type is a submit button — so the Delete
 * button beside "Save changes" would save the row it was about to remove. The
 * one button that submits says so; everything else is inert by default, which is
 * the safer way round for a component used in ninety places.
 */
export function Button({ variant = 'primary', size = 'md', type = 'button', className, ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors md:rounded-lg',
        'disabled:opacity-40 disabled:pointer-events-none',
        // Touch targets on mobile, tighter hit areas for a precise cursor.
        size === 'sm' && 'h-8 px-3 text-sm desktop:h-7 desktop:px-2.5 desktop:text-xs',
        // `md` is the toolbar size, so it is CONTROL_H exactly. `sm` (inline in
        // a list) and `lg` (a sheet's action bar) never sit beside an input.
        size === 'md' && 'h-11 px-4 text-sm desktop:h-9 desktop:px-3.5',
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

/* ---------- Explaining a control without shouting ---------- */
/**
 * The ⓘ that puts a paragraph away until it is asked for.
 *
 * Every long explanation in this app is worth having and almost none of it is
 * worth having *every* time. The consent on a household payment ran to three
 * paragraphs standing permanently above the note field — read once, understood,
 * and then in the way for ever, on a form that is opened several times a day.
 *
 * Deliberately a disclosure that pushes the content in below, rather than a
 * `Popover`: these live inside sheets, and `Popover` portals its panel at `z-40`
 * where `Sheet` is `z-50`, so the panel would open *behind* the form it belongs
 * to. Growing the sheet instead is free — `useMorphHeight` is already animating
 * its body between the shapes its contents take, so the paragraph slides in.
 *
 * `aria-expanded` plus `aria-controls` is the whole accessibility story: the
 * text is in the document, in reading order, right after the thing it explains.
 * Nothing here is hidden from a screen reader that a sighted reader can see.
 */
function InfoToggle({ open, controls, onClick, label }: { open: boolean; controls: string; onClick: () => void; label: string }) {
  return (
    <button
      // Inside a `<form>` a button with no type submits it, and every one of
      // these sits inside one.
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Hide what this means: ${label}` : `What does this mean? ${label}`}
      className={cx(
        'grid size-7 shrink-0 place-items-center rounded-full transition-colors',
        open ? 'bg-ink/10 text-ink-2' : 'text-ink-3 hover:bg-ink/5 hover:text-ink-2',
      )}
    >
      <Info size={16} />
    </button>
  )
}

/** The revealed paragraphs. A `<div>` of `<p>`s, spaced, in the quiet size. */
function InfoBody({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <div id={id} className={cx('animate-fade space-y-2 text-xs leading-relaxed text-ink-3 [&_p]:m-0', className)}>
      {children}
    </div>
  )
}

/** The state behind one ⓘ. Its own hook so the id and the flag cannot drift apart. */
function useInfo(has: boolean) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return { id, open: has && open, toggle: () => setOpen((o) => !o) }
}

/* ---------- Inputs ---------- */
/**
 * A labelled control, with two grades of explanation under it.
 *
 * `hint` is the short one and is always visible — a unit, a format, a default.
 * `info` is the paragraph, and it hides behind a ⓘ beside the label. A hint
 * that needs a comma is probably an `info`.
 */
export function Field({
  label,
  children,
  hint,
  info,
}: {
  label: string
  children: ReactNode
  hint?: string
  info?: ReactNode
}) {
  const i = useInfo(!!info)
  const inner = (
    // The `<label>` has to go on wrapping the control: `Field` never sees the
    // child's id, so this implicit association is the only one available.
    <label className="block">
      <span className={cx('mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs', !!info && 'pr-8')}>
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  )
  if (!info) return inner
  return (
    // The ⓘ and its paragraph sit OUTSIDE the label, and the ⓘ is placed back
    // onto the heading line rather than being nested into it. Anything inside a
    // label is part of the control's accessible name — including a descendant
    // button's — so a nested ⓘ would rename the field to "Role What does this
    // mean?", and an open paragraph would append itself to that.
    <div className="relative">
      {inner}
      <span className="absolute -top-1 right-0">
        <InfoToggle open={i.open} controls={i.id} onClick={i.toggle} label={label} />
      </span>
      {i.open && (
        <InfoBody id={i.id} className="mt-1.5">
          {info}
        </InfoBody>
      )}
    </div>
  )
}

/**
 * A tick box whose consequences need a paragraph.
 *
 * The row itself is one line — box, name, ⓘ — because that is what you read
 * when you already know what it does, which is nearly always. `status` is the
 * exception: a single short line for what is *true right now* rather than what
 * the setting means, because that genuinely changes and cannot be learned once.
 * Everything else goes behind the ⓘ.
 *
 * `children` is for controls that belong to the tick box, not for more prose.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  status,
  info,
  tone = 'plain',
  disabled,
  children,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  /** One short line of current state. Not an explanation. */
  status?: ReactNode
  /** The explanation, behind the ⓘ. */
  info?: ReactNode
  /** `plain` is the filled panel; `bare` sits on whatever is behind it. */
  tone?: 'plain' | 'accent' | 'bare'
  disabled?: boolean
  children?: ReactNode
}) {
  const i = useInfo(!!info)
  return (
    <div
      className={cx(
        tone === 'bare' ? '' : 'rounded-xl px-4 py-3',
        tone === 'plain' ? 'bg-surface-2' : '',
        tone === 'accent' ? 'bg-accent/8 ring-1 ring-accent/20' : '',
      )}
    >
      <div className="flex items-center gap-3">
        <label className={cx('flex min-w-0 flex-1 items-center gap-3', disabled ? '' : 'cursor-pointer')}>
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            className="size-5 shrink-0 accent-[var(--accent)]"
          />
          <span className="min-w-0 text-sm font-medium">{label}</span>
        </label>
        {info && <InfoToggle open={i.open} controls={i.id} onClick={i.toggle} label={typeof label === 'string' ? label : ''} />}
      </div>
      {/* Indented to the label above: box (1.25rem) plus gap (0.75rem). */}
      {status && <p className="mt-1 ml-8 text-xs text-ink-3">{status}</p>}
      {info && i.open && (
        <InfoBody id={i.id} className="mt-2 ml-8">
          {info}
        </InfoBody>
      )}
      {children && <div className="mt-2.5 ml-8">{children}</div>}
    </div>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props
  return (
    <input
      className={cx(
        CONTROL_H,
        'w-full rounded-xl bg-surface-2 px-3.5 text-ink placeholder:text-ink-3',
        'md:rounded-lg desktop:px-3 md:text-sm',
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
        CONTROL_H,
        'w-full appearance-none rounded-xl bg-surface-2 px-3.5 text-ink',
        'md:rounded-lg desktop:px-3 md:text-sm',
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
  label,
}: {
  options: { value: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  className?: string
  /**
   * What the group as a whole is choosing between.
   *
   * A radio group needs a name — the options say "Expense" and "Income", and
   * nothing said what they were two answers TO. Optional because several of
   * these sit directly under a heading that already says it.
   */
  label?: string
}) {
  const selected = Math.max(0, options.findIndex((o) => o.value === value))
  const track = useRef<HTMLDivElement>(null)
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
    const bar = track.current
    if (!bar) return

    const measure = () => {
      const el = bar.querySelectorAll<HTMLElement>('[role="radio"]')[selected]
      if (!el) return
      setThumb({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()

    // The track resizing covers a window resize and a breakpoint change; the
    // buttons resizing covers a web font arriving after first paint, which
    // changes their widths without changing the track's.
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    for (const el of bar.querySelectorAll('[role="radio"]')) ro.observe(el)
    return () => ro.disconnect()
  }, [selected, options.length])

  return (
    <div
      ref={track}
      className={cx(
        // Height from the token, not from the options' padding: this control
        // sits next to a search box in four different toolbars, and deriving
        // its height from a line box put it 4px short of one.
        CONTROL_H,
        'relative flex rounded-xl bg-surface-2 p-1 [--seg-pad:0.25rem] md:rounded-lg md:p-0.5 md:[--seg-pad:0.125rem]',
        className,
      )}
      // A RADIOGROUP, not a tablist. It was announced as "tab 2 of 3" and then
      // did nothing on an arrow key, because there are no tab panels here and
      // never were — every use of this control picks a value (Expense/Income,
      // which book, how many months), which is what a radio group is. The lie
      // was the accessible name for a segmented control being read as
      // navigation.
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (!delta) return
        e.preventDefault()
        // Wraps, as a radio group does, and moves the selection with the focus
        // — an arrow key in a radio group CHOOSES rather than merely pointing.
        const next = (selected + delta + options.length) % options.length
        onChange(options[next].value)
        track.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
      }}
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
          // Every raw button in a shared control carries an explicit type: any
          // of these can end up inside a sheet that takes an `onSubmit`, and an
          // untyped button in a form submits it. Choosing "Income" must not
          // save the transaction.
          type="button"
          role="radio"
          aria-checked={value === o.value}
          // One stop for the whole group, which is what makes the arrow keys
          // above the way through it rather than an extra.
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cx(
            // `min-w-0` + `truncate` rather than letting a long label wrap: the
            // sliding thumb is positioned arithmetically from an equal share of
            // the width, so a two-line option makes the control taller than the
            // thumb and the selection stops covering what it selected.
            // `flex-auto` (1 1 auto), not `flex-1` (1 1 0%): width starts from
            // the label and the slack is shared, so a long option is wider than
            // a short one instead of every option being as wide as the longest.
            // `h-full` rather than vertical padding — the track owns the
            // height now. Left as a plain button rather than a flex box so
            // `truncate` still applies to the label; a button centres its own
            // content vertically without being told to.
            'relative h-full min-w-0 flex-auto truncate whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors md:rounded-md md:px-2.5',
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
 *
 * ## `bounce`, and why it is not simply the negative half of `below`
 *
 * Rubber-banding past the end of a page slides the visual viewport off the
 * layout viewport, and `position: fixed` is resolved against the LAYOUT one —
 * so the tab bar travels off the bottom of the screen and comes back when the
 * bounce settles. It is not positioned wrongly; the thing it is positioned
 * against is what moved. Nothing in CSS can opt a fixed element out of that,
 * which leaves either killing the bounce (it is wanted) or moving the bar back
 * by however far the viewport has slid. This is that number.
 *
 * The catch is that an open keyboard slides the visible area the same way and
 * by the same sign, and the bar must NOT be dragged up over a keyboard. The
 * arithmetic that tells them apart is `viewportInset` in `lib/viewport.ts`,
 * where it can be asserted against numbers instead of against a browser.
 */
export function useViewportInset(): Inset {
  const measure = (): Inset => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport
    const h = typeof window === 'undefined' ? 0 : window.innerHeight
    if (!vv) return { height: h, top: 0, keyboard: 0, below: 0, bounce: 0 }
    return viewportInset(vv, window.innerHeight)
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

/* ---------- Modal layers ---------- */

/**
 * Every sheet on screen, oldest first.
 *
 * A sheet used to render where it stood in the tree, which made two things
 * impossible to state: what is *underneath* a modal (so it could be taken out
 * of the tab order) and what is on *top* of another one (so the confirmation
 * over a form does not leave the form beneath it still typeable). Both are
 * answers about the whole app rather than about one component, so they live in
 * one module-level list — the same reasoning as `useBook`.
 *
 * Each sheet portals into its own host element under `<body>`, which buys two
 * more things. Being outside `#root` is what lets `#root` be marked `inert`
 * without the sheet inerting itself. And a `position: fixed` element is
 * positioned against the nearest transformed ancestor rather than the viewport,
 * so a sheet opened from a page — Goals, Bills, Settings — used to be measured
 * against `main` while `animate-page-forward` was still running a transform on
 * it, and landed offset for the first 260ms after a page change.
 */
const layerStack: HTMLElement[] = []

/**
 * Takes the app out of the tab order under a modal, and the lower sheets out
 * from under the top one.
 *
 * `inert` is one attribute where the alternative is a hand-written focus trap:
 * it removes the subtree from the tab order, from hit testing and from the
 * accessibility tree at once, which is all three of the things a trap is
 * approximating. Where it is unsupported the app behaves exactly as it did
 * before — the sheet still works, it is just still possible to tab behind it.
 */
function syncLayers() {
  const root = document.getElementById('root')
  if (root) root.inert = layerStack.length > 0
  layerStack.forEach((el, i) => {
    el.inert = i < layerStack.length - 1
  })
  // The scroll lock belongs to the STACK, not to any one sheet. Held per sheet,
  // closing a confirmation over a form released it while the form was still
  // open, and the page behind started scrolling again mid-edit.
  document.body.style.overflow = layerStack.length > 0 ? 'hidden' : ''
}

/**
 * A place under `<body>` for one sheet to render into, and its place in the
 * stack above.
 *
 * The host is attached in a *layout* effect rather than a passive one: a
 * passive effect runs after paint, so the sheet would spend its first frame in
 * a detached node and the entrance animation would start a frame late — on the
 * one animation whose whole job is to look like it came out of the button you
 * just pressed.
 */
function useModalLayer(shown: boolean) {
  const [host] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')))
  useLayoutEffect(() => {
    if (!shown || !host) return
    document.body.appendChild(host)
    layerStack.push(host)
    syncLayers()
    return () => {
      const at = layerStack.indexOf(host)
      if (at !== -1) layerStack.splice(at, 1)
      host.remove()
      syncLayers()
    }
  }, [shown, host])
  return host
}

/**
 * Keeps a sheet mounted long enough to animate itself out.
 *
 * `open` going false is the *start* of the close, not the end of it — unmount
 * on the spot and the sheet vanishes mid-gesture. The extra phase must outlast
 * the longest exit animation in `index.css`, which is `origin-out` at 240ms.
 * A number left behind here cuts the last frames off the animation it exists to
 * wait for, so the two move together.
 */
const EXIT_MS = 280
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

/**
 * The height of a sheet's body, so a change of shape can be animated.
 *
 * A sheet's content is not fixed: an Expense/Income toggle takes a receipt
 * scanner away, choosing a category grows a "move the other eleven too" prompt,
 * a transfer picker unfolds a list. Each of those made the sheet jump to its new
 * size in one frame, which on a bottom-anchored sheet means the whole thing
 * teleports — the top edge is what moves, so the eye follows the wrong part.
 *
 * The natural height is measured on the *content*, and set on the scroller
 * around it. Two things fall out of that split:
 *
 *   - the content is never constrained by the number we write, so there is no
 *     feedback loop between the measurement and the thing being measured;
 *   - the scroller keeps `flex-shrink: 1` inside a `max-h-full` dialog, so a
 *     height taller than the screen is simply capped and scrolls, exactly as it
 *     did before. The number is a target, not a promise.
 *
 * It deliberately does not animate the first measurement: a sheet is already
 * arriving under its own animation, and starting its body from zero height
 * would play a second one against it. That "not the first one" flag is a
 * passive effect rather than a `requestAnimationFrame`, for the reason
 * `BottomTabs` gives: a backgrounded tab never runs the rAF callback, so the
 * transition would stay switched off for the whole life of a sheet that
 * happened to open while the app was away.
 */
function useMorphHeight(mounted: boolean) {
  const content = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  /** False for the first measurement of each opening — see above. */
  const [morph, setMorph] = useState(false)

  useLayoutEffect(() => {
    if (!mounted) {
      setMorph(false)
      return
    }
    const el = content.current
    if (!el) return
    const measure = () => setHeight((prev) => (prev === el.offsetHeight ? prev : el.offsetHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mounted])

  /**
   * Re-measure on every commit, as well as when the observer notices.
   *
   * The observer alone is a frame slower than it looks. Its callback does run
   * before paint, but the `setState` inside it is not in a React event, so the
   * re-render it schedules is ordinary priority and can land in the *next*
   * frame — which on a control you have just pressed reads as the sheet
   * thinking about it before it moves. A layout effect with no dependencies
   * runs synchronously in the same commit as the content change, so the new
   * height is written before the browser paints the old one.
   *
   * It cannot loop: `measure` only sets state when the number actually differs,
   * and the height it writes is on the scroller, never on the content it reads.
   * The observer stays for everything that changes size WITHOUT re-rendering
   * this component — an image arriving, a query landing inside a child.
   */
  useLayoutEffect(() => {
    const el = content.current
    if (!mounted || !el) return
    setHeight((prev) => (prev === el.offsetHeight ? prev : el.offsetHeight))
  })

  // After the first height has been painted, and not before: a passive effect
  // runs after paint, which is exactly the beat that has to pass.
  useEffect(() => {
    if (mounted && height !== undefined) setMorph(true)
  }, [mounted, height])

  return { content, height, morph }
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  origin,
  onSubmit,
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
  /**
   * Makes this sheet a real `<form>`, so Enter saves it.
   *
   * There was no `<form>` anywhere in the app, which meant that pressing Enter
   * in a sheet did nothing at all — while the desktop table's inline editors,
   * over the same rows, committed on Enter. It also means a password manager
   * has a submission to recognise, and the browser has something to autofill
   * into.
   *
   * The primary action then carries `type="submit"`; everything else keeps
   * `Button`'s default `type="button"` and is unaffected.
   */
  onSubmit?: () => void
}) {
  const inset = useViewportInset()
  const phase = useSheetPhase(open)
  const shown = phase !== 'closed'
  const host = useModalLayer(shown)
  const frame = useRef<HTMLDivElement>(null)
  // `shown`, not `open`: the sheet renders nothing until its phase has caught
  // up, so on the render `open` first becomes true there is no content node to
  // measure — and the effect would never run again to find one.
  const morphed = useMorphHeight(shown)
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
  const held = useRef({ title, children, footer, onSubmit })
  if (open) held.current = { title, children, footer, onSubmit }
  const view = open ? { title, children, footer, onSubmit } : held.current

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /**
   * Focus goes into the sheet on the way in, and back where it came from on the
   * way out.
   *
   * The sheet's own frame takes it, rather than the first control inside it: a
   * sheet is read before it is filled in, and focusing the first field would
   * raise the keyboard over the form on a phone before anybody had asked for
   * it. A sheet that genuinely wants a field focused says so itself, as
   * `TransactionForm` does with the amount.
   *
   * Restoring is the half that is invisible until it is missing. Without it,
   * closing a sheet leaves focus on `<body>` — so the next Tab starts from the
   * top of the page rather than from the control that opened the sheet, and a
   * screen reader loses its place entirely.
   */
  const opener = useRef<HTMLElement | null>(null)
  const took = useRef(false)
  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement as HTMLElement | null
    took.current = false
  }, [open])

  /**
   * Focus goes home when the sheet is *gone*, not when it starts leaving.
   *
   * Keyed on `shown` rather than `open` for a reason that cost a debugging
   * round: `open` turns false at the start of the 280ms exit, and until the
   * layer comes off the stack the app root is still `inert` — and focusing
   * into an inert subtree does nothing at all, silently. Restoring at the top
   * of the exit therefore looked exactly like not restoring at all.
   *
   * `useModalLayer` clears the flag in a *layout* effect, and this is a passive
   * one, so by the time this runs the root is interactive again.
   */
  useEffect(() => {
    if (!shown) return
    return () => {
      const back = opener.current
      // `isConnected` because what opened the sheet is quite often gone by the
      // time it closes — the row that was deleted, the chip that was cleared.
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [shown])

  /**
   * `shown` as well as `open`, and this is the same trap `useMorphHeight`
   * carries a note about: on the render where `open` first turns true the phase
   * has not caught up, `Sheet` still returns `null`, and there is no frame to
   * focus. An effect keyed on `open` alone fires exactly once, against a ref
   * that is still null, and never looks again — so the sheet opens with focus
   * left behind on the page underneath, which is precisely the bug this whole
   * change exists to fix. Verified in a browser rather than reasoned about.
   */
  useEffect(() => {
    if (!open || !shown || took.current) return
    took.current = true
    frame.current?.focus({ preventScroll: true })
  }, [open, shown])

  if (!shown || !host) return null
  const leaving = phase === 'closing'
  const body = (
    <>
      {/* The scroller carries the animated height; the padding moved inside
          it so what is measured is the whole of what has to fit. */}
      <div
        className={cx('overflow-y-auto', morphed.morph && 'morph-height')}
        style={{ height: morphed.height }}
      >
        <div
          ref={morphed.content}
          className={cx('px-5 md:px-4', view.footer ? 'pb-3' : 'pb-[max(1.5rem,env(safe-area-inset-bottom))]')}
        >
          {view.children}
        </div>
      </div>
      {view.footer && (
        // Real bottom padding (not just the safe-area inset, which is 0 on
        // desktop) so the action never jams against the sheet's edge.
        <div className="border-t border-hairline bg-surface px-5 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:px-4 md:pb-3.5">
          {view.footer}
        </div>
      )}
    </>
  )
  return createPortal(
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
          ref={frame}
          role="dialog"
          aria-modal="true"
          aria-label={view.title}
          // Focusable only programmatically: this is where focus lands when the
          // sheet opens, and it must not become a stop of its own on the way
          // through.
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          className={cx(
            'outline-none',
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
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors hover:text-ink active:scale-95"
            >
              <X size={16} />
            </button>
          </div>
          {view.onSubmit ? (
            /* `min-h-0` so the form can be squeezed by `max-h-full` above it:
               the scroller inside is allowed to shrink because `overflow-y:
               auto` zeroes its automatic minimum size, and an ordinary flex
               item between the two would put that minimum back and let a tall
               sheet grow past the screen instead of scrolling.
               `noValidate` because every field here is already gated by
               `canSave`, and a native validation bubble would be the one piece
               of unstyled browser UI left in a sheet. */
            <form
              noValidate
              className="flex min-h-0 flex-col"
              onSubmit={(e) => {
                e.preventDefault()
                view.onSubmit?.()
              }}
            >
              {body}
            </form>
          ) : (
            body
          )}
        </div>
      </div>
    </div>,
    host,
  )
}

/* ---------- Category chip / icon ---------- */
/**
 * Sized through the `--dot` custom property rather than a fixed pixel prop, so
 * callers can shrink it per breakpoint (e.g. `md:[--dot:26px]`) — desktop rows
 * are denser than the touch-sized ones on a phone. The glyph scales with it.
 */
/**
 * The badge itself: a slot colour, an icon, and a shape saying which axis you
 * are reading. Everything below is this with its arguments worked out.
 *
 * It exists because the recipe — the icon at 52% of the box, on a 16% mix of
 * the slot colour into `--surface-2` — had been written out three times by
 * hand, and the third copy (a goal, in `Goals.tsx`) had already drifted to a
 * different size and a different icon scale.
 */
export function Face({
  slot,
  icon,
  shape = 'circle',
  size = 36,
  className,
}: {
  /** A palette slot, or undefined for the unstyled grey. */
  slot?: number
  icon?: string
  shape?: 'circle' | 'square'
  size?: number
  className?: string
}) {
  const colour = slot ? slotVar(slot) : 'var(--ink-3)'
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center',
        shape === 'circle' ? 'rounded-full' : 'rounded-[calc(var(--dot)*0.3)]',
        'size-[var(--dot)] [&_svg]:size-[calc(var(--dot)*0.52)]',
        className,
      )}
      style={{
        ['--dot' as string]: `${size}px`,
        background: slot ? `color-mix(in oklab, ${colour} 16%, var(--surface-2))` : 'var(--surface-2)',
        color: colour,
      }}
      aria-hidden
    >
      <CategoryIcon icon={icon} size={Math.round(size * 0.52)} />
    </span>
  )
}

export function CategoryDot({ category, size = 36, className }: { category?: Category; size?: number; className?: string }) {
  return <Face slot={category?.slot} icon={category?.icon} size={size} className={className} />
}

/**
 * The same badge for an account.
 *
 * Deliberately a rounded SQUARE where a category is a circle. They sit in the
 * same rows and are the same size, and two circles of similar colour would be
 * one more thing to read rather than one less — the shape says which axis you
 * are looking at before the colour says which one.
 *
 * `accountFace` rather than `account.slot`: an account nobody has styled has
 * neither, and reading them raw paints the badge grey, which is the state the
 * whole feature exists to remove.
 */
export function AccountDot({ account, size = 36, className }: { account?: Account; size?: number; className?: string }) {
  const face = account ? accountFace(account) : undefined
  return <Face slot={face?.slot} icon={face?.icon} shape="square" size={size} className={className} />
}

/* ---------- Progress bar (budgets, goals) ---------- */
/**
 * How far through something you are.
 *
 * ## An overspend has a size
 *
 * The bar used to be `min(100, fraction * 100)`, so 105% of a budget and 300%
 * of it were the same full red track — the two states a budget screen most
 * needs to tell apart. `BudgetBullet` had already solved this by keeping
 * headroom past the budget tick, and the Budgets page shows both controls, so
 * one screen was telling the same fact two ways and the weaker way was the one
 * on the phone layout.
 *
 * So past 100% the track stops meaning "the budget" and starts meaning "what
 * was spent": the budget's share shrinks to `1 / fraction` of the width and the
 * excess is painted beyond it. A slight overspend is then a sliver at the right
 * and a threefold one is two thirds of the bar. Both halves are red — the whole
 * bar is still an alarm — but the darker half is the part that quantifies it,
 * so the difference is readable rather than merely present.
 *
 * The `min(2%)` floor stays, for the opposite case: a budget with almost
 * nothing spent against it should still show that it has started.
 */
export function Progress({
  fraction,
  tone,
  marker,
  markerLabel,
  className,
}: {
  fraction: number
  tone: 'ok' | 'warn' | 'over'
  /**
   * A faint tick at 0–1 of the track: where you would be if you were exactly on
   * schedule. Goals use it for the pace their deadline implies. Omitted where
   * there is no schedule to be on.
   */
  marker?: number
  /** What the tick means, for the tooltip. Purely advisory; the bar carries a label of its own. */
  markerLabel?: string
  className?: string
}) {
  /**
   * `tone`, not `fraction > 1` alone: passing the target is only an overshoot
   * where the caller says it is one. A goal saved past its target is at 120% and
   * that is the happy case — gating on the fraction alone painted it in the same
   * two-tone red as a budget blown by a fifth.
   */
  const over = fraction > 1 && tone === 'over'
  const color = tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warning)' : 'var(--critical)'
  // Past 100% the whole track is the spend, so the budget is a fraction of it.
  const budgetPct = over ? (1 / fraction) * 100 : Math.min(100, Math.max(2, fraction * 100))
  return (
    <div className={cx('relative h-2 w-full overflow-hidden rounded-full bg-surface-2 md:h-1.5', className)}>
      <div
        // Rounded on the left always; on the right only when nothing follows
        // it, or the cap would butt into the excess block as a notch.
        className={cx(
          'absolute inset-y-0 left-0 transition-[width] duration-500',
          over ? 'rounded-l-full' : 'rounded-full',
        )}
        style={{
          width: `${budgetPct}%`,
          background: over ? 'color-mix(in oklab, var(--critical) 45%, var(--surface-2))' : color,
        }}
      />
      {over && (
        <div
          className="absolute inset-y-0 right-0 transition-[width] duration-500"
          style={{ width: `${100 - budgetPct}%`, background: 'var(--critical)' }}
        />
      )}
      {marker != null && marker > 0 && marker < 1 && (
        // The tick lands ON the filled bar as often as on the empty track, so
        // it carries a halo of the surface colour rather than picking one
        // contrast and losing it half the time — at `bg-ink-3/70` and a single
        // pixel it disappeared into the accent fill exactly when it mattered,
        // which is a goal that has passed its pace mark.
        <div
          className="absolute inset-y-0 w-[1.5px] -translate-x-1/2 rounded-full bg-ink"
          style={{
            left: `${marker * 100}%`,
            boxShadow: '0 0 0 1px color-mix(in srgb, var(--surface) 75%, transparent)',
          }}
          title={markerLabel}
          aria-hidden
        />
      )}
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

/* ---------- Filter bar (phones) ---------- */
/**
 * What a phone gets instead of a toolbar: one scrolling row of chips.
 *
 * A `Toolbar` shares out `CONTROL_H` controls across the width and wraps what
 * does not fit, which is right under a cursor and ruinous on a 375px screen —
 * Activity spent about 290px, roughly two fifths of what was visible, before
 * the first transaction. Four wrapped rows became one that scrolls.
 *
 * The bar is the state, which is the reason it is chips and not a single
 * "Filters (2)" button: an active filter fills dark and carries a cross, so
 * what is narrowing the list can be read and undone without opening anything.
 * That is the whole trade against the tidier pattern, and it is the right one
 * on a page you re-filter constantly.
 *
 * The negative margin lets the row scroll edge to edge while the chips still
 * line up with the page's padding at rest.
 */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('no-scrollbar -mx-4 mb-3 flex items-center gap-1.5 overflow-x-auto px-4 py-1 md:hidden', className)}>
      {children}
    </div>
  )
}

/**
 * One chip in that row.
 *
 * `h-9` — 36px — rather than the 44px every other control wears. It is under
 * the usual touch minimum on purpose and only here: these sit in a scrolling
 * secondary row where the alternative is not a bigger target but no room for
 * the list, and both iOS and Android ship this control at about this size. A
 * chip that DOES something irreversible does not belong in this row.
 */
export function FilterChip({
  icon,
  label,
  active,
  onClick,
  /** Present on an active chip: clears the filter without opening the panel. */
  onClear,
  /** A chip that opens a panel says so; one that toggles does not. */
  chevron = true,
  open,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  label?: ReactNode
  active?: boolean
  onClear?: () => void
  chevron?: boolean
  open?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={chevron ? !!open : undefined}
      className={cx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors',
        label ? '' : 'w-9 justify-center px-0',
        active ? 'bg-ink text-page' : 'bg-surface-2 text-ink-2',
        className,
      )}
      {...rest}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {label && <span className="max-w-40 truncate">{label}</span>}
      {onClear && active ? (
        // A span, not a nested button — a button inside a button is invalid and
        // Safari drops the inner one's clicks. The chip's own handler is
        // suppressed instead.
        <span
          role="button"
          tabIndex={-1}
          aria-label="Clear"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
          className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full hover:bg-page/20"
        >
          <X size={12} />
        </span>
      ) : (
        chevron && <ChevronDown size={14} className={cx('shrink-0 opacity-60 transition-transform', open && 'rotate-180')} />
      )}
    </button>
  )
}

/**
 * A button that opens a panel under itself.
 *
 * Deliberately not a `Sheet`: these are filters you adjust and re-adjust while
 * reading the list behind them, and a full-screen sheet for "tick two accounts"
 * hides the thing you are filtering.
 *
 * `trigger` is a render prop rather than a set of appearance flags because the
 * same panel hangs off two quite different controls — a `CONTROL_H` toolbar
 * button on a wide screen, a chip on a phone — and the panel does not care
 * which.
 *
 * ## Why the panel is a portal
 *
 * It used to be `absolute` inside the trigger's own box, which worked until the
 * triggers moved into `FilterBar`. That bar is `overflow-x-auto`, and an
 * overflow container clips absolutely positioned descendants on BOTH axes — so
 * the panel opened, the chevron turned, and nothing appeared. There is no way
 * to keep a bar that scrolls and a panel that escapes it in the same box.
 *
 * The cost of a portal is that position has to be maintained by hand. It is
 * measured from the trigger on open and re-measured on scroll — in the capture
 * phase, so the bar's own sideways scroll counts as well as the page's — and
 * clamped after the fact so a panel hanging off the last chip in the row does
 * not run off the right of the screen.
 */
export function Popover({
  align = 'left',
  width,
  trigger,
  children,
}: {
  align?: 'left' | 'right'
  /** Tailwind width class for the panel. */
  width: string
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) {
      setAt(null)
      return
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      if (!a) return
      // The panel's own width is only knowable once it exists, so the first
      // pass uses the trigger's edge and the second corrects it. `w-64` and
      // friends are classes, not numbers — there is nothing to read ahead.
      const w = panel.current?.offsetWidth ?? 0
      const wanted = align === 'right' ? a.right - w : a.left
      const max = window.innerWidth - w - 8
      setAt({ top: a.bottom + 6, left: Math.max(8, Math.min(wanted, max)) })
    }
    place()
    // Capture, so this also fires for the filter bar scrolling sideways
    // underneath the panel — a scroll event on an inner element does not bubble.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      // Both halves: the panel is not a descendant of the trigger any more.
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={anchor} className="relative shrink-0">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        createPortal(
          <div
            ref={panel}
            // z-40 rather than z-50: above the sticky header and the tab bar,
            // below a Sheet, which is the one thing that must cover it.
            className={cx(
              'animate-fade fixed z-40 max-w-[calc(100vw-1rem)] rounded-xl bg-surface p-2 shadow-xl ring-1 ring-hairline',
              width,
            )}
            // Off screen until measured, rather than flashing at 0,0 first.
            style={at ? { top: at.top, left: at.left } : { top: -9999, left: -9999 }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ---------- Month stepper ---------- */
export function MonthStepper({
  month,
  onChange,
  label,
  canGoForward = true,
  step: months = 1,
  variant = 'toolbar',
}: {
  month: string
  onChange: (next: string) => void
  /** Formats the month key for display. */
  label: (key: string) => string
  canGoForward?: boolean
  /**
   * How many months a press moves. 12 makes this a year stepper without a
   * second component: the value stays a month key, so everything downstream is
   * unchanged and only the label and the stride differ.
   */
  step?: number
  /**
   * Which row it is standing in.
   *
   * `chip` is the phone's scrolling filter row, where every other control is a
   * 36px pill — so this one is too. It used to keep its full 44px height and
   * its rounded rectangle there, on the argument that it is pressed repeatedly
   * rather than set once, and the result simply read as a control that had been
   * missed: taller than its neighbours and a different shape, in a row whose
   * whole job is to look like one row.
   *
   * The same reasoning as `FilterChip`'s own note about 36px applies to it now:
   * under the usual touch minimum, deliberately, and only in this row.
   */
  variant?: 'toolbar' | 'chip'
}) {
  const chip = variant === 'chip'
  const step = (delta: number) => {
    const [y, m] = month.split('-').map(Number)
    const d = new Date(y, m - 1 + delta * months, 1)
    onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const arrow = (side: 'l' | 'r') =>
    cx(
      'grid h-full place-items-center text-ink-2 transition-colors hover:text-ink disabled:opacity-30',
      chip
        ? cx('w-8', side === 'l' ? 'rounded-l-full pl-0.5' : 'rounded-r-full pr-0.5')
        : cx('w-9 desktop:w-7', side === 'l' ? 'rounded-l-xl md:rounded-l-lg' : 'rounded-r-xl md:rounded-r-lg'),
    )
  return (
    <div
      className={cx(
        'flex shrink-0 items-center bg-surface-2',
        chip ? 'h-9 rounded-full' : cx(CONTROL_H, 'rounded-xl md:rounded-lg'),
      )}
    >
      <button
        type="button"
        className={arrow('l')}
        aria-label={months === 12 ? 'Previous year' : 'Previous month'}
        onClick={() => step(-1)}
      >
        <ChevronLeft size={17} />
      </button>
      <span className={cx('text-center text-sm font-semibold', chip ? 'w-28' : 'w-32 md:w-28')}>{label(month)}</span>
      <button
        type="button"
        className={arrow('r')}
        aria-label={months === 12 ? 'Next year' : 'Next month'}
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

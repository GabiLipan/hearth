import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { X, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import type { Category } from '../lib/db'
import { CategoryIcon } from './CategoryIcon'

export function cx(...parts: (string | false | undefined | null)[]) {
  return parts.filter(Boolean).join(' ')
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

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-6 flex items-baseline justify-between px-1 first:mt-0 md:mb-1.5 md:mt-5">
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
  return (
    <div className={cx('flex rounded-xl bg-surface-2 p-1 md:rounded-lg md:p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors md:rounded-md md:px-2.5 desktop:py-1',
            value === o.value ? 'bg-surface text-ink shadow-sm ring-1 ring-hairline' : 'text-ink-3 hover:text-ink-2',
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
 */
function useViewportInset() {
  const [inset, setInset] = useState(() => ({
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
    top: 0,
  }))
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setInset({ height: vv.height, top: vv.offsetTop })
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Sticky action bar pinned to the bottom of the sheet, always above the keyboard. */
  footer?: ReactNode
  wide?: boolean
}) {
  const inset = useViewportInset()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40 animate-fade" onClick={onClose} />
      <div
        onClick={onClose}
        className="absolute inset-x-0 top-0 flex items-end justify-center sm:items-center"
        style={{ height: inset.height || undefined, transform: inset.top ? `translateY(${inset.top}px)` : undefined }}
      >
        <div
          role="dialog"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
          className={cx(
            // Always leave a strip of backdrop above the sheet so tap-to-dismiss
            // has a target, even when the keyboard has shrunk the viewport.
            'animate-sheet relative flex max-h-[92%] w-full flex-col overflow-hidden bg-surface',
            'rounded-t-3xl sm:rounded-3xl sm:shadow-2xl md:rounded-2xl',
            wide ? 'sm:max-w-2xl lg:max-w-3xl' : 'sm:max-w-md lg:max-w-lg',
          )}
        >
          <div className="flex items-center justify-between px-5 pb-2 pt-4 md:px-4 md:pt-3">
            <h2 className="text-lg font-semibold md:text-base">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink-2 hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
          <div
            className={cx(
              'overflow-y-auto px-5 md:px-4',
              footer ? 'pb-3' : 'pb-[max(1.5rem,env(safe-area-inset-bottom))]',
            )}
          >
            {children}
          </div>
          {footer && (
            // Real bottom padding (not just the safe-area inset, which is 0 on
            // desktop) so the action never jams against the sheet's edge.
            <div className="border-t border-hairline bg-surface px-5 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:px-4 md:pb-3.5">
              {footer}
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
      <CategoryIcon icon={category?.icon} emoji={category?.emoji} size={Math.round(size * 0.52)} />
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
  row: 'border-b border-hairline last:border-0 hover:bg-surface-2/50',
  cell: 'py-2 desktop:py-1.5',
}

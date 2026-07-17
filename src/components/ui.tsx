import { useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import type { Category } from '../lib/db'

export function cx(...parts: (string | false | undefined | null)[]) {
  return parts.filter(Boolean).join(' ')
}

/* ---------- Card ---------- */
export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cx(
        'rounded-2xl bg-surface ring-1 ring-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)]',
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
    <div className="mb-2 mt-6 flex items-baseline justify-between px-1 first:mt-0">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-3">{children}</h2>
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
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-5 text-base',
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
      <span className="mb-1.5 block text-sm font-medium text-ink-2">{label}</span>
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
    <div className={cx('flex rounded-xl bg-surface-2 p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
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
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
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
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40 animate-fade" onClick={onClose} />
      <div
        role="dialog"
        aria-label={title}
        className={cx(
          'animate-sheet relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface',
          'rounded-t-3xl sm:rounded-3xl sm:shadow-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink-2 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-6 pb-safe">{children}</div>
      </div>
    </div>
  )
}

/* ---------- Category chip / icon ---------- */
export function CategoryDot({ category, size = 36 }: { category?: Category; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: category ? `color-mix(in oklab, var(--series-${category.slot}) 16%, var(--surface-2))` : 'var(--surface-2)',
      }}
      aria-hidden
    >
      {category?.emoji ?? '❓'}
    </span>
  )
}

/* ---------- Progress bar (budgets) ---------- */
export function Progress({ fraction, tone }: { fraction: number; tone: 'ok' | 'warn' | 'over' }) {
  const color = tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warning)' : 'var(--critical)'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(2, fraction * 100))}%`, background: color }}
      />
    </div>
  )
}

/* ---------- Empty state ---------- */
export function Empty({ emoji, title, hint, action }: { emoji: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="text-4xl" aria-hidden>
        {emoji}
      </div>
      <p className="font-medium text-ink-2">{title}</p>
      {hint && <p className="max-w-xs text-sm text-ink-3">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

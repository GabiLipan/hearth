import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import type { Account, Category } from '../lib/db'
import { accountFace } from '../lib/accounts'
import { fullName, grouped } from '../lib/categories'
import { slotVar } from '../lib/palette'
import { parseAmount } from '../lib/money'
import { AccountDot, CategoryDot, cx } from './ui'

/**
 * Editing the Activity table where it stands.
 *
 * ## Why this is desktop-only, and what "desktop" means here
 *
 * `useDesktop` is `matchMedia` over exactly the same query as the `desktop:`
 * Tailwind variant — wide AND a precise pointer. That second half is the whole
 * point: an iPad is wide enough to get the table and has no cursor, so a
 * six-pixel gap between two cells is a coin toss with a fingertip and there is
 * nothing to hover. It keeps the sheet, which is a better form on a touch
 * screen anyway. This has to be a JS query rather than a CSS variant because
 * what changes is behaviour, not styling.
 *
 * ## The rule the editors are built around
 *
 * A resting cell renders exactly what it rendered before — same text, same
 * padding, same row height. Nothing appears on hover but a faint tint, and
 * nothing that changes layout appears at all until a cell is actually being
 * edited. A table that shifts by a pixel when you mouse across it is worse to
 * read than one you cannot edit, and reading is what this table is mostly for.
 *
 * That is why every editor below is positioned absolutely inside a relative
 * cell rather than replacing the cell's content: an input in the flow, however
 * carefully styled, changes the row's height the moment its line-height or
 * border differs by a fraction.
 */

/** Wide screen, precise pointer — the same test as the `desktop:` variant. */
export function useDesktop(): boolean {
  const [is, setIs] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px) and (pointer: fine)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px) and (pointer: fine)')
    const on = () => setIs(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return is
}

/** Which cell of which row is open. One at a time, for the whole table. */
export interface CellRef {
  id: string
  field: 'date' | 'payee' | 'category' | 'account' | 'amount'
}

export const FIELD_ORDER: CellRef['field'][] = ['date', 'payee', 'category', 'account', 'amount']

/**
 * What a committed edit does next.
 *
 * `tab` and `enter` are different on purpose. Tab moves along the row, which is
 * how a spreadsheet behaves and how anyone correcting an import will work.
 * Enter closes, because the commonest single edit is one cell — and being left
 * in an editor you did not ask for is how a stray keystroke becomes a change
 * nobody noticed.
 */
export type Commit = (patch: Record<string, unknown> | null, then?: 'close' | 'next' | 'prev') => void

/**
 * The shell every editable cell wears.
 *
 * Renders `children` at rest and `editor` when open, and owns the two
 * behaviours they all share: a click starts editing, and Escape abandons it.
 * `editable` false is not hidden — the cell still reads normally and still
 * opens the full form, because RLS lets you SEE a row you may not change and a
 * cell that ignored the pointer would look broken rather than refused.
 */
export function EditableCell({
  className,
  editing,
  editable,
  onStart,
  onCancel,
  editor,
  children,
  title,
}: {
  className?: string
  editing: boolean
  editable: boolean
  onStart: () => void
  onCancel: () => void
  editor: ReactNode
  children: ReactNode
  title?: string
}) {
  return (
    <td
      className={cx('relative', className, editable && !editing && 'cursor-text hover:bg-surface-2/60')}
      title={editing ? undefined : title}
      onClick={
        editable
          ? (e) => {
              // The row itself opens the sheet. A cell that let the click
              // through would edit inline AND open the form on top of it.
              e.stopPropagation()
              if (!editing) onStart()
            }
          : undefined
      }
      onKeyDown={editing ? (e) => e.key === 'Escape' && (e.stopPropagation(), onCancel()) : undefined}
    >
      {children}
      {editing && editor}
    </td>
  )
}

/**
 * The box an editor floats in.
 *
 * `absolute inset-0` over the resting cell, with a ring rather than a border so
 * it paints inside the cell's own box and moves nothing. `-inset-y-px` gives
 * the ring somewhere to sit without eating a pixel of the text.
 */
const EDITOR_BOX =
  'absolute inset-x-0 -inset-y-px z-20 flex items-center bg-surface px-3 ring-2 ring-accent/70 rounded-md'

/* ---------- text and number ---------- */

export function TextEditor({
  value,
  commit,
  align = 'left',
  inputMode,
  parse,
}: {
  value: string
  commit: Commit
  align?: 'left' | 'right'
  inputMode?: 'text' | 'decimal'
  /** Turns the typed string into a patch, or null to reject it. */
  parse: (raw: string) => Record<string, unknown> | null
}) {
  const [raw, setRaw] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  // Layout effect, not effect: focusing after paint lets the browser scroll the
  // table sideways to a cell that was already fully visible.
  useLayoutEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const done = (then: 'close' | 'next' | 'prev') => {
    // Unchanged is not a write. Every edit costs a queued mutation and a bump
    // to `updatedAt`, and tabbing across a row to reach the fifth cell should
    // not rewrite the four you passed through.
    if (raw === value) return commit(null, then)
    commit(parse(raw), then)
  }

  return (
    <span className={EDITOR_BOX}>
      <input
        ref={ref}
        value={raw}
        inputMode={inputMode}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => done('close')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); done('close') }
          else if (e.key === 'Tab') { e.preventDefault(); done(e.shiftKey ? 'prev' : 'next') }
        }}
        className={cx(
          'w-full bg-transparent text-sm outline-none',
          align === 'right' && 'text-right tabular font-semibold',
          align === 'left' && 'font-medium',
        )}
      />
    </span>
  )
}

/** The amount, kept signed the way the row already is. */
export function AmountEditor({ amountMinor, commit }: { amountMinor: number; commit: Commit }) {
  return (
    <TextEditor
      value={(Math.abs(amountMinor) / 100).toFixed(2)}
      align="right"
      inputMode="decimal"
      commit={commit}
      parse={(rawText) => {
        const minor = parseAmount(rawText)
        // Rejected rather than guessed at. Writing 0 for "twelve pounds" would
        // be a silent wrong number in every total on the screen behind this.
        if (minor === null) return null
        // The sign is the row's, not the typist's: this table shows expenses as
        // negative, and re-deriving it from a field with no minus in it would
        // turn every edited expense into income.
        return { amountMinor: amountMinor < 0 ? -Math.abs(minor) : Math.abs(minor) }
      }}
    />
  )
}

export function DateEditor({ value, commit }: { value: string; commit: Commit }) {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { ref.current?.focus() }, [])
  return (
    <span className={EDITOR_BOX}>
      <input
        ref={ref}
        type="date"
        defaultValue={value}
        onBlur={(e) => commit(e.target.value && e.target.value !== value ? { date: e.target.value } : null, 'close')}
        onKeyDown={(e) => {
          const next = (e.target as HTMLInputElement).value
          const patch = next && next !== value ? { date: next } : null
          if (e.key === 'Enter') { e.preventDefault(); commit(patch, 'close') }
          else if (e.key === 'Tab') { e.preventDefault(); commit(patch, e.shiftKey ? 'prev' : 'next') }
        }}
        className="w-full bg-transparent text-sm tabular outline-none"
      />
    </span>
  )
}

/* ---------- pickers ---------- */

/**
 * A dropdown that hangs off the cell.
 *
 * Not `absolute inset-0` like the text editors: this one is taller than the row
 * and has to escape it. `top-full` rather than a portal because the table's
 * only clipping ancestor is the horizontal scroller, and a list that scrolls
 * away with its own column is the correct behaviour anyway.
 */
function Dropdown({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss()
    }
    // Capture, so a click on another cell closes this before opening that.
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [onDismiss])
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-0.5 w-64 rounded-xl bg-surface p-1.5 shadow-xl ring-1 ring-hairline"
    >
      {children}
    </div>
  )
}

export function CategoryEditor({
  categories,
  byId,
  value,
  commit,
}: {
  categories: Category[]
  byId: Map<string, Category>
  value?: string
  commit: Commit
}) {
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { ref.current?.focus() }, [])

  const q = query.trim().toLowerCase()
  // Matched on the FULL name, so typing "grocer" finds "Groceries · Butcher"
  // as well as the parent — the child is what you usually want and its own name
  // rarely contains the word you remember.
  const matches = categories.filter((c) => !q || fullName(c, byId).toLowerCase().includes(q))
  const order = q
    ? matches
    : grouped(categories).flatMap((g) => [g.parent, ...g.children])

  return (
    <Dropdown onDismiss={() => commit(null, 'close')}>
      <div className="relative mb-1">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          ref={ref}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search categories"
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); commit(null, 'close') }
            // Enter takes the only remaining match, which is what makes this
            // usable without the mouse: type three letters, press Enter.
            else if (e.key === 'Enter' && order.length > 0) {
              e.preventDefault()
              commit({ categoryId: order[0].id }, 'next')
            }
          }}
          // A capsule, like every other search box in the app.
          className="h-8 w-full rounded-full bg-surface-2 pl-8 pr-2.5 text-sm outline-none"
        />
      </div>
      <div className="max-h-60 overflow-y-auto">
        {value && (
          <button
            type="button"
            onClick={() => commit({ categoryId: undefined }, 'close')}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-3 hover:bg-surface-2"
          >
            Clear category
          </button>
        )}
        {order.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => commit({ categoryId: c.id }, 'close')}
            className={cx(
              'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2',
              c.id === value && 'bg-surface-2',
            )}
          >
            <CategoryDot category={c} size={20} />
            <span className="truncate">{fullName(c, byId)}</span>
          </button>
        ))}
        {order.length === 0 && <p className="px-2 py-3 text-center text-sm text-ink-3">No match</p>}
      </div>
    </Dropdown>
  )
}

export function AccountEditor({
  accounts,
  value,
  commit,
}: {
  accounts: Account[]
  value: string
  commit: Commit
}) {
  return (
    <Dropdown onDismiss={() => commit(null, 'close')}>
      <div className="max-h-60 overflow-y-auto">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => commit(a.id === value ? null : { accountId: a.id }, 'close')}
            className={cx(
              'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2',
              a.id === value && 'bg-surface-2',
            )}
          >
            <AccountDot account={a} size={20} />
            <span className="truncate">{a.name}</span>
          </button>
        ))}
        {accounts.length === 0 && (
          <p className="px-2 py-3 text-center text-sm text-ink-3">Nowhere else you can post to</p>
        )}
      </div>
    </Dropdown>
  )
}

/** The colour an account badge uses, for callers that want just the token. */
export const accountColour = (a: Account) => slotVar(accountFace(a).slot)

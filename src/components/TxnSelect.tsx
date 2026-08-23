import { useMemo } from 'react'
import type { Category, Transaction } from '../lib/db'
import { alreadyFiled, withGroup } from '../lib/rules'
import { useApp } from '../state/AppContext'
import { fullName } from '../lib/categories'
import { TxnName } from './TxnName'
import { cx } from './ui'
import { fmtFullDate } from '../lib/dates'

/**
 * The rows a rule is about, and which of them to touch.
 *
 * One component, two screens, deliberately: applying a rule from Settings and
 * applying the one you have just taught in the transaction sheet are the same
 * act asked at two moments, and they used to answer it two different ways —
 * Settings showed a list you could read and not change, and the form showed a
 * count and a tick box that took all of them or none. Whichever way you get
 * here you now see the same rows, described the same way, and choose among
 * them.
 *
 * ## The one bulk control, and why it is that one
 *
 * "Select all" and "none" are obvious and are here. The third is not, and it is
 * the one worth having: a rule is usually taught because a pile of rows landed
 * in the catch-all, and the rows that are already filed somewhere are the ones
 * a person decided about by hand. Being able to lift exactly those out of the
 * selection in one press is the difference between applying a rule and having
 * to audit it row by row. `alreadyFiled` is what it means, stated in
 * `lib/rules.ts` beside the matcher rather than here.
 *
 * A row this device may not write is shown and cannot be selected. Hiding it
 * would contradict the policy that lets us read it, and silently dropping it
 * from the count is how a bulk apply comes to promise more than it does — see
 * `applyCategory`, which is the other half of the same care.
 */
export function TxnSelect({
  rows,
  selected,
  onSelected,
  catMap,
  canEdit,
  /** What the row's current category is being compared against, where there is one. */
  targetCategoryId,
}: {
  rows: Transaction[]
  selected: Set<string>
  onSelected: (next: Set<string>) => void
  catMap: Map<string, Category>
  canEdit: (t: Transaction) => boolean
  targetCategoryId?: string
}) {
  const { money } = useApp()
  const nameOf = (id: string) => catMap.get(id)?.name

  /** Only what can actually be written: the bulk controls must not select the rest. */
  const editable = useMemo(() => rows.filter(canEdit), [rows, canEdit])
  const filed = useMemo(() => editable.filter((t) => alreadyFiled(t, nameOf)), [editable, catMap])
  const filedIds = filed.map((t) => t.id)
  // "On" only when every one of them is in: a partly selected group makes the
  // press mean "select the rest", which is the same direction the chip's own
  // pressed state implies.
  const filedOn = filedIds.length > 0 && filedIds.every((id) => selected.has(id))

  const count = editable.filter((t) => selected.has(t.id)).length

  return (
    <div>
      {/* One row of three, all the same shape: they are one set of answers to
          "which of these", not a filter chip and two links. `FilterChip`'s
          active state is the app's black filter pill, which on a selection
          control this size reads as an alarm — the accent tint is the same
          language `Segmented`'s thumb and the tab bar's pill already use. */}
      <div className="mb-2 flex items-center gap-1.5">
        <p className="mr-auto min-w-0 truncate text-xs text-ink-3">
          <span className="font-medium text-ink-2 tabular">{count}</span> of {editable.length} selected
        </p>
        <Pill label="All" onClick={() => onSelected(new Set(editable.map((t) => t.id)))} />
        <Pill label="None" onClick={() => onSelected(new Set())} />
        {filedIds.length > 0 && (
          <Pill
            label={`Filed (${filedIds.length})`}
            title="Rows filed under something other than the catch-all"
            active={filedOn}
            onClick={() => onSelected(withGroup(selected, filedIds, !filedOn))}
          />
        )}
      </div>

      <ul className="max-h-[38dvh] space-y-1 overflow-y-auto overscroll-contain pr-0.5">
        {rows.map((t) => {
          const mine = canEdit(t)
          const on = mine && selected.has(t.id)
          const current = t.categoryId ? catMap.get(t.categoryId) : undefined
          return (
            <li key={t.id}>
              <label
                className={cx(
                  'flex items-center gap-3 rounded-xl px-3 py-2 ring-1 transition-colors',
                  on ? 'bg-accent/8 ring-accent/25' : 'bg-surface-2/60 ring-transparent',
                  mine ? 'cursor-pointer' : 'opacity-55',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!mine}
                  onChange={(e) => onSelected(withGroup(selected, [t.id], e.target.checked))}
                  className="size-[1.15rem] shrink-0 accent-[var(--accent)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 text-sm font-medium leading-tight">
                    <TxnName txn={t} />
                  </p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                    <span className="shrink-0 tabular">{fmtFullDate(t.date)}</span>
                    <span aria-hidden className="text-ink-3/50">·</span>
                    {/* The child's own name, not the full path: "Subscriptions
                        › Entertainment" truncates to "Subscri…" beside a date
                        and an amount on a phone, which names nothing. The path
                        is on the row's title for anywhere there is room.

                        A row already where the rule wants it says so INSTEAD of
                        naming the category, rather than as a badge after it:
                        the two together left about five characters for the
                        name, and "already there" is the whole of what the
                        category would have told you. */}
                    <span className="truncate" title={current ? fullName(current, catMap) : undefined}>
                      {current && current.id === targetCategoryId
                        ? 'already there'
                        : current
                          ? current.name
                          : t.categoryId
                            ? 'a deleted category'
                            : 'Uncategorised'}
                    </span>
                    {!mine && <span className="shrink-0">· not yours</span>}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular">{money(t.amountMinor)}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** One of the three bulk answers. Same shape whichever it is; the accent says which are on. */
function Pill({
  label,
  active,
  onClick,
  title,
}: {
  label: string
  active?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cx(
        'h-7 shrink-0 rounded-full px-2.5 text-xs font-medium ring-1 transition-colors',
        active
          ? 'bg-accent/12 text-accent ring-accent/25'
          : 'bg-surface-2 text-ink-2 ring-transparent hover:text-ink',
      )}
    >
      {label}
    </button>
  )
}

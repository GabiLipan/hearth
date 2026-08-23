import { useMemo } from 'react'
import type { Category, Transaction } from '../lib/db'
import { alreadyFiled, withGroup } from '../lib/rules'
import { useApp } from '../state/AppContext'
import { fullName } from '../lib/categories'
import { TxnName } from './TxnName'
import { FilterChip, cx } from './ui'

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
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-ink-3">
          {count} of {editable.length} selected
        </p>
        <FilterChip
          chevron={false}
          label="All"
          onClick={() => onSelected(new Set(editable.map((t) => t.id)))}
        />
        <FilterChip chevron={false} label="None" onClick={() => onSelected(new Set())} />
        {filedIds.length > 0 && (
          <FilterChip
            chevron={false}
            active={filedOn}
            aria-pressed={filedOn}
            label={`Already filed (${filedIds.length})`}
            title="Rows filed under something other than the catch-all"
            onClick={() => onSelected(withGroup(selected, filedIds, !filedOn))}
          />
        )}
      </div>

      <ul className="max-h-[42dvh] space-y-1 overflow-y-auto pr-1">
        {rows.map((t) => {
          const mine = canEdit(t)
          const on = mine && selected.has(t.id)
          const current = t.categoryId ? catMap.get(t.categoryId) : undefined
          return (
            <li key={t.id}>
              <label
                className={cx(
                  'flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 transition-colors',
                  on ? 'bg-accent/8 ring-1 ring-accent/20' : 'bg-surface-2/50',
                  mine ? 'cursor-pointer' : 'opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!mine}
                  onChange={(e) => onSelected(withGroup(selected, [t.id], e.target.checked))}
                  className="size-5 shrink-0 accent-[var(--accent)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 text-sm font-medium">
                    <TxnName txn={t} />
                  </p>
                  <p className="truncate text-xs text-ink-3">
                    {t.date} · currently{' '}
                    {current
                      ? fullName(current, catMap)
                      : t.categoryId
                        ? 'a deleted category'
                        : 'uncategorised'}
                    {current && current.id === targetCategoryId && ' · already there'}
                    {!mine && ' · not yours to change'}
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

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Receipt } from 'lucide-react'
import { closeDrill, drillTo, matchesDrill, useOpenDrill, type Drill } from '../lib/drill'
import { useAccountMap, useAccounts, useAllTransactions, useBooks, useCategoryMap, useMyLevels } from '../lib/cache'
import { canSeeTransactionsAt, levelOn } from '../lib/accounts'
import { accountsInBook, showsInBook, BOOK_LABEL } from '../lib/books'
import { fullName } from '../lib/categories'
import { displayName } from '../lib/rules'
import { fmtDay, fmtFullDate, monthLabel } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { AccountDot, CategoryDot, Sheet, cx } from './ui'

/**
 * The rows behind a figure, over the page that asked for them.
 *
 * Mounted once, in `Layout`, and driven by the module-level drill store — see
 * `lib/drill.ts` for why a glance at the rows should not cost you the page you
 * were reading.
 *
 * It is deliberately a LIST and not a second Activity. Nothing here edits: no
 * inline cells, no transfer linking, no receipts. The moment the answer to
 * "which transactions?" turns into "and this one is wrong", the button at the
 * bottom opens the real page with the same filter already applied. Building a
 * weaker copy of that page inside a modal is the failure this shape exists to
 * avoid — the two would drift, and the modal would always be the one missing
 * whatever you needed.
 */
export function DrillSheet() {
  const drill = useOpenDrill()
  return (
    <Sheet open={drill !== null} onClose={closeDrill} title={drill ? title(drill) : 'Transactions'} wide>
      {drill && <Rows drill={drill} />}
    </Sheet>
  )
}

/** What the sheet is called: the narrowest true description of the figure. */
function title(drill: Drill): string {
  if (drill.payee) return drill.payee
  if (drill.month) return monthLabel(drill.month)
  if (drill.from && drill.to) return `${fmtFullDate(drill.from)} – ${fmtFullDate(drill.to)}`
  return 'Transactions'
}

function Rows({ drill }: { drill: Drill }) {
  const { money } = useApp()
  const txns = useAllTransactions()
  const catMap = useCategoryMap()
  const accMap = useAccountMap()
  const accounts = useAccounts()
  const levels = useMyLevels()
  const books = useBooks()

  /**
   * The same two narrowings the page that raised this drill had already
   * applied: the accounts whose rows this device may read, and the book the
   * figure was read under. `matchesDrill` does the rest — and does it for
   * Activity too, so the sheet and the page cannot disagree about what the
   * figure meant.
   */
  const rows = useMemo(() => {
    const book = drill.book ?? 'all'
    const inBook = accountsInBook(book, books)
    const visible = new Set(
      accounts.filter((a) => inBook.has(a.id) && canSeeTransactionsAt(levelOn(a.id, levels))).map((a) => a.id),
    )
    // Not `visible.has(...)`: a household expense paid from a personal account
    // is behind the figure that raised this drill and lives outside every
    // account in that book, so the by-account filter alone would leave the list
    // short of the total printed over it. See `showsInBook`.
    return (txns ?? [])
      .filter((t) => showsInBook(t, book, books, visible) && matchesDrill(t, drill, catMap))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  }, [txns, drill, catMap, accounts, levels, books])

  const total = rows.reduce((sum, t) => sum + t.amountMinor, 0)
  const label = subtitle(drill, catMap)

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 pb-2 md:px-4">
        <p className="text-sm text-ink-3">
          {label}
          {label && ' · '}
          {rows.length} transaction{rows.length === 1 ? '' : 's'}
        </p>
        <p className="text-sm font-semibold tabular">{money(Math.abs(total))}</p>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-3 md:px-4">
          Nothing here — the rows behind this figure are in accounts this device cannot see.
        </p>
      ) : (
        // The scroller, not the sheet: the sheet's own body is already a
        // flex column with a footer under it, so the list is what scrolls
        // and the total above it stays put.
        <ul className="min-h-0 flex-1 divide-y divide-hairline overflow-y-auto overscroll-contain px-5 md:px-4">
          {rows.map((t) => {
            const cat = t.categoryId ? catMap.get(t.categoryId) : undefined
            const transfer = !!t.transferId
            return (
              <li key={t.id} className="flex items-center gap-3 py-2.5 md:py-2">
                <span className="relative shrink-0">
                  <CategoryDot category={cat} size={32} />
                  <AccountDot
                    account={accMap.get(t.accountId)}
                    size={15}
                    className="absolute -bottom-0.5 -right-0.5 ring-2 ring-surface"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{displayName(t)}</p>
                  <p className="truncate text-xs text-ink-3">
                    {fmtDay(t.date)}
                    {' · '}
                    {transfer ? 'Transfer' : cat ? fullName(cat, catMap) : 'Uncategorised'}
                  </p>
                </div>
                <span
                  className={cx(
                    'shrink-0 text-sm font-semibold tabular',
                    transfer ? 'text-ink-3' : t.amountMinor > 0 && 'text-good-text',
                  )}
                >
                  {money(t.amountMinor, { sign: t.amountMinor > 0 })}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {/* The way to the page that can actually change any of this. */}
      <div className="px-5 pb-1 pt-3 md:px-4">
        <Link
          to={drillTo({ ...drill, backTo: undefined, backLabel: undefined })}
          onClick={closeDrill}
          className="flex items-center justify-center gap-1.5 rounded-full bg-surface-2 px-3 py-2.5 text-sm font-medium text-ink-2 transition-colors hover:text-ink"
        >
          <Receipt size={15} /> Open in Activity
        </Link>
      </div>
    </div>
  )
}

/** The lens and the category, where they narrow the list further than the title does. */
function subtitle(drill: Drill, catMap: Map<string, unknown>): string {
  const parts: string[] = []
  if (drill.category) {
    const cat = catMap.get(drill.category) as { name?: string } | undefined
    if (cat?.name) parts.push(cat.name)
  }
  if (drill.month && drill.payee) parts.push(monthLabel(drill.month))
  if (drill.book && drill.book !== 'all') parts.push(BOOK_LABEL[drill.book])
  return parts.join(' · ')
}

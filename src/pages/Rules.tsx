import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, Pencil, Plus, Trash2, Wand2, Check } from 'lucide-react'
import type { Rule, Transaction } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import { useAccounts, useAllTransactions, useCategories, useCategoryMap, useMyLevels, useRules, useCacheReady } from '../lib/cache'
import { canEditTransaction, levelOn } from '../lib/accounts'
import { fullName, styleOf } from '../lib/categories'
import { paintOf } from '../lib/palette'
import { applyCategory, cleanTitle, conditionWords, coverageOf, normalizePayee, TITLE_MAX } from '../lib/rules'
import { TxnSelect } from '../components/TxnSelect'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import {
  AccountDot,
  Button,
  Card,
  CardHeading,
  CategoryDot,
  Chip,
  Empty,
  Field,
  Select,
  Segmented,
  Sheet,
  SearchInput,
  TextInput,
  Toolbar,
  cx,
  table,
  ScrollTable,
} from '../components/ui'

/**
 * Rules, on their own page.
 *
 * This was a scrolling box in Settings listing “match → category” with a bin
 * icon, which is every fact about a rule except the one that matters: what it
 * actually does to your data. A rule that has been quietly miscategorising
 * eleven months of pet insurance looks exactly like one that has never matched
 * anything.
 *
 * So the column that earns this page is the coverage count, and the button next
 * to it. Learning a rule only ever affected the NEXT transaction; applying it
 * backwards is the thing that was missing.
 */
export default function RulesPage() {
  const { money } = useApp()
  const { userId } = useSyncState()
  const rules = useRules()
  const categories = useCategories()
  const catMap = useCategoryMap()
  const txns = useAllTransactions()
  const levels = useMyLevels()
  const ready = useCacheReady()

  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  // The rule the sheet is editing. `null` and `adding` are two states of one
  // sheet: `RuleSheet` writes an existing rule or creates one from the same
  // fields, so there is nothing here that wants two components.
  const [editing, setEditing] = useState<Rule | null>(null)
  const [preview, setPreview] = useState<Rule | null>(null)
  /**
   * Which of the covered rows the apply button will actually touch.
   *
   * Seeded when the sheet opens with the ones that would CHANGE — the old
   * behaviour exactly, so pressing straight through does what it always did —
   * and everything the rule covers is listed, including the rows already in the
   * right place, because "and this one too" is a thing you can now say.
   */
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const accounts = useAccounts()
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  /**
   * One rule's conditions, phrased once for both lists.
   *
   * `conditionWords` is in `lib/rules.ts` beside the matcher that enforces
   * them, so what a rule SAYS on screen and what it DOES cannot drift.
   */
  const conditions = (r: Rule) => conditionWords(r, money, (id) => accountMap.get(id)?.name)

  const canEdit = useMemo(
    () => (t: Transaction) => canEditTransaction(t, levelOn(t.accountId, levels), userId),
    [levels, userId],
  )

  /**
   * Coverage for every rule at once.
   *
   * Computed here rather than per row, because `coverageOf` needs the whole
   * rule list to answer honestly — longest-match-wins means what the “tesco”
   * rule covers depends on whether a “tesco petrol” rule exists. A per-row
   * calculation would have to be handed the list anyway, and would walk every
   * transaction once per rule.
   */
  const coverage = useMemo(() => {
    const map = new Map<string, { all: Transaction[]; changed: Transaction[] }>()
    if (!txns) return map
    for (const r of rules) map.set(r.id, coverageOf(r, txns, rules))
    return map
  }, [rules, txns])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rules
    return rules.filter(
      (r) =>
        r.match.includes(q) ||
        (r.title ?? '').toLowerCase().includes(q) ||
        (r.categoryId ? (catMap.get(r.categoryId)?.name ?? '') : '').toLowerCase().includes(q),
    )
  }, [rules, query, catMap])

  const pending = rules.reduce((n, r) => n + (coverage.get(r.id)?.changed.length ?? 0), 0)

  /**
   * What pressing the button would actually write.
   *
   * The ticked rows, less the ones already in the right place: a rule's
   * coverage includes those, so that "and this one too" can be said about
   * them, and writing a category a row already has is a queued update that
   * changes nothing. Counting them would make the button promise more than it
   * does, which is the same care `applyCategory` takes about rows that are not
   * yours.
   */
  const ticked = (rule: Rule) =>
    (coverage.get(rule.id)?.all ?? []).filter(
      (t) => chosen.has(t.id) && t.categoryId !== rule.categoryId && canEdit(t),
    )

  /** Open the preview, ticking the rows the rule would move. */
  function openPreview(rule: Rule) {
    setChosen(new Set((coverage.get(rule.id)?.changed ?? []).filter(canEdit).map((t) => t.id)))
    setPreview(rule)
  }

  async function apply(rule: Rule) {
    const list = ticked(rule)
    if (list.length === 0 || !rule.categoryId) return
    setBusy(rule.id)
    try {
      const { updated, skipped } = await applyCategory(list, rule.categoryId, canEdit)
      setDone(
        skipped > 0
          ? `${updated} updated · ${skipped} left alone (added by someone else)`
          : `${updated} transaction${updated === 1 ? '' : 's'} recategorised`,
      )
    } finally {
      setBusy(null)
      setPreview(null)
    }
  }

  async function applyAll() {
    setBusy('all')
    let updated = 0
    let skipped = 0
    try {
      for (const r of rules) {
        const list = coverage.get(r.id)?.changed ?? []
        if (list.length === 0 || !r.categoryId) continue
        const res = await applyCategory(list, r.categoryId, canEdit)
        updated += res.updated
        skipped += res.skipped
      }
      setDone(
        skipped > 0
          ? `${updated} updated · ${skipped} left alone (added by someone else)`
          : `${updated} transaction${updated === 1 ? '' : 's'} recategorised`,
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <Toolbar spread>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/settings"
            className="flex shrink-0 items-center gap-1 text-sm font-medium text-ink-3 hover:text-ink"
          >
            <ChevronLeft size={16} /> Settings
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pending > 0 && (
            <Button variant="subtle" disabled={busy !== null} onClick={applyAll}>
              <Wand2 size={15} /> Apply all ({pending})
            </Button>
          )}
          <Button onClick={() => setAdding(true)}>
            <Plus size={15} /> New rule
          </Button>
        </div>
      </Toolbar>

      {/* Six sentences, which is five more than a screen may carry. The one
          that is worth reading every time stays; the rest is behind the ⓘ. */}
      <div className="mb-3 px-1 md:mb-2.5">
        <CardHeading
          className="mb-0"
          title={
            <span className="text-sm font-normal text-ink-2">
              Hearth remembers how you file a payee, and applies it to what comes next.
            </span>
          }
          info={
            <>
              <p>
                Here you can point a rule somewhere else, rename it, apply it to what you have already recorded, or
                write one yourself.
              </p>
              <p>
                A rule can file a payee, name it, or both — a name alone is enough where the bank&rsquo;s words are
                the only problem.
              </p>
              <p>
                It can also ask for more than the payee: an exact amount, a range, a particular account. That is how
                two subscriptions billed by the same vendor become two rules instead of one.
              </p>
              <p>
                Where several could match, the most specific wins — a rule that names an amount beats one that does
                not, and &ldquo;tesco petrol&rdquo; beats &ldquo;tesco&rdquo;.
              </p>
            </>
          }
        />
      </div>

      {done && (
        <Card className="mb-3 flex items-center gap-2 px-4 py-2.5 text-sm md:mb-2.5 md:px-3 md:py-2">
          <Check size={16} className="shrink-0 text-good-text" />
          <span className="min-w-0 flex-1">{done}</span>
          <button type="button" onClick={() => setDone(null)} className="shrink-0 text-ink-3 hover:text-ink">
            Dismiss
          </button>
        </Card>
      )}

      {rules.length > 4 && (
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search rules"
          aria-label="Search rules"
          className="mb-3 max-w-sm md:mb-2.5"
        />
      )}

      {rules.length === 0 ? (
        // `[]` from a cache that has not opened yet is not the same claim as
        // `[]` from one that has. See `useCacheReady`.
        !ready ? null : (
          <Empty
            icon={Wand2}
            title="Nothing learned yet"
            hint="Categorise a transaction, or give one a name of your own, and Hearth will remember the payee. You can also write a rule yourself."
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus size={16} /> Write a rule
              </Button>
            }
          />
        )
      ) : (
        <>
          {/* Phone: a stacked list. The coverage line is the point, so it gets
              its own row rather than being squeezed onto the end of the match. */}
          <Card className="md:hidden">
            <ul className="divide-y divide-hairline">
              {filtered.map((r) => {
                const cov = coverage.get(r.id)
                const cat = r.categoryId ? catMap.get(r.categoryId) : undefined
                return (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <CategoryDot category={cat} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">“{r.match}”</p>
                        <p className="truncate text-sm text-ink-3">
                          {/* Both halves of what a rule knows, and a rule may
                              carry either alone. */}
                          {r.title && <span className="text-ink-2">Call it “{r.title}”</span>}
                          {r.title && r.categoryId && ' · '}
                          {r.categoryId && (cat ? fullName(cat, catMap) : 'Category deleted')}
                        </p>
                        {/* What else this rule insists on. Shown under the
                            payee rather than beside it, because two rules for
                            one payee are now the ordinary case and the line
                            that tells them apart is the important one. */}
                        {conditions(r).length > 0 && (
                          <p className="truncate text-xs text-ink-3">and {conditions(r).join(' · ')}</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditing(r)}
                        aria-label={`Edit rule ${r.match}`}
                        className="shrink-0 p-1 text-ink-3 hover:text-ink"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeRow('rules', r.id)}
                        aria-label={`Forget rule ${r.match}`}
                        className="shrink-0 p-1 text-ink-3 hover:text-critical-text"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2 pl-11">
                      <span className="text-xs text-ink-3">
                        {cov ? `${cov.all.length} match${cov.all.length === 1 ? '' : 'es'}` : '…'}
                      </span>
                      {cov && cov.changed.length > 0 && (
                        <Button size="sm" variant="subtle" onClick={() => openPreview(r)}>
                          Apply to {cov.changed.length}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>

          {/* Desktop: the category becomes an editable control in its own column,
              so repointing a rule is one click rather than delete-and-relearn. */}
          <Card className="hidden overflow-hidden md:block">
            <ScrollTable minWidth={1040}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, 'min-w-48 pl-3', table.pinned)}>When the payee contains</th>
                  <th className={cx(table.th, 'w-52')}>…and</th>
                  <th className={cx(table.th, 'w-56')}>Call it</th>
                  <th className={cx(table.th, 'w-56')}>Categorise as</th>
                  <th className={cx(table.th, 'w-28 text-right')}>Matches</th>
                  <th className={cx(table.th, 'w-44 pr-3 text-right')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const cov = coverage.get(r.id)
                  return (
                    <tr key={r.id} className={table.row}>
                      <td className={cx(table.cell, 'pl-3 pr-3', table.pinned)}>
                        <span className="truncate font-medium">{r.match}</span>
                      </td>
                      <td className={cx(table.cell, 'pr-3 text-ink-3')}>
                        {conditions(r).length === 0 ? (
                          // "Anything" rather than a dash: this column is the
                          // difference between two rows that otherwise read
                          // identically, so the empty case has to say what it
                          // means rather than look like missing data.
                          <span className="text-ink-3/70">any amount, any account</span>
                        ) : (
                          <span className="flex min-w-0 items-center gap-1.5">
                            {r.accountId && <AccountDot account={accountMap.get(r.accountId)} size={20} />}
                            <span className="truncate">{conditions(r).join(' · ')}</span>
                          </span>
                        )}
                      </td>
                      <td className={cx(table.cell, 'pr-3')}>
                        <div className="max-w-52">
                          <TitleCell rule={r} />
                        </div>
                      </td>
                      <td className={cx(table.cell, 'pr-3')}>
                        {/* Select carries w-full, so the width has to live on a
                            wrapper or the base class wins. */}
                        <div className="max-w-52">
                          <Select
                            value={r.categoryId ?? ''}
                            aria-label={`Category for ${r.match}`}
                            onChange={(e) =>
                              void update('rules', r.id, { categoryId: e.target.value || undefined })
                            }
                          >
                            {/* A rule may say only what a payee is called — but
                                one that says neither is refused server-side, so
                                this is offered only where the name can carry it. */}
                            <option value="" disabled={!r.title}>
                              {r.title ? 'Just the name' : 'No category'}
                            </option>
                            {categories
                              .filter((c) => c.kind === 'expense')
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {fullName(c, catMap)}
                                </option>
                              ))}
                          </Select>
                        </div>
                      </td>
                      <td className={cx(table.cell, 'pr-3 text-right tabular text-ink-3')}>
                        {cov ? cov.all.length : '—'}
                      </td>
                      <td className={cx(table.cell, 'pr-3')}>
                        <div className="flex items-center justify-end gap-1.5">
                          {cov && cov.changed.length > 0 ? (
                            <Button
                              size="sm"
                              variant="subtle"
                              disabled={busy !== null}
                              onClick={() => openPreview(r)}
                            >
                              Apply to {cov.changed.length}
                            </Button>
                          ) : (
                            cov && cov.all.length > 0 && <Chip>up to date</Chip>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditing(r)}
                            aria-label={`Edit rule ${r.match}`}
                            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeRow('rules', r.id)}
                            aria-label={`Forget rule ${r.match}`}
                            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-critical/10 hover:text-critical-text"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </ScrollTable>
          </Card>
        </>
      )}

      {/* The preview is not decoration. Applying a rule rewrites rows in bulk,
          and there is no undo — seeing which ones first is the whole safeguard,
          and choosing among them is the rest of it. */}
      <Sheet
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Apply this rule"
        wide
        footer={
          <Button
            size="lg"
            className="w-full"
            disabled={busy !== null || !preview || ticked(preview).length === 0}
            onClick={() => preview && void apply(preview)}
          >
            {busy
              ? 'Applying…'
              : !preview || ticked(preview).length === 0
                ? 'Nothing to move'
                : `Recategorise ${ticked(preview).length}`}
          </Button>
        }
      >
        {preview && (
          <div className="space-y-3">
            {/* The same head the transaction sheet's picker wears, for the
                same reason the list below it is the same component: it is one
                act asked at two moments. What the rule MATCHES is edited in
                the sheet that made it — a second copy of those fields here
                would be a second place for them to drift — so this states the
                rule and hands over. */}
            <div className="rounded-xl bg-surface-2 px-3.5 py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ink-3">Anything matching</p>
                  <p className="truncate text-sm font-semibold">“{preview.match}”</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPreview(null)
                    setEditing(preview)
                  }}
                >
                  Change
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.categoryId && catMap.get(preview.categoryId) && (
                  <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-xs font-medium ring-1 ring-hairline">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        background: paintOf(
                          styleOf(catMap.get(preview.categoryId)!, catMap).slot,
                          styleOf(catMap.get(preview.categoryId)!, catMap).color,
                        ),
                      }}
                    />
                    <span className="truncate">{fullName(catMap.get(preview.categoryId)!, catMap)}</span>
                  </span>
                )}
                {cleanTitle(preview.title) && (
                  <span className="inline-flex min-w-0 items-center rounded-full bg-surface px-2.5 py-1 text-xs font-medium ring-1 ring-hairline">
                    <span className="truncate">Called “{cleanTitle(preview.title)}”</span>
                  </span>
                )}
                {conditions(preview).map((w) => (
                  <span
                    key={w}
                    className="inline-flex min-w-0 items-center rounded-full bg-surface px-2.5 py-1 text-xs text-ink-2 ring-1 ring-hairline"
                  >
                    <span className="truncate">{w}</span>
                  </span>
                ))}
              </div>
            </div>
            <TxnSelect
              rows={coverage.get(preview.id)?.all ?? []}
              selected={chosen}
              onSelected={setChosen}
              catMap={catMap}
              canEdit={canEdit}
              targetCategoryId={preview.categoryId}
            />
            <p className="text-xs text-ink-3">
              Anything added by someone else on an account you only contribute to is left alone.
            </p>
          </div>
        )}
      </Sheet>

      {/* One sheet, two jobs. `key` on the rule's id so the fields reload when
          the sheet is opened on a different rule — without it a second Edit
          press would show the first rule's amounts, since the loading effect
          fires on `open` and `open` never went false in between. */}
      <RuleSheet
        key={editing?.id ?? 'new'}
        rule={editing ?? undefined}
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
      />
    </div>
  )
}

/**
 * The name a rule gives a payee, edited in place.
 *
 * Local state rather than writing on every keystroke: each write goes through
 * `upsert_rule` with the whole row as its argument list, and one per letter of
 * "Sainsbury's" is eleven RPCs. It commits on blur and on Enter, and it refuses
 * to clear the last thing a rule says — a rule with neither a category nor a
 * name is refused server-side, and a dead letter minutes later in Settings is a
 * poor way to be told.
 */
function TitleCell({ rule }: { rule: Rule }) {
  const [text, setText] = useState(rule.title ?? '')
  const [focused, setFocused] = useState(false)
  // While it is not being edited the row is the truth, so a name learned on the
  // other device (or by saving a transaction) shows up here.
  const value = focused ? text : (rule.title ?? '')

  function commit() {
    setFocused(false)
    const next = cleanTitle(text)
    if (next === (rule.title ?? undefined)) return
    if (!next && !rule.categoryId) {
      setText(rule.title ?? '')
      return
    }
    void update('rules', rule.id, { title: next })
  }

  return (
    <TextInput
      value={value}
      maxLength={TITLE_MAX}
      aria-label={`Name for ${rule.match}`}
      placeholder={rule.categoryId ? 'Leave the bank’s words' : ''}
      onFocus={() => {
        setText(rule.title ?? '')
        setFocused(true)
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setText(rule.title ?? '')
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * Writing a rule, and editing one — the same sheet, because they are the same
 * question asked at two moments.
 *
 * ## Why the conditions are opt-in, one at a time
 *
 * A payee substring is the whole of what a rule used to be, and it cannot tell
 * two subscriptions from one vendor apart: £8.99 and £12.99 arrive on the
 * statement as the same words, so filing one filed both. The obvious answer —
 * match on the amount as well — breaks the commonest rule in any household, an
 * energy bill from the same payee that is a different number every month.
 *
 * So neither is the default. The payee is what a rule is keyed on, and each
 * further condition is something this rule asks for and the one beside it does
 * not. That is also why the amount is a THREE-way choice rather than a pair of
 * boxes left blank: "any", "exactly", "between" are the three things people
 * mean, and two empty number fields do not say which of them is intended.
 */
function RuleSheet({ rule, open, onClose }: { rule?: Rule; open: boolean; onClose: () => void }) {
  const categories = useCategories()
  const catMap = useCategoryMap()
  const accounts = useAccounts()
  const expense = categories.filter((c) => c.kind === 'expense')

  const [match, setMatch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [title, setTitle] = useState('')
  const [amountMode, setAmountMode] = useState<AmountMode>('any')
  const [low, setLow] = useState('')
  const [high, setHigh] = useState('')
  const [accountId, setAccountId] = useState('')

  /**
   * Load the rule being edited when the sheet OPENS, and not on every render.
   *
   * The same shape `Sheet`'s callers use for their keys: a form keyed on the
   * row it edits also remounts when it closes, which throws the sheet away
   * before it can animate out. Here the fields are filled by an effect instead,
   * keyed on `open` — so opening always gets fresh values and closing leaves
   * the sheet holding what it had, which is what it animates out with.
   */
  useEffect(() => {
    if (!open) return
    setMatch(rule?.match ?? '')
    setCategoryId(rule?.categoryId ?? '')
    setTitle(rule?.title ?? '')
    setAccountId(rule?.accountId ?? '')
    const lo = rule?.amountMinMinor
    const hi = rule?.amountMaxMinor
    setAmountMode(lo === undefined && hi === undefined ? 'any' : lo === hi ? 'exact' : 'range')
    setLow(lo === undefined ? '' : majorOf(lo))
    setHigh(hi === undefined ? '' : majorOf(hi))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Stored normalised, because that is what the matcher compares against — a
  // rule saved as "Tesco Stores 3241" would match nothing at all.
  const normalised = normalizePayee(match)
  const lo = parseMajor(low)
  const hi = parseMajor(high)
  const amounts = amountBounds(amountMode, lo, hi)

  // Either half of what a rule SAYS is enough, and neither is not:
  // `rules_say_something` refuses a rule that says nothing, and a write refused
  // server-side surfaces minutes later as a dead letter rather than as an error
  // on this form. The conditions are separate — a rule may carry none.
  const canSave =
    normalised.length >= 3 &&
    (categoryId !== '' || cleanTitle(title) !== undefined) &&
    (amountMode === 'any' || amounts !== null)

  async function save() {
    if (!canSave) return
    const fields = {
      match: normalised,
      categoryId: categoryId || undefined,
      title: cleanTitle(title),
      amountMinMinor: amounts?.min,
      amountMaxMinor: amounts?.max,
      accountId: accountId || undefined,
    }
    // A field present with `undefined` clears it; an absent one would leave it
    // alone. Everything here is stated on every save, which is also what
    // `upsert_rule` needs — see RPC_WRITERS in outbox.ts.
    if (rule) await update('rules', rule.id, fields)
    else await create('rules', { ...fields, createdAt: new Date().toISOString() })
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onSubmit={save}
      title={rule ? 'Edit rule' : 'New rule'}
      footer={
        <Button type="submit" size="lg" className="w-full" disabled={!canSave}>
          {rule ? 'Save rule' : 'Add rule'}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field
          label="When the payee contains"
          hint={
            normalised && normalised !== match.trim().toLowerCase()
              ? `Stored as “${normalised}” — reference numbers and bank codes are stripped out so the rule still matches next month.`
              : 'Part of the name is enough. Reference numbers are ignored.'
          }
        >
          <TextInput
            value={match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder="e.g. pets at home"
            autoComplete="off"
          />
        </Field>

        <Field
          label="…and the amount is"
          hint={
            amountMode === 'any'
              ? 'Leave this alone for a payee that charges a different amount every month — an energy bill, a supermarket.'
              : 'Use this to tell two charges from the same payee apart. Amounts are compared without their sign, so this reads the same for money in and money out.'
          }
        >
          <div className="space-y-2">
            <Segmented
              label="Amount condition"
              value={amountMode}
              onChange={setAmountMode}
              options={AMOUNT_MODES}
            />
            {amountMode === 'exact' && (
              <TextInput
                value={low}
                onChange={(e) => setLow(e.target.value)}
                inputMode="decimal"
                placeholder="8.99"
                aria-label="Exact amount"
              />
            )}
            {amountMode === 'range' && (
              <div className="flex items-center gap-2">
                <TextInput
                  value={low}
                  onChange={(e) => setLow(e.target.value)}
                  inputMode="decimal"
                  placeholder="5.00"
                  aria-label="Smallest amount"
                />
                <span className="shrink-0 text-sm text-ink-3">to</span>
                <TextInput
                  value={high}
                  onChange={(e) => setHigh(e.target.value)}
                  inputMode="decimal"
                  placeholder="15.00"
                  aria-label="Largest amount"
                />
              </div>
            )}
          </div>
        </Field>

        <Field label="…and it is on" hint="Optional. Only accounts you can see are offered, and a rule can only be keyed on one of those.">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Any account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="border-t border-hairline pt-4">
          <Field
            label="Call it"
            hint="Optional. What these show as, instead of whatever the bank wrote."
          >
            <TextInput
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Vet insurance"
              autoComplete="off"
            />
          </Field>
        </div>

        <Field label="Categorise as" hint="Optional, if you have given it a name.">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Don’t file it anywhere</option>
            {expense.map((c) => (
              <option key={c.id} value={c.id}>
                {fullName(c, catMap)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Sheet>
  )
}

type AmountMode = 'any' | 'exact' | 'range'

const AMOUNT_MODES: { value: AmountMode; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'exact', label: 'Exactly' },
  { value: 'range', label: 'Between' },
]

/**
 * A typed amount as minor units, or null for anything that is not one.
 *
 * Deliberately its own two lines rather than the transaction form's
 * `parseAmount`: this one is about a BOUND, so a blank is a perfectly ordinary
 * answer ("no upper limit") and has to be distinguishable from a typo.
 */
function parseMajor(raw: string): number | null {
  const t = raw.trim().replace(/[£,\s]/g, '')
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

const majorOf = (minor: number) => (minor / 100).toFixed(2)

/**
 * The two bounds a mode and a pair of numbers come to.
 *
 * `null` means "the user has chosen a condition and not finished typing it",
 * which is what stops the save button — an empty bound saved as "any" would be
 * a rule quietly wider than the one on screen.
 */
function amountBounds(mode: AmountMode, lo: number | null, hi: number | null) {
  if (mode === 'any') return undefined
  if (mode === 'exact') return lo === null ? null : { min: lo, max: lo }
  if (lo === null || hi === null) return null
  // Swapped rather than refused, exactly as `upsert_rule` does: two bounds
  // typed into two boxes pass through "larger first" on the way to being right.
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) }
}

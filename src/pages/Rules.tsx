import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, Plus, Search, Trash2, Wand2, Check } from 'lucide-react'
import type { Rule, Transaction } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import { useAllTransactions, useCategories, useCategoryMap, useMyLevels, useRules, useCacheReady } from '../lib/cache'
import { canEditTransaction, levelOn } from '../lib/accounts'
import { fullName } from '../lib/categories'
import { applyCategory, coverageOf, normalizePayee } from '../lib/rules'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import {
  Button,
  Card,
  CategoryDot,
  Chip,
  Empty,
  Field,
  Select,
  Sheet,
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
  const [preview, setPreview] = useState<Rule | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

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
        (catMap.get(r.categoryId)?.name ?? '').toLowerCase().includes(q),
    )
  }, [rules, query, catMap])

  const pending = rules.reduce((n, r) => n + (coverage.get(r.id)?.changed.length ?? 0), 0)

  async function apply(rule: Rule) {
    const list = coverage.get(rule.id)?.changed ?? []
    if (list.length === 0) return
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
        if (list.length === 0) continue
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
      <Toolbar className="justify-between">
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

      <p className="mb-3 max-w-2xl px-1 text-sm text-ink-2 md:mb-2.5">
        Every time you categorise a payee, Hearth remembers it and applies it to future entries and
        imports. Here you can point one somewhere else, apply it to what you have already recorded, or
        write one yourself. Where two rules could match, the more specific one wins — “tesco petrol”
        beats “tesco”.
      </p>

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
        <div className="relative mb-3 max-w-sm md:mb-2.5">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rules"
            className="pl-9! md:pl-8!"
          />
        </div>
      )}

      {rules.length === 0 ? (
        // `[]` from a cache that has not opened yet is not the same claim as
        // `[]` from one that has. See `useCacheReady`.
        !ready ? null : (
          <Empty
            icon={Wand2}
            title="Nothing learned yet"
            hint="Categorise a transaction and Hearth will remember the payee. You can also write a rule yourself."
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
                const cat = catMap.get(r.categoryId)
                return (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <CategoryDot category={cat} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">“{r.match}”</p>
                        <p className="truncate text-sm text-ink-3">
                          {cat ? fullName(cat, catMap) : 'Category deleted'}
                        </p>
                      </div>
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
                        <Button size="sm" variant="subtle" onClick={() => setPreview(r)}>
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
            <ScrollTable minWidth={720}>
              <thead>
                <tr className={table.head}>
                  <th className={cx(table.th, 'min-w-48 pl-3', table.pinned)}>When the payee contains</th>
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
                      <td className={cx(table.cell, 'pr-3')}>
                        {/* Select carries w-full, so the width has to live on a
                            wrapper or the base class wins. */}
                        <div className="max-w-52">
                          <Select
                            value={r.categoryId}
                            aria-label={`Category for ${r.match}`}
                            onChange={(e) => void update('rules', r.id, { categoryId: e.target.value })}
                          >
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
                              onClick={() => setPreview(r)}
                            >
                              Apply to {cov.changed.length}
                            </Button>
                          ) : (
                            cov && cov.all.length > 0 && <Chip>up to date</Chip>
                          )}
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
          and there is no undo — seeing which ones first is the whole safeguard. */}
      <Sheet
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Apply this rule"
        wide
        footer={
          <Button
            size="lg"
            className="w-full"
            disabled={busy !== null}
            onClick={() => preview && void apply(preview)}
          >
            {busy ? 'Applying…' : `Recategorise ${coverage.get(preview?.id ?? '')?.changed.length ?? 0}`}
          </Button>
        }
      >
        {preview && (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">
              These are already recorded under something else. They will move to{' '}
              <span className="font-medium text-ink">
                {catMap.get(preview.categoryId)
                  ? fullName(catMap.get(preview.categoryId)!, catMap)
                  : 'that category'}
              </span>
              . Anything added by someone else on an account you only contribute to is left alone.
            </p>
            <ul className="max-h-[46dvh] space-y-1 overflow-y-auto pr-1">
              {(coverage.get(preview.id)?.changed ?? []).map((t) => (
                <li key={t.id} className="flex items-center gap-2.5 rounded-xl bg-surface-2/50 px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.payee}</p>
                    <p className="truncate text-xs text-ink-3">
                      {t.date} · currently{' '}
                      {t.categoryId ? (catMap.get(t.categoryId)?.name ?? 'a deleted category') : 'uncategorised'}
                      {!canEdit(t) && ' · not yours to change'}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular">{money(t.amountMinor)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Sheet>

      <NewRuleSheet open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

function NewRuleSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const categories = useCategories()
  const catMap = useCategoryMap()
  const expense = categories.filter((c) => c.kind === 'expense')
  const [match, setMatch] = useState('')
  const [categoryId, setCategoryId] = useState('')

  // Stored normalised, because that is what `matchRule` compares against — a
  // rule saved as "Tesco Stores 3241" would match nothing at all.
  const normalised = normalizePayee(match)
  const canSave = normalised.length >= 3 && categoryId !== ''

  async function save() {
    if (!canSave) return
    await create('rules', { match: normalised, categoryId, createdAt: new Date().toISOString() })
    setMatch('')
    setCategoryId('')
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New rule"
      footer={
        <Button size="lg" className="w-full" disabled={!canSave} onClick={save}>
          Add rule
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
        <Field label="Categorise as">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="" disabled>
              Choose…
            </option>
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, CheckCircle2 } from 'lucide-react'
import { db, getSetting, setSetting } from '../lib/db'
import { useAccounts, useCategories, useMyLevels } from '../lib/cache'
import { fullName } from '../lib/categories'
import { canAddTransactions, levelOn } from '../lib/accounts'
import {
  parseCSV,
  guessMapping,
  extractRows,
  importHash,
  mappingKey,
  readMapping,
  writeMapping,
  type ParsedCSV,
  type ColumnMapping,
  type ImportRow,
} from '../lib/csv'
import { extractRowsFromPDF } from '../lib/pdfImport'
import { matchRule, prettyPayee, learnRule, buildHistoryMatcher } from '../lib/rules'
import { findLikelyDuplicate } from '../lib/dedupe'
import { createMany } from '../lib/data'
import { useSyncState } from '../hooks/useSync'
import { fmtFullDate, fmtDay } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { Sheet, Button, Field, Select, Segmented, cx } from './ui'

type Step = 'pick' | 'map' | 'review' | 'done'

interface ReviewRow {
  date: string
  payee: string
  amountMinor: number
  categoryId?: string
  duplicate: boolean // exact re-import of a previously imported row
  /** fuzzy match against an existing (usually manual) entry — needs the user's call */
  possibleDup?: { payee: string; date: string }
  include: boolean
  userTouched: boolean
}

export function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { money } = useApp()
  const { userId } = useSyncState()
  const categories = useCategories()
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  // A statement belongs to one account, and every transaction now needs one, so
  // this is asked rather than guessed — importing into the wrong account would
  // quietly corrupt two balances at once.
  const [accountId, setAccountId] = useState<string | undefined>()
  const [step, setStep] = useState<Step>('pick')
  const [csv, setCsv] = useState<ParsedCSV | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  /** Whether the columns on screen came from last time rather than a guess. */
  const [remembered, setRemembered] = useState(false)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [importedCount, setImportedCount] = useState(0)
  const [reading, setReading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStep('pick')
    setCsv(null)
    setMapping(null)
    setRemembered(false)
    setRows([])
    setReading(false)
  }

  function close() {
    reset()
    onClose()
  }

  async function onFile(file: File) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      setReading(true)
      try {
        const extracted = await extractRowsFromPDF(file)
        if (extracted.filter((r) => r.valid).length === 0) {
          alert('No transactions found in that PDF. If it is a scanned/photographed statement it has no text to read — try a CSV export instead.')
          return
        }
        await buildReview(extracted)
      } catch {
        alert('That PDF could not be read. Try a CSV export from your bank instead.')
      } finally {
        setReading(false)
      }
      return
    }
    const text = await file.text()
    const parsed = parseCSV(text)
    if (parsed.rows.length === 0) {
      alert('Could not find any rows in that file.')
      return
    }
    // What was chosen for this shape of file last time, if it still fits.
    const saved = readMapping(await getSetting(mappingKey(parsed.headers)), parsed)
    setCsv(parsed)
    setMapping(saved ?? guessMapping(parsed))
    setRemembered(saved !== undefined)
    setStep('map')
  }

  useEffect(() => {
    if (!accountId && accounts.length) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const preview = useMemo(() => {
    if (!csv || !mapping) return []
    return extractRows(csv, mapping).slice(0, 3)
  }, [csv, mapping])

  async function buildReview(source?: ImportRow[]) {
    const extracted = (source ?? (csv && mapping ? extractRows(csv, mapping) : [])).filter((r) => r.valid)
    if (extracted.length === 0) return
    /**
     * Remember the columns at the point they are known to work — the rows
     * extracted and the person moved on — rather than at the end of the import.
     * Getting this far is the evidence that the mapping is right; whether the
     * transactions are ultimately saved is a separate question, and abandoning
     * the review is not a reason to have to redo the columns.
     *
     * Device-local, and keyed on the file's headers rather than the account:
     * one bank exports one format, so the answer carries across accounts at the
     * same bank and not across two banks sharing one.
     */
    if (csv && mapping) void setSetting(mappingKey(csv.headers), writeMapping(mapping, csv))
    const [rules, existing, cats] = await Promise.all([
      db.rules.toArray(),
      db.transactions.toArray(),
      db.categories.toArray(),
    ])
    const existingHashes = new Set(existing.map((t) => t.importHash ?? importHash(t)))
    const fallbackExpense = cats.find((c) => c.kind === 'expense' && c.name === 'Other') ?? cats.find((c) => c.kind === 'expense')
    const fallbackIncome = cats.find((c) => c.kind === 'income') ?? fallbackExpense
    const fromHistory = buildHistoryMatcher(existing)
    const seen = new Set<string>()
    const matchedIds = new Set<string>()
    const review: ReviewRow[] = extracted.map((r) => {
      const hash = importHash(r)
      const duplicate = existingHashes.has(hash) || seen.has(hash)
      seen.add(hash)
      let possibleDup: ReviewRow['possibleDup']
      if (!duplicate) {
        const match = findLikelyDuplicate(r, existing, matchedIds)
        if (match) {
          matchedIds.add(match.id)
          possibleDup = { payee: match.payee, date: match.date }
        }
      }
      let categoryId: string | undefined
      if (r.amountMinor < 0) {
        categoryId = matchRule(r.payee, rules)?.categoryId ?? fromHistory(r.payee) ?? fallbackExpense?.id
      } else {
        categoryId = fallbackIncome?.id
      }
      return {
        date: r.date,
        payee: prettyPayee(r.payee),
        amountMinor: r.amountMinor,
        categoryId,
        duplicate,
        possibleDup,
        include: !duplicate && !possibleDup,
        userTouched: false,
      }
    })
    review.sort((a, b) => b.date.localeCompare(a.date))
    setRows(review)
    setStep('review')
  }

  async function doImport() {
    if (!accountId) return
    const toImport = rows.filter((r) => r.include)
    const now = new Date().toISOString()
    await createMany('transactions', toImport.map((r) => ({
      date: r.date,
      payee: r.payee,
      categoryId: r.categoryId,
      accountId,
      amountMinor: r.amountMinor,
      importHash: importHash(r),
      createdBy: userId,
      createdAt: now,
    })))
    // Learn from every category the user corrected by hand.
    for (const r of toImport) {
      if (r.userTouched && r.amountMinor < 0 && r.categoryId) await learnRule(r.payee, r.categoryId)
    }
    setImportedCount(toImport.length)
    setStep('done')
  }

  const dupCount = rows.filter((r) => r.duplicate).length
  const possibleCount = rows.filter((r) => r.possibleDup).length
  const includeCount = rows.filter((r) => r.include).length

  return (
    <Sheet open={open} onClose={close} title="Import bank statement" wide>
      {step === 'pick' && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            Export a statement from your bank as CSV or PDF, then drop it here. Hearth works out the columns, skips
            anything already imported, and auto-categorises from what it has learned.
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={reading}
            className="flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-hairline bg-surface-2/50 py-12 text-ink-2 transition hover:border-accent/50 hover:text-ink disabled:opacity-60"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) void onFile(f)
            }}
          >
            <FileUp size={32} className="text-accent" />
            <span className="font-medium">{reading ? 'Reading statement…' : 'Choose a CSV or PDF'}</span>
            <span className="text-sm text-ink-3">{reading ? 'this takes a few seconds' : 'or drag & drop'}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.pdf,text/csv,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />
        </div>
      )}

      {step === 'map' && csv && mapping && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            {remembered
              ? 'These are the columns you chose for this bank last time.'
              : 'Check the columns were detected correctly.'}
          </p>

          {/* Above the pickers, because it changes what the picker below it
              means. Detection reads the rows rather than only the headings and
              is usually right, but "usually" is not good enough for the one
              setting that can silently import every expense as income — so it
              is always adjustable, and the preview shows the answer. */}
          <Field label="How are the amounts written?">
            <Segmented
              value={mapping.layout}
              onChange={(layout) =>
                setMapping({
                  ...mapping,
                  layout,
                  // Switching INTO split with nothing chosen: offer the next
                  // numeric-looking column rather than an empty control.
                  moneyIn:
                    layout === 'split' && mapping.moneyIn < 0
                      ? csv.headers.findIndex((_, i) => i !== mapping.amount && i !== mapping.date && i !== mapping.payee)
                      : mapping.moneyIn,
                })
              }
              options={[
                { value: 'signed', label: 'One column' },
                { value: 'split', label: 'Out and in' },
              ]}
            />
            <span className="mt-1 block text-xs text-ink-3">
              {mapping.layout === 'split'
                ? 'Two columns, both usually positive — which column a value is in says whether it went out or came in.'
                : 'One column, negative for money out.'}
            </span>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date column">
              <Select value={mapping.date} onChange={(e) => setMapping({ ...mapping, date: Number(e.target.value) })}>
                {csv.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description column">
              <Select value={mapping.payee} onChange={(e) => setMapping({ ...mapping, payee: Number(e.target.value) })}>
                {csv.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={mapping.layout === 'split' ? 'Money out column' : 'Amount column'}>
              <Select value={mapping.amount} onChange={(e) => setMapping({ ...mapping, amount: Number(e.target.value) })}>
                {csv.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
            {/* Only under `split`, and it sits directly under the money-out
                picker so the pair reads as a pair. */}
            {mapping.layout === 'split' && (
              <Field label="Money in column">
                <Select
                  value={mapping.moneyIn}
                  onChange={(e) => setMapping({ ...mapping, moneyIn: Number(e.target.value) })}
                >
                  {csv.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Date format">
              <Select value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value })}>
                {['dd/MM/yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'dd-MM-yyyy', 'dd MMM yyyy', 'dd.MM.yyyy'].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="overflow-x-auto rounded-xl bg-surface-2/60 p-3 text-sm">
            <p className="mb-2 font-medium text-ink-2">Preview</p>
            {preview.map((r, i) => (
              <div key={i} className={cx('flex justify-between gap-4 py-1', !r.valid && 'text-critical-text')}>
                <span className="w-24 shrink-0 tabular">{r.date ? fmtFullDate(r.date) : '—'}</span>
                <span className="min-w-0 flex-1 truncate">{r.payee || '—'}</span>
                <span className="shrink-0 font-medium tabular">{r.amountMinor !== 0 ? money(r.amountMinor, { sign: true }) : '—'}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="subtle" onClick={reset}>
              Back
            </Button>
            <Button className="flex-1" onClick={() => void buildReview()} disabled={!preview.some((r) => r.valid)}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            {rows.length} transactions found
            {dupCount > 0 && <> · {dupCount} already imported</>}
            {possibleCount > 0 && (
              <>
                {' '}· <span className="font-medium text-ink">{possibleCount} possible duplicate{possibleCount === 1 ? '' : 's'}</span> of
                entries you added by hand — they're unticked, so tick any that are genuinely separate purchases
              </>
            )}
            . Fix any categories — Hearth learns from your corrections.
          </p>
          <Field label="Import into">
            <Select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || undefined)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="max-h-[46dvh] space-y-1 overflow-y-auto pr-1">
            {rows.map((r, i) => (
              <div
                key={i}
                className={cx(
                  'flex items-center gap-2.5 rounded-xl px-2 py-1.5',
                  r.duplicate && 'opacity-55',
                  r.include && 'bg-surface-2/50',
                  r.possibleDup && !r.include && 'ring-1 ring-warning/50',
                )}
              >
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                  className="size-4 shrink-0 accent-[var(--accent)]"
                  aria-label={`Include ${r.payee}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {r.payee}
                    {r.duplicate && <span className="ml-1.5 text-xs text-ink-3">already imported</span>}
                  </p>
                  <p className="truncate text-xs text-ink-3 tabular">
                    {fmtFullDate(r.date)}
                    {r.possibleDup && (
                      <span className="text-ink-2">
                        {' '}· looks like “{r.possibleDup.payee}” added {fmtDay(r.possibleDup.date)}
                      </span>
                    )}
                  </p>
                </div>
                {r.amountMinor < 0 ? (
                  <select
                    value={r.categoryId}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, categoryId: e.target.value, userTouched: true } : x)))
                    }
                    className="h-8 max-w-32 shrink-0 truncate rounded-lg bg-surface-2 px-2 text-xs outline-none"
                    aria-label="Category"
                  >
                    {categories
                      .filter((c) => c.kind === 'expense' && !c.ownerId)
                      .map((c) => (
                        // The full path, since a bare "Insurance" is ambiguous
                        // once several categories have one.
                        <option key={c.id} value={c.id}>
                          {fullName(c, catMap)}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="shrink-0 text-xs text-ink-3">income</span>
                )}
                <span className={cx('w-20 shrink-0 text-right text-sm font-semibold tabular', r.amountMinor > 0 && 'text-good-text')}>
                  {money(r.amountMinor, { sign: r.amountMinor > 0 })}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="subtle" onClick={() => (csv ? setStep('map') : reset())}>
              Back
            </Button>
            <Button className="flex-1" disabled={includeCount === 0} onClick={doImport}>
              Import {includeCount} transaction{includeCount === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 size={44} className="text-good" />
          <p className="text-lg font-semibold">Imported {importedCount} transactions</p>
          <p className="max-w-sm text-sm text-ink-2">
            They're categorised and in your activity. The more you correct, the smarter future imports get.
          </p>
          <Button onClick={close}>Done</Button>
        </div>
      )}
    </Sheet>
  )
}

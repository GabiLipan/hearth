import { useMemo, useRef, useState } from 'react'
import { FileUp, CheckCircle2 } from 'lucide-react'
import { db, getSetting, setSetting, type Transaction } from '../lib/db'
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
import {
  categoryRule,
  titleRule,
  learnRule,
  buildHistoryMatcher,
  buildTitleMatcher,
  cleanTitle,
  kindOfAmount,
} from '../lib/rules'
import { findLikelyDuplicate } from '../lib/dedupe'
import { createMany, update } from '../lib/data'
import { canEditTransaction } from '../lib/accounts'
import { TxnName } from './TxnName'
import { useSyncState } from '../hooks/useSync'
import { fmtFullDate, fmtDay } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { alertAction } from './confirm'
import { statementOrder, type ImportBatch } from '../lib/imports'
import { ImportBatchRow } from './ImportHistory'
import { Sheet, Button, Field, Select, Segmented, CheckRow, AccountDot, useInfoNote, cx } from './ui'

type Step = 'pick' | 'map' | 'review' | 'done'

/** "its reference", "its reference and a category", "a, b and c". */
function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? 'the details'
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * Everything this screen has to say that is longer than a line, in one place.
 *
 * All of it lives behind a ⓘ. A wizard that explains itself in paragraphs is
 * read once and skimmed for ever after, and the paragraphs then sit between
 * somebody and the control they came for.
 */
const ABOUT_ACCOUNT = (
  <>
    <p>Every row in the file goes into this account, and its balance moves by their total.</p>
    <p>
      Put one in the wrong account and nothing is lost: Settings › Accounts lists recent imports, where one can be
      moved across or taken back out.
    </p>
  </>
)

const ABOUT_FILE = (
  <>
    <p>Export a statement from your bank as CSV or PDF, then drop it here.</p>
    <p>
      Hearth works out the columns, skips anything already imported, and files each row from what it has learned
      about the payee.
    </p>
  </>
)

const ABOUT_DUPLICATES = (
  <>
    <p>
      Rows already imported are shown greyed and unticked. So are ones that look like something you added by
      hand: tick any that are genuinely separate purchases.
    </p>
    <p>
      Where the statement knows something your own entry does not — its bank reference above all — it can fill
      that in instead of importing a second copy.
    </p>
    <p>Correct a category here and Hearth remembers it for that payee.</p>
  </>
)

interface ReviewRow {
  date: string
  /**
   * Where this row sat in the file, counting up with time — see
   * `statementOrder`. Carried through review because the review screen SORTS by
   * date, which is where the file's own order used to be lost for good.
   */
  seq: number
  payee: string
  /** What a rule, or the rows already imported, say this payee is called. */
  title?: string
  amountMinor: number
  categoryId?: string
  duplicate: boolean // exact re-import of a previously imported row
  /** fuzzy match against an existing (usually manual) entry — needs the user's call */
  possibleDup?: { payee: string; title?: string; date: string }
  /**
   * The row this one is the statement's version of, and what the statement can
   * tell it that it does not already know.
   *
   * A transaction added by hand is the same purchase written from the other
   * end: it has a name and a date and no reference, because nobody types
   * "SQ *THE GOOD FORK 3241". The statement has the reference, the import hash
   * and — through the rules — often a category. Filling those in is strictly
   * better than either importing a second copy of the purchase or discarding
   * what the statement knows.
   *
   * Only ever fields the existing row is MISSING. The statement never overwrites
   * something a person typed.
   */
  completes?: { id: string; fills: Partial<Transaction>; words: string[] }
  /** Whether to actually fill them in. Off for a row nobody may edit. */
  complete: boolean
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
  const [completedCount, setCompletedCount] = useState(0)
  const [reading, setReading] = useState(false)
  /** The one just made, offered on the last screen while it is still in mind. */
  const [lastBatch, setLastBatch] = useState<ImportBatch | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileNote = useInfoNote('Statement', ABOUT_FILE)
  const reviewNote = useInfoNote('What was found', ABOUT_DUPLICATES)

  function reset() {
    setStep('pick')
    setCsv(null)
    setMapping(null)
    setRemembered(false)
    setRows([])
    setReading(false)
    // The account goes too. A statement is imported into the account somebody
    // chose for it, not into whatever the last one went to.
    setAccountId(undefined)
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
          await alertAction('No transactions in that PDF', [
            'Nothing in it could be read as a row.',
            'If it is a scanned or photographed statement there is no text to read — a CSV export from your bank will work.',
          ])
          return
        }
        await buildReview(extracted)
      } catch {
        await alertAction('That PDF could not be read', 'Try a CSV export from your bank instead.')
      } finally {
        setReading(false)
      }
      return
    }
    const text = await file.text()
    const parsed = parseCSV(text)
    if (parsed.rows.length === 0) {
      await alertAction('No rows in that file', 'Nothing in it looked like a list of transactions.')
      return
    }
    // What was chosen for this shape of file last time, if it still fits.
    const saved = readMapping(await getSetting(mappingKey(parsed.headers)), parsed)
    setCsv(parsed)
    setMapping(saved ?? guessMapping(parsed))
    setRemembered(saved !== undefined)
    setStep('map')
  }

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
    // The file's own order, normalised to count up with time, taken BEFORE
    // anything sorts these rows. Inside a day it is the only evidence there is
    // about which transaction came first — a statement carries no clock.
    const order = statementOrder(extracted.map((r) => r.date))
    const fallbackExpense = cats.find((c) => c.kind === 'expense' && c.name === 'Other') ?? cats.find((c) => c.kind === 'expense')
    const fallbackIncome = cats.find((c) => c.kind === 'income') ?? fallbackExpense
    // One matcher per sort, because the answer differs by sign: the same payee
    // can pay you and be paid, and a salary must not inherit the category its
    // employer's expense rows were filed under.
    const fromHistory = buildHistoryMatcher(existing, 'expense')
    const fromIncomeHistory = buildHistoryMatcher(existing, 'income')
    const fromTitles = buildTitleMatcher(existing)
    const kindOf = (id: string) => cats.find((c) => c.id === id)?.kind
    const seen = new Set<string>()
    const matchedIds = new Set<string>()
    const review: ReviewRow[] = extracted.map((r, i) => {
      const hash = importHash(r)
      const duplicate = existingHashes.has(hash) || seen.has(hash)
      seen.add(hash)
      let match: Transaction | undefined
      if (!duplicate) {
        match = findLikelyDuplicate(r, existing, matchedIds)
        if (match) matchedIds.add(match.id)
      }
      // Everything a rule may test, since a statement line carries all of it:
      // the account is the one being imported into, and the amount is on the
      // row. Anything narrower would silently ignore the conditions on exactly
      // the rows they were written for.
      const kind = kindOfAmount(r.amountMinor)
      const target = { payee: r.payee, amountMinor: r.amountMinor, accountId, kind }
      // Both sorts go through the rules now. Income used to be dropped straight
      // into "Other income" without asking, so the one row worth automating —
      // a salary, every month, from the same string — was the one row no rule
      // could ever reach.
      const categoryId =
        kind === 'expense'
          ? (categoryRule(target, rules, kindOf)?.categoryId ?? fromHistory(r.payee) ?? fallbackExpense?.id)
          : (categoryRule(target, rules, kindOf)?.categoryId ?? fromIncomeHistory(r.payee) ?? fallbackIncome?.id)
      // The payoff for having learned a name: a statement full of bank strings
      // arrives already reading in English. Asked of the rules first and of
      // what past rows were called second, exactly as the category is — and on
      // income too, where a category is not.
      const title = cleanTitle(titleRule(target, rules)?.title) ?? fromTitles(r.payee)

      // What the statement can tell the row somebody already added, limited to
      // what that row is missing. The reference is the one that matters —
      // without it the manual row can never be matched by anything again, and
      // will keep being offered as a possible duplicate of every future
      // statement.
      let completes: ReviewRow['completes']
      if (match) {
        const fills: Partial<Transaction> = {}
        const words: string[] = []
        if (!match.payee.trim() && r.payee.trim()) {
          fills.payee = r.payee.trim()
          words.push('its reference')
        }
        if (!match.importHash) fills.importHash = hash
        if (!cleanTitle(match.title) && title) {
          fills.title = title
          words.push('a name')
        }
        if (!match.categoryId && categoryId) {
          fills.categoryId = categoryId
          words.push('a category')
        }
        if (Object.keys(fills).length > 0) completes = { id: match.id, fills, words }
      }

      return {
        date: r.date,
        seq: order[i],
        // Exactly what the statement said. `prettyPayee` used to title-case a
        // stripped-down version of it, which threw away the very string the
        // reference exists to be — the one you can find on your bank's website.
        // Making it readable is what `title` is for.
        payee: r.payee.trim(),
        title,
        amountMinor: r.amountMinor,
        categoryId,
        duplicate,
        possibleDup: match ? { payee: match.payee, title: match.title, date: match.date } : undefined,
        completes,
        complete: completes !== undefined && canEditTransaction(match!, levelOn(match!.accountId, levels), userId),
        include: !duplicate && !match,
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
    const ids = await createMany('transactions', toImport.map((r) => ({
      date: r.date,
      // The bank's own order inside a day, which is the only one there is.
      statementOrder: r.seq,
      payee: r.payee,
      title: r.title,
      categoryId: r.categoryId,
      accountId,
      amountMinor: r.amountMinor,
      importHash: importHash(r),
      createdBy: userId,
      createdAt: now,
    })))
    /**
     * The rows that were already here, finished off.
     *
     * These are NOT imported — a second copy of the same purchase is exactly
     * what the duplicate check exists to prevent — but everything the statement
     * knows and the manual row does not is written onto it. Field-level, so two
     * devices doing this at once cannot overwrite each other, and only fields
     * that were empty, so nothing anybody typed is touched.
     */
    let completed = 0
    for (const r of rows) {
      if (!r.complete || !r.completes) continue
      await update('transactions', r.completes.id, r.completes.fills)
      completed++
    }
    // Learn from every category the user corrected by hand, whichever way the
    // money went: a category may only ever file a row of its own kind, so an
    // income rule cannot reach spending and the reverse.
    for (const r of toImport) {
      if (r.userTouched && r.categoryId)
        await learnRule(
          { payee: r.payee, amountMinor: r.amountMinor, accountId, kind: kindOfAmount(r.amountMinor) },
          { categoryId: r.categoryId },
        )
    }
    setImportedCount(toImport.length)
    setCompletedCount(completed)
    /**
     * The batch, named here rather than re-derived.
     *
     * `importBatches` would find exactly this run a moment later — the rows
     * share `createdAt` and an account — but the ids are in hand now, and the
     * screen that offers to undo it should not depend on a grouping heuristic
     * agreeing with itself.
     */
    setLastBatch(
      ids.length > 0
        ? {
            key: `${accountId}:${now}`,
            accountId,
            at: now,
            ids,
            count: ids.length,
            from: toImport.map((r) => r.date).sort()[0],
            to: toImport.map((r) => r.date).sort()[toImport.length - 1],
            totalMinor: toImport.reduce((sum, r) => sum + r.amountMinor, 0),
          }
        : null,
    )
    setStep('done')
  }

  const accountName = (id: string) => allAccounts.find((a) => a.id === id)?.name ?? 'an account'

  /**
   * Where this file is going, said on every screen after the choice.
   *
   * The account is chosen once, at the start, and then travels with the file
   * in plain sight — so the last press before rows are written is made by
   * somebody who has been told twice which account they are writing to.
   */
  function destination() {
    const account = allAccounts.find((a) => a.id === accountId)
    return (
      <div className="flex items-center gap-2.5 rounded-xl bg-surface-2/60 px-2.5 py-2">
        <AccountDot account={account} size={28} />
        <span className="shrink-0 text-sm text-ink-2">Into</span>
        {/* Still changeable — losing the file to correct the account would be
            its own small punishment — but it is on screen throughout rather
            than being one control at the foot of a long review. */}
        <div className="min-w-0 flex-1">
          <Select
            value={accountId ?? ''}
            aria-label="Import into"
            onChange={(e) => setAccountId(e.target.value || undefined)}
          >
            <option value="">Choose an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
    )
  }

  const dupCount = rows.filter((r) => r.duplicate).length
  const possibleCount = rows.filter((r) => r.possibleDup).length
  const includeCount = rows.filter((r) => r.include).length
  const completeCount = rows.filter((r) => r.complete && r.completes).length

  return (
    <Sheet open={open} onClose={close} title="Import bank statement" wide>
      {step === 'pick' && (
        <div className="space-y-4">
          {/* The account comes FIRST, and starts empty.

              It used to be asked at the end of the review, defaulted to the
              first account in the list — so a statement imported without
              looking at that one control went into whatever account happened to
              be first, which is how a whole statement lands in the wrong place.
              An empty control that gates the file picker cannot be answered by
              accident. */}
          <Field label="Import into" info={ABOUT_ACCOUNT}>
            <Select
              value={accountId ?? ''}
              onChange={(e) => setAccountId(e.target.value || undefined)}
            >
              <option value="">Choose an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-medium text-ink-2 md:text-xs">Statement</p>
              {fileNote.toggle}
            </div>
            {fileNote.body}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={reading || !accountId}
              className="mt-1.5 flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-hairline bg-surface-2/50 py-12 text-ink-2 transition hover:border-accent/50 hover:text-ink disabled:opacity-60 disabled:hover:border-hairline"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (!accountId) return
                const f = e.dataTransfer.files?.[0]
                if (f) void onFile(f)
              }}
            >
              <FileUp size={32} className={accountId ? 'text-accent' : 'text-ink-3'} />
              <span className="font-medium">
                {reading ? 'Reading statement…' : accountId ? 'Choose a CSV or PDF' : 'Choose an account first'}
              </span>
              {(reading || accountId) && (
                <span className="text-sm text-ink-3">{reading ? 'this takes a few seconds' : 'or drag & drop'}</span>
              )}
            </button>
          </div>
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
          {destination()}
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
                  // Under split the side says which way the money went, so the
                  // sign question does not arise — cleared here as well as in
                  // `guessMapping`, or it would be remembered on a file where
                  // it means nothing and come back if the layout changed again.
                  invert: layout === 'signed' && mapping.invert,
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

          {/* Only under `signed`, because only there does the column carry the
              direction. Detected from the rows — a column that is mostly
              positive is a card rather than a bank account — and always shown,
              because the preview below is the only thing that can tell you the
              guess was wrong before the figures are in the app. */}
          {mapping.layout === 'signed' && (
            <CheckRow
              checked={mapping.invert}
              onChange={(invert) => setMapping({ ...mapping, invert })}
              label="Money out is written as a positive"
              info="Amex and most credit cards do this: a purchase is a plus, and the payment that clears the card is a minus. A bank account is the other way round."
            />
          )}

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
          {destination()}
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm text-ink-2">
              {rows.length} found
              {dupCount > 0 && <> · {dupCount} already imported</>}
              {possibleCount > 0 && (
                <>
                  {' '}·{' '}
                  <span className="font-medium text-ink">
                    {possibleCount} possible duplicate{possibleCount === 1 ? '' : 's'}
                  </span>
                </>
              )}
            </p>
            {reviewNote.toggle}
          </div>
          {reviewNote.body}
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
                  onChange={(e) =>
                    setRows(
                      rows.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              include: e.target.checked,
                              // One purchase is either a new row or the row that
                              // is already here, finished off. Never both.
                              complete: e.target.checked ? false : x.completes !== undefined,
                            }
                          : x,
                      ),
                    )
                  }
                  className="size-4 shrink-0 accent-[var(--accent)]"
                  aria-label={`Include ${r.title ?? r.payee}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 text-sm font-medium">
                    <TxnName txn={r} />
                    {r.duplicate && <span className="ml-1.5 shrink-0 text-xs text-ink-3">already imported</span>}
                  </p>
                  <p className="truncate text-xs text-ink-3 tabular">
                    {fmtFullDate(r.date)}
                    {r.possibleDup && (
                      <span className="text-ink-2">
                        {' '}· looks like “
                        {r.possibleDup.title ?? r.possibleDup.payee ?? 'one you added'}” added{' '}
                        {fmtDay(r.possibleDup.date)}
                      </span>
                    )}
                  </p>
                  {/* The offer that stops a manual entry and its statement line
                      being two rows for one purchase: keep the one that is
                      there, and give it what the statement knows. */}
                  {r.completes && !r.include && (
                    <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
                      <input
                        type="checkbox"
                        checked={r.complete}
                        onChange={(e) =>
                          setRows(rows.map((x, j) => (j === i ? { ...x, complete: e.target.checked } : x)))
                        }
                        className="size-3.5 shrink-0 accent-[var(--accent)]"
                      />
                      Fill in {listWords(r.completes.words)} on the one you added
                    </label>
                  )}
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
                      // The row's own sort: a statement line that paid money in
                      // can only be filed under an income category, and offering
                      // the other twenty is offering a wrong answer.
                      .filter((c) => c.kind === kindOfAmount(r.amountMinor) && !c.ownerId)
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
            {/* Completing rows is real work with nothing imported, so the
                button has to be pressable when that is all there is to do. */}
            {/* The account is in the label, so the last press before rows are
                written says where they are going. */}
            <Button
              className="flex-1"
              disabled={!accountId || (includeCount === 0 && completeCount === 0)}
              onClick={doImport}
            >
              {includeCount === 0
                ? `Fill in ${completeCount} transaction${completeCount === 1 ? '' : 's'}`
                : `Import ${includeCount} into ${accountId ? accountName(accountId) : 'an account'}`}
              {includeCount > 0 && completeCount > 0 && `, fill in ${completeCount}`}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-3">
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 size={44} className="text-good" />
            {/* `lastBatch` going empty on this screen means it was undone from
                it, so the heading has to be able to say so. */}
            <p className="text-lg font-semibold">
              {lastBatch
                ? `Imported ${importedCount} into ${accountName(lastBatch.accountId)}`
                : importedCount > 0
                  ? 'Import taken back out'
                  : `Filled in ${completedCount} transaction${completedCount === 1 ? '' : 's'}`}
            </p>
            {completedCount > 0 && importedCount > 0 && (
              <p className="text-sm text-ink-2">
                {completedCount} you had already added {completedCount === 1 ? 'was' : 'were'} filled in rather
                than imported again.
              </p>
            )}
          </div>
          {/* Wrong account is discovered a second after the press, not a week
              later, so the way to put it right is on this screen — the same
              row, with the same two controls, as under Recent imports. */}
          {lastBatch && <ImportBatchRow batch={lastBatch} onChanged={setLastBatch} />}
          <Button className="w-full" onClick={close}>
            Done
          </Button>
        </div>
      )}
    </Sheet>
  )
}

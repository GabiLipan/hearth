import { useCallback, useEffect, useRef, useState } from 'react'
import { ListOrdered, Undo2 } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { useAccounts, useMyLevels } from '../lib/cache'
import { canAddTransactions, canEditTransaction, levelOn } from '../lib/accounts'
import { update } from '../lib/data'
import {
  applyStatementOrder,
  importBatches,
  matchStatement,
  moveImport,
  readStatement,
  statementOrder,
  undoImport,
  type ImportBatch,
  type StatementPlan,
} from '../lib/imports'
import { useSyncState } from '../hooks/useSync'
import { fmtDay, fmtFullDate } from '../lib/dates'
import { alertAction, confirmAction } from './confirm'
import { toast } from './toast'
import { AccountDot, Button, Card, Select, SectionTitle, useInfoNote } from './ui'

/**
 * The way back out of an import.
 *
 * Lives in Settings, beside the accounts an import lands in, rather than on the
 * way IN to the next one: a list of what you have already done is not part of
 * doing the next thing. The one exception is the row the import wizard shows on
 * its own last screen, which is about the import just made and disappears with
 * it — same component, one batch, no list.
 */
const ABOUT = (
  <>
    <p>Imports made on this device in the last two months, while their rows are still here.</p>
    <p>
      Changing the account moves every row in that import. Undo deletes them — importing the statement again
      brings them back.
    </p>
  </>
)

export function ImportsSection() {
  const [batches, setBatches] = useState<ImportBatch[] | null>(null)
  const note = useInfoNote('Recent imports', ABOUT)

  const refresh = useCallback(async () => {
    setBatches(importBatches(await db.transactions.toArray()))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section>
      <SectionTitle>Recent imports</SectionTitle>
      <Card className="space-y-2 p-4 md:p-3">
        <div className="flex items-center justify-between gap-2">
          {/* `null` is a cache that has not opened yet, which is a different
              claim from "nothing was imported" — see `useCacheReady`. */}
          <p className="min-w-0 text-sm text-ink-2 md:text-xs">
            {batches === null
              ? '\u00a0'
              : batches.length === 0
                ? 'Nothing imported in the last two months'
                : 'Move one to another account, or take it back out'}
          </p>
          {note.toggle}
        </div>
        {note.body}
        {batches && batches.length > 0 && (
          <div className="space-y-1.5">
            {batches.map((b) => (
              <ImportBatchRow key={b.key} batch={b} onChanged={() => void refresh()} />
            ))}
          </div>
        )}
      </Card>
    </section>
  )
}

/* ---------- the order a statement was in ---------- */

const ORDER_ABOUT = (
  <>
    <p>
      A statement carries no clock inside a day, so the order the bank listed it in is the only answer to which of
      two transactions on the same date came first. An import used to throw that away.
    </p>
    <p>
      Give it a statement covering rows that are already here — a year to date, the whole account — and it writes
      that order onto them. Nothing is added, removed or refiled: it matches each line to a transaction you already
      have, and sets one field on it.
    </p>
  </>
)

/**
 * Set the order of transactions already here, from the statement they came off.
 *
 * A repair rather than an import, and it lives beside the import history for
 * the reason that list lives here at all: what you have already done is not
 * part of doing the next thing. Nothing on this screen creates a transaction.
 *
 * The account is asked for BEFORE the file and starts empty, which is the same
 * discipline the wizard follows — a control that must be answered cannot be
 * answered by accident, and here it decides which rows are even considered.
 *
 * There is deliberately no column-mapping step. A mapping that is wrong cannot
 * import anything wrong from here; it simply matches nothing, and "0 of 418
 * lines matched" is a better answer than four questions about columns. See
 * `readStatement`.
 */
export function StatementOrderSection() {
  const accounts = useAccounts()
  const levels = useMyLevels()
  const { userId } = useSyncState()
  const note = useInfoNote('Order from a statement', ORDER_ABOUT)
  const fileRef = useRef<HTMLInputElement>(null)

  const [accountId, setAccountId] = useState('')
  const [reading, setReading] = useState(false)
  const [plan, setPlan] = useState<StatementPlan | null>(null)
  const [saving, setSaving] = useState(false)

  const mine = accounts.filter((a) => canAddTransactions(levelOn(a.id, levels)))

  async function onFile(file: File) {
    if (!accountId) return
    setReading(true)
    setPlan(null)
    try {
      const rows = await readStatement(file)
      if (rows.filter((r) => r.valid).length === 0) {
        await alertAction('Nothing in that file could be read as a statement', [
          'No line in it looked like a date, a description and an amount.',
          'A scanned or photographed PDF has no text to read — a CSV export from your bank will work.',
        ])
        return
      }
      // The file's own order, taken over every line so the positions match the
      // document rather than the subset that parsed.
      const seqs = statementOrder(rows.map((r) => r.date))
      const onAccount = await db.transactions.where('accountId').equals(accountId).toArray()
      setPlan(matchStatement(rows, seqs, onAccount))
    } catch {
      await alertAction('That file could not be read', 'Try a CSV export from your bank instead.')
    } finally {
      setReading(false)
    }
  }

  async function apply() {
    if (!plan) return
    setSaving(true)
    try {
      const { updated, skipped, before } = await applyStatementOrder(plan.changed, (t) =>
        canEditTransaction(t, levelOn(t.accountId, levels), userId),
      )
      setPlan(null)
      // A real undo, not an offer of one: this is an UPDATE, so putting every
      // row back where it was is another write of the same kind — including the
      // rows that carried no order at all, where the way back is `undefined`.
      toast(
        skipped > 0
          ? `${updated} in order · ${skipped} are not yours to change`
          : `${updated} ${updated === 1 ? 'transaction' : 'transactions'} put in order`,
        {
          undo:
            updated > 0
              ? async () => {
                  for (const [id, was] of before) await update('transactions', id, { statementOrder: was })
                }
              : undefined,
        },
      )
    } finally {
      setSaving(false)
    }
  }

  const account = accounts.find((a) => a.id === accountId)

  return (
    <section>
      <SectionTitle>Order from a statement</SectionTitle>
      <Card className="space-y-3 p-4 md:p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-sm text-ink-2 md:text-xs">
            Put transactions already here back in the order the bank listed them
          </p>
          {note.toggle}
        </div>
        {note.body}

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value)
              setPlan(null)
            }}
            aria-label="Account"
          >
            <option value="">Which account…</option>
            {mine.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Button
            variant="subtle"
            size="sm"
            disabled={!accountId || reading || saving}
            onClick={() => fileRef.current?.click()}
          >
            <ListOrdered size={15} />
            {reading ? 'Reading…' : 'Choose a statement'}
          </Button>
          {account && <AccountDot account={account} size={22} />}
        </div>

        {plan && (
          <div className="space-y-2 rounded-xl bg-surface-2 p-3">
            <p className="text-sm">
              <span className="font-semibold tabular">{plan.matched.length}</span>{' '}
              {plan.matched.length === 1 ? 'line matches a transaction' : 'lines match transactions'} here
              {plan.changed.length !== plan.matched.length && (
                <>
                  {' · '}
                  <span className="tabular">{plan.changed.length}</span> to change
                </>
              )}
            </p>
            {/* Both of the ways a statement and an account can disagree, said
                plainly: neither is an error, and a repair that hid them would
                be a repair nobody could check. */}
            <p className="text-xs text-ink-3">
              {plan.unmatchedLines > 0 && (
                <>
                  {plan.unmatchedLines} {plan.unmatchedLines === 1 ? 'line' : 'lines'} in the file had nothing here to
                  match — those are transactions you have not imported.{' '}
                </>
              )}
              {plan.unmatchedRows.length > 0 && (
                <>
                  {plan.unmatchedRows.length}{' '}
                  {plan.unmatchedRows.length === 1 ? 'transaction here was' : 'transactions here were'} not on the
                  statement, and keep the order they have.
                </>
              )}
            </p>
            <Button size="sm" disabled={saving || plan.changed.length === 0} onClick={() => void apply()}>
              {plan.changed.length === 0
                ? 'Already in this order'
                : `Set the order of ${plan.changed.length} ${plan.changed.length === 1 ? 'row' : 'rows'}`}
            </Button>
          </div>
        )}

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
      </Card>
    </section>
  )
}

/**
 * One import, with the two ways of putting it right.
 *
 * `onChanged` is handed the batch as it now stands, or `null` where it has been
 * undone — so a caller holding a single batch (the wizard's last screen) can
 * follow it, and a caller holding a list can simply re-read.
 */
export function ImportBatchRow({
  batch,
  onChanged,
}: {
  batch: ImportBatch
  onChanged?: (next: ImportBatch | null) => void
}) {
  const { userId } = useSyncState()
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const accounts = allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels)))
  const [busy, setBusy] = useState(false)

  const account = allAccounts.find((a) => a.id === batch.accountId)
  const nameOf = (id: string) => allAccounts.find((a) => a.id === id)?.name ?? 'an account'

  /**
   * `transactions_update`, asked twice.
   *
   * The policy checks the row's account on the way in AND on the way out, so a
   * move needs the edit right on both. Asked here rather than discovered as a
   * dead letter minutes later.
   */
  const mayMove = (to: string) => (t: Transaction) =>
    canEditTransaction(t, levelOn(t.accountId, levels), userId) &&
    canEditTransaction(t, levelOn(to, levels), userId)

  const mayEdit = (t: Transaction) => canEditTransaction(t, levelOn(t.accountId, levels), userId)

  /** What happened, including what did not: a bulk write that quietly does less
      than the button promised is worse than one that refuses. */
  const said = (sentence: string, skipped: number) =>
    toast(skipped === 0 ? sentence : `${sentence} · ${skipped} left alone, they are not yours to change`)

  async function move(to: string) {
    if (to === batch.accountId) return
    const ok = await confirmAction({
      title: `Move ${batch.count} transactions to ${nameOf(to)}?`,
      body: 'Only the account changes. Everything else about them stays as it is.',
      confirmLabel: 'Move',
    })
    if (!ok) return
    setBusy(true)
    const { done, skipped } = await moveImport(batch, to, mayMove(to))
    setBusy(false)
    said(`Moved ${done} to ${nameOf(to)}`, skipped)
    onChanged?.({ ...batch, accountId: to })
  }

  async function undo() {
    const ok = await confirmAction({
      title: `Delete these ${batch.count} transactions?`,
      body: `They leave ${nameOf(batch.accountId)} for good. Importing the statement again brings them back.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const { done, skipped } = await undoImport(batch, mayEdit)
    setBusy(false)
    said(`Deleted ${done} transactions`, skipped)
    onChanged?.(null)
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-surface-2/60 px-2.5 py-2">
      <AccountDot account={account} size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {batch.count} transactions · {account?.name ?? 'an account'}
        </p>
        <p className="truncate text-xs text-ink-3 tabular">
          {fmtDay(batch.at.slice(0, 10))} · {fmtFullDate(batch.from)} – {fmtFullDate(batch.to)}
        </p>
      </div>
      {/* Direct manipulation: the account they went into IS the control that
          moves them. A "move" button would only open a second screen asking the
          question this picker already asks.

          The width is on a wrapper, never on the `Select` — it carries
          `w-full`, and Tailwind's generated order means a width passed to it
          does nothing. */}
      <div className="w-32 shrink-0">
        <Select
          value={batch.accountId}
          disabled={busy}
          aria-label="Account these went into"
          onChange={(e) => void move(e.target.value)}
        >
          {/* The account they are ON, even where it is not one you could import
              into: a select with no option matching its value shows blank,
              which would read as "nowhere". */}
          {!accounts.some((a) => a.id === batch.accountId) && (
            <option value={batch.accountId}>{account?.name ?? 'This account'}</option>
          )}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>
        <Undo2 size={15} /> Undo
      </Button>
    </div>
  )
}

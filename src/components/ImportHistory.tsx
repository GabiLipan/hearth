import { useCallback, useEffect, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { useAccounts, useMyLevels } from '../lib/cache'
import { canAddTransactions, canEditTransaction, levelOn } from '../lib/accounts'
import { importBatches, moveImport, undoImport, type ImportBatch } from '../lib/imports'
import { useSyncState } from '../hooks/useSync'
import { fmtDay, fmtFullDate } from '../lib/dates'
import { confirmAction } from './confirm'
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

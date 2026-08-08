import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowLeftRight, HelpCircle } from 'lucide-react'
import type { Transaction } from '../lib/db'
import { useAccountMap, useAllTransactions, useMyLevels } from '../lib/cache'
import { canEditTransaction, levelOn } from '../lib/accounts'
import {
  autoLinkTransfers,
  detectTransfers,
  dismissTransfer,
  getTransferMode,
  linkTransfer,
  type TransferCandidate,
  type TransferMode,
} from '../lib/transfers'
import { syncNow } from '../lib/session'
import { useSyncState } from '../hooks/useSync'
import { fmtDay } from '../lib/dates'
import { useApp } from '../state/AppContext'
import { Button, Card, Chip, cx } from './ui'

/**
 * "These two look like the same £500."
 *
 * Sits above the activity list rather than in Settings, because the thing it is
 * talking about is right underneath it — you can see both legs while deciding.
 *
 * Nothing here is automatic in `ask` mode, and even in `auto` mode only pairs
 * with a single possible reading are linked without being shown. An ambiguous
 * pair is a question the app cannot answer, and guessing wrong does not add a
 * row you can delete: it removes two real amounts from every total in the app.
 */
export function TransferReview() {
  const { money } = useApp()
  const { userId } = useSyncState()
  const accMap = useAccountMap()
  const levels = useMyLevels()
  const txns = useAllTransactions()

  const [mode, setMode] = useState<TransferMode | null>(null)
  const [candidates, setCandidates] = useState<TransferCandidate[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [autoLinked, setAutoLinked] = useState(0)

  /**
   * Pairs this mount has already auto-linked.
   *
   * The link is written on the server, so the local rows keep `transferId`
   * undefined until the next pull — which means the detector would happily
   * propose the same pair again on the very next render and try to link it a
   * second time. The server refuses (idempotently), but a loop of refused RPCs
   * is not something to leave running behind a screen.
   */
  const handled = useRef(new Set<string>())

  useEffect(() => {
    void getTransferMode().then(setMode)
  }, [])

  const canEditBoth = useMemo(
    () => (c: TransferCandidate) =>
      canEditTransaction(c.out, levelOn(c.out.accountId, levels), userId) &&
      canEditTransaction(c.in, levelOn(c.in.accountId, levels), userId),
    [levels, userId],
  )

  useEffect(() => {
    if (mode === null || mode === 'manual') return
    let cancelled = false
    void (async () => {
      const found = (await detectTransfers()).filter(
        (c) => !handled.current.has(c.out.id) && !handled.current.has(c.in.id) && canEditBoth(c),
      )
      if (cancelled) return

      if (mode === 'auto') {
        const clear = found.filter((c) => c.unambiguous)
        if (clear.length > 0) {
          for (const c of clear) {
            handled.current.add(c.out.id)
            handled.current.add(c.in.id)
          }
          const { linked } = await autoLinkTransfers(clear)
          if (cancelled) return
          setAutoLinked((n) => n + linked)
          await syncNow()
        }
        // What is left is genuinely ambiguous, and still needs a person.
        setCandidates(found.filter((c) => !c.unambiguous))
        return
      }
      setCandidates(found)
    })()
    return () => {
      cancelled = true
    }
    // `levels` and `canEditBoth` are fresh each render; the inputs that change
    // the answer are the mode and the transactions themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, txns])

  async function link(c: TransferCandidate) {
    setBusy(c.out.id)
    handled.current.add(c.out.id)
    handled.current.add(c.in.id)
    setCandidates((list) => list.filter((x) => x.out.id !== c.out.id || x.in.id !== c.in.id))
    try {
      await linkTransfer(c.out.id, c.in.id)
    } finally {
      setBusy(null)
      await syncNow()
    }
  }

  async function dismiss(c: TransferCandidate) {
    setCandidates((list) => list.filter((x) => x.out.id !== c.out.id || x.in.id !== c.in.id))
    await dismissTransfer(c)
  }

  if (autoLinked > 0 && candidates.length === 0) {
    return (
      <Card className="mb-3 flex items-center gap-2 px-4 py-2.5 text-sm md:mb-2.5 md:px-3 md:py-2">
        <ArrowLeftRight size={16} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          {autoLinked} {autoLinked === 1 ? 'transfer' : 'transfers'} between your accounts linked — both
          sides are out of your spending and income totals.
        </span>
        <button onClick={() => setAutoLinked(0)} className="shrink-0 text-ink-3 hover:text-ink">
          Dismiss
        </button>
      </Card>
    )
  }

  if (candidates.length === 0) return null

  return (
    <Card className="mb-3 overflow-hidden md:mb-2.5">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-accent/8 px-4 py-2.5 md:px-3 md:py-2">
        <ArrowLeftRight size={16} className="shrink-0 text-accent" />
        <p className="min-w-0 flex-1 text-sm">
          <span className="font-medium">
            {candidates.length === 1
              ? 'This might be money you moved between your accounts'
              : `${candidates.length} of these might be money you moved between your accounts`}
          </span>
          <span className="text-ink-3">
            {' '}— if so, neither side is spending or income, and both leave your totals.
          </span>
        </p>
      </div>
      <ul className="divide-y divide-hairline">
        {candidates.map((c) => (
          <li key={`${c.out.id}>${c.in.id}`} className="px-4 py-3 md:px-3 desktop:py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
                <Leg txn={c.out} name={accMap.get(c.out.accountId)?.name} />
                <ArrowRight size={15} className="shrink-0 text-ink-3" />
                <Leg txn={c.in} name={accMap.get(c.in.accountId)?.name} />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!c.unambiguous && (
                  <Chip tone="warn">
                    <HelpCircle size={11} className="mr-1" /> more than one match
                  </Chip>
                )}
                {c.namedTransfer && <Chip tone="accent">named a transfer</Chip>}
                <span className="text-sm font-semibold tabular">{money(Math.abs(c.out.amountMinor))}</span>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="subtle" disabled={busy !== null} onClick={() => void link(c)}>
                  Yes, one transfer
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void dismiss(c)}>
                  No
                </Button>
              </div>
            </div>
            {c.daysApart > 0 && (
              <p className="mt-1 text-xs text-ink-3">
                {c.daysApart} day{c.daysApart === 1 ? '' : 's'} apart
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Leg({ txn, name }: { txn: Transaction; name?: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{name ?? 'Unknown account'}</span>
      <span className={cx('block truncate text-xs text-ink-3')}>
        {txn.payee} · {fmtDay(txn.date)}
      </span>
    </span>
  )
}

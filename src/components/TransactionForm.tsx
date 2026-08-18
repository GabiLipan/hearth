import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { ScanLine, ArrowLeftRight, CalendarClock, HelpCircle, PiggyBank } from 'lucide-react'
import { db, type Transaction } from '../lib/db'
import { useAccounts, useAccountMap, useBills, useBooks, useCategories, useGoals, useMyLevels, useGrantsFor, useMemberMap } from '../lib/cache'
import { findTransferCandidates, linkTransfer, setTransferGoal, unlinkTransfer } from '../lib/transfers'
import { unlinkBillPayment } from '../lib/bills'
import { clearExplanation, isAsking, looksLikeTransfer, requestExplanation } from '../lib/unexplained'
import { accountsInBook } from '../lib/books'
import { syncNow } from '../lib/session'
import { scanReceipt } from '../lib/receipt'
import { canAddTransactions, canEditTransaction, canManageAccount, levelOn } from '../lib/accounts'
import { grouped, usableOn } from '../lib/categories'
import { useSyncState } from '../hooks/useSync'
import { parseAmount, currencySymbol } from '../lib/money'
import { dateWindow, todayISO } from '../lib/dates'
import {
  learnRule,
  suggestCategory,
  suggestTitle,
  prettyPayee,
  displayName,
  similarTo,
  applyCategory,
  applyTitle,
  unnamedLike,
  cleanTitle,
  TITLE_MAX,
} from '../lib/rules'
import { applyContributor, learnContributors, similarArrivals, suggestContributor } from '../lib/contributors'
import { findLikelyDuplicate } from '../lib/dedupe'
import { fmtFullDate } from '../lib/dates'
import { create, update, remove } from '../lib/data'
import { useApp } from '../state/AppContext'
import { Sheet, Field, TextInput, Select, Segmented, Button, CheckRow } from './ui'
import { confirmAction } from './confirm'
import { toast } from './toast'
import { CategoryPicker } from './CategoryPicker'
import { nameOf } from './PersonDot'

/**
 * How far the duplicate check and the transfer matcher ever look from a row.
 *
 * Named here because they are now the width of a Dexie query as well as a
 * filter inside the matcher, and the two must not drift: a window narrower than
 * the rule would silently stop finding pairs the rule still accepts.
 * `findLikelyDuplicate` discards gaps over 3 days; `findTransferCandidates` is
 * being asked for 10 explicitly.
 */
const DUPLICATE_DAYS = 3
const PAIR_DAYS = 10

/** A value that stops changing before anything expensive is done with it. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

export function TransactionForm({
  open,
  onClose,
  editing,
}: {
  open: boolean
  onClose: () => void
  editing?: Transaction
}) {
  const { currency, money } = useApp()
  const { userId } = useSyncState()
  const categories = useCategories()
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const memberMap = useMemberMap()
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  const payees = useLiveQuery(async () => {
    const txns = await db.transactions.orderBy('date').reverse().limit(400).toArray()
    return [...new Set(txns.map((t) => prettyPayee(t.payee)))].slice(0, 60)
  }, []) ?? []

  const [kind, setKind] = useState<'expense' | 'income'>('expense')
  const [amount, setAmount] = useState('')
  const [payee, setPayee] = useState('')
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState<string | undefined>()
  const [date, setDate] = useState(todayISO())
  const [accountId, setAccountId] = useState<string | undefined>()
  const [note, setNote] = useState('')
  const [forHousehold, setForHousehold] = useState(false)
  const [contributorId, setContributorId] = useState<string | undefined>()
  /** Whether the contributor on screen was proposed rather than chosen. */
  const [contributorGuessed, setContributorGuessed] = useState(false)
  const [tagSimilar, setTagSimilar] = useState(false)
  const [suggested, setSuggested] = useState(false)
  /** Whether the name on screen was proposed rather than typed. */
  const [titleSuggested, setTitleSuggested] = useState(false)
  const [applySimilar, setApplySimilar] = useState(false)
  const [renameSimilar, setRenameSimilar] = useState(false)
  const [scanState, setScanState] = useState<string | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const receiptRef = useRef<HTMLInputElement>(null)

  async function onReceiptPhoto(file: File) {
    setScanState('Reading receipt…')
    try {
      const guess = await scanReceipt(file, (pct) => setScanState(`Reading receipt… ${pct}%`), payees)
      if (guess.amountMinor) setAmount((guess.amountMinor / 100).toFixed(2))
      if (guess.payee) setPayee(guess.payee)
      if (guess.date) setDate(guess.date)
      setScanState(guess.amountMinor || guess.payee ? null : 'Could not read that photo — try a clearer shot.')
    } catch {
      setScanState('Scanning needs an internet connection the first time — try again online.')
    }
  }

  useEffect(() => {
    if (!open) return
    if (editing) {
      setKind(editing.amountMinor < 0 ? 'expense' : 'income')
      setAmount((Math.abs(editing.amountMinor) / 100).toFixed(2).replace(/\.00$/, ''))
      setPayee(editing.payee)
      setTitle(editing.title ?? '')
      setCategoryId(editing.categoryId)
      setDate(editing.date)
      setAccountId(editing.accountId)
      setNote(editing.note ?? '')
      setForHousehold(!!editing.paidForHousehold)
      setContributorId(editing.contributorId)
    } else {
      setKind('expense')
      setAmount('')
      setPayee('')
      setTitle('')
      setCategoryId(undefined)
      setDate(todayISO())
      setAccountId(accounts[0]?.id)
      setNote('')
      setForHousehold(false)
      setContributorId(undefined)
      setTimeout(() => amountRef.current?.focus(), 60)
    }
    setSuggested(false)
    setTitleSuggested(false)
    setApplySimilar(false)
    setRenameSimilar(false)
    setContributorGuessed(false)
    setTagSimilar(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  // Auto-suggest a category as soon as we recognise the payee
  useEffect(() => {
    if (!open || editing || payee.trim().length < 3) return
    let cancelled = false
    const t = setTimeout(async () => {
      const id = await suggestCategory(payee)
      if (!cancelled && id && (categoryId === undefined || suggested)) {
        setCategoryId(id)
        setSuggested(true)
      }
      // The same offer for the name, and under the same rule: a suggestion may
      // fill an empty field or replace one it filled itself, and must never
      // overwrite something typed by hand.
      const name = await suggestTitle(payee)
      if (!cancelled && name && (title.trim() === '' || titleSuggested)) {
        setTitle(name)
        setTitleSuggested(true)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payee, open])

  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  /**
   * Whether this row is mine to change.
   *
   * At `contribute` you may edit what you added and nothing else, which is the
   * `transactions_update` policy exactly. The row stays open rather than being
   * hidden: hiding it would contradict the policy, which does let you READ it,
   * and a row that cannot be tapped reads as a bug rather than as a rule.
   */
  const editable = !editing || canEditTransaction(editing, levelOn(editing.accountId, levels), userId)
  const author = editing && !editable ? memberMap.get(editing.createdBy ?? '')?.displayName : undefined

  /**
   * What can be chosen here: the right kind, and — for a personal category —
   * only when recording against your own non-shared account, which is the rule
   * the database enforces. Offering one the server would reject would just be a
   * confusing failure at save time.
   */
  const accountGrants = useGrantsFor(accountId)
  const visibleGroups = useMemo(
    () =>
      grouped(
        usableOn(categories, accountGrants, userId)
          .filter((c) => c.kind === kind)
          /**
           * A personal category cannot be offered on a row the household is
           * about to be able to read.
           *
           * `categories_select` keeps a category with an `owner_id` to its
           * owner, and publishing a transaction does not publish anything it
           * points at — so the row would arrive on the other device filed under
           * a category that device cannot resolve, and render as
           * "Uncategorised". The household's grocery figure would then be short
           * by exactly the thing this feature exists to add to it, with nothing
           * on either screen to explain the difference.
           *
           * The database will not stop this: `personal_category_guard` asks
           * whether anybody else is GRANTED on the account, and publishing
           * grants nobody anything. So it is a rule the form keeps.
           */
          .filter((c) => !(forHousehold && c.ownerId)),
      ),
    [categories, accountGrants, userId, kind, forHousehold],
  )

  // If the account changes to one where the chosen category is not allowed —
  // or the row becomes the household's, which rules out a private category —
  // clear it rather than letting the save fail.
  useEffect(() => {
    if (!categoryId) return
    const stillAllowed = visibleGroups.some(
      (g) => g.parent.id === categoryId || g.children.some((c) => c.id === categoryId),
    )
    if (!stillAllowed) setCategoryId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, forHousehold])
  /**
   * Other transactions from this payee that are filed somewhere else.
   *
   * Offered here, in the form, rather than as a "we noticed…" prompt after
   * saving. Categorising one pet insurance payment and being told about the
   * other eleven is useful; being told after the sheet has already closed, in a
   * second dialog, is an interruption — and the answer is much easier to give
   * while the category you just chose is still on screen.
   *
   * Filtered to what this device may actually change, so the number offered is
   * the number that will move. At `contribute` you may only edit what you
   * added, and a bulk update is the easiest possible way to queue a dozen
   * writes that dead-letter quietly a minute later.
   */
  /**
   * The payee, once it has stopped changing.
   *
   * This one genuinely has to consider the whole history — "and the other
   * eleven" is a claim about everything ever recorded, and `payeeSimilar` is
   * fuzzy, so there is no index that could answer it. What it must not do is
   * run once per keystroke: keyed on `payee` it re-read every transaction on
   * every letter of "Sainsbury's". The category suggester above already waits
   * 250ms for the same reason.
   */
  const settledPayee = useDebounced(payee, 250)

  const similar =
    useLiveQuery(async () => {
      if (!open || !categoryId || kind !== 'expense' || settledPayee.trim().length < 3) return []
      const all = await db.transactions.toArray()
      return similarTo(settledPayee, categoryId, all, editing?.id).filter((t) =>
        canEditTransaction(t, levelOn(t.accountId, levels), userId),
      )
      // `levels` is a fresh Map each render, so it is deliberately not a
      // dependency — the query re-runs on the inputs that change the answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, settledPayee, categoryId, kind, editing?.id, userId]) ?? []

  /**
   * Other transactions from this payee that are not called this already.
   *
   * The name's half of "and the other nine", asked the same way and of the same
   * table — see `similar` above for why this has to consider all of history and
   * therefore waits for the typing to stop. Filtered to what this device may
   * actually change, so the number offered is the number that will move.
   */
  const settledTitle = useDebounced(title, 250)

  const unnamed =
    useLiveQuery(async () => {
      if (!open || !cleanTitle(settledTitle) || settledPayee.trim().length < 3) return []
      const all = await db.transactions.toArray()
      return unnamedLike(settledPayee, settledTitle, all, editing?.id).filter((t) =>
        canEditTransaction(t, levelOn(t.accountId, levels), userId),
      )
      // `levels` is a fresh Map each render, so it is deliberately not a
      // dependency — the query re-runs on the inputs that change the answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, settledPayee, settledTitle, editing?.id, userId]) ?? []

  /**
   * Whether "I paid for this, but it was the household's" is even a question.
   *
   * Only for money going OUT of an account that is not already the household's:
   * a refund is not a contribution, and money leaving a joint account is
   * already the household's to spend.
   */
  const books = useBooks()
  const offerHousehold = kind === 'expense' && !!accountId && !books.household.has(accountId)

  /**
   * Whether the household can actually SEE what this box promises.
   *
   * Ticking it has always made the row household spending in the payer's books
   * and a contribution out of them. What it could not do until migration 19 is
   * make that true on the other person's screen: the row lives in an account
   * they have no grant on, and `transactions_select` authorises by account.
   *
   * `publishesHouseholdRows` is the consent that closes it, and it is asked
   * once per ACCOUNT rather than once per row — "is this an account I am
   * willing to pay household things from" is a question with a considered
   * answer, where "may she see this £90" asked every week is a reflex.
   */
  const account = useMemo(() => allAccounts.find((a) => a.id === accountId), [allAccounts, accountId])
  const publishes = !!account?.publishesHouseholdRows
  /** Consent is a change to the account, so it needs `manage` on it, like a rename. */
  const mayPublish = canManageAccount(levelOn(accountId ?? '', levels))
  /** In a household of one there is nobody to publish to, and nothing to ask about. */
  const someoneToTell = memberMap.size > 1

  /**
   * Ticking the box, which the first time on an account is also a consent.
   *
   * Asked at the tick rather than at save: the dialog is the explanation, and an
   * explanation that arrives after you have pressed Save is an interruption
   * rather than a choice. Declining leaves the box unticked, so the cause and
   * the effect stay next to each other.
   *
   * Un-ticking is never a question. It is the account-level switch in Settings
   * that carries the warning, because that is the one that hides rows somebody
   * may already be looking at.
   */
  async function toggleForHousehold(next: boolean) {
    if (!next || publishes || !mayPublish || !someoneToTell || !account) {
      setForHousehold(next)
      return
    }
    const ok = await confirmAction({
      title: `Let the household see what you pay for from “${account.name}”?`,
      body: [
        `Anything on “${account.name}” you mark like this becomes readable by everyone in your household — the payee, the amount, the date, the category and the note.`,
        'Nothing else on the account is: not its balance, not its name, and not a single row you have not marked.',
        'You can stop publishing later in Settings, but you cannot un-send a row that has already reached their device.',
      ],
      confirmLabel: 'Share these rows',
      cancelLabel: 'Keep it to myself',
    })
    if (!ok) return
    await update('accounts', account.id, { publishesHouseholdRows: true })
    setForHousehold(true)
  }

  /**
   * Whether "who paid this in?" is even a question — the mirror image of the
   * one above, and gated on the opposite side of the same test.
   *
   * Money IN to an account that IS the household's, and not already half of a
   * transfer. A transfer answers the question properly, with two real rows, and
   * this must never look like a way to overrule one: `classifyFlows` reads the
   * tag only where there is no `transferId`, so offering it here would be
   * offering a control that does nothing.
   *
   * There also has to be somebody other than you to name. In a household of one
   * the whole feature is meaningless, and an empty picker is worse than none.
   */
  const members = useMemo(() => [...memberMap.values()], [memberMap])
  const offerContributor =
    kind === 'income' &&
    !!accountId &&
    books.household.has(accountId) &&
    !editing?.transferId &&
    members.length > 1

  /**
   * What the rows already tagged say about who pays in under this name.
   *
   * Read from the whole history, like `similar` above and for the same reason —
   * "this payee has been hers before" is a claim about everything ever recorded
   * — and gated on the offer, so an expense form never touches the table.
   */
  const learnedContributors =
    useLiveQuery(async () => {
      if (!open || !offerContributor) return new Map<string, string>()
      return learnContributors(await db.transactions.toArray(), books)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, offerContributor, books]) ?? new Map<string, string>()

  /**
   * Propose the person this payee has been before.
   *
   * The same shape as the category suggester: it fills an empty field, and it
   * will replace its OWN previous answer as you keep typing, but it never
   * overwrites a person you chose yourself. Declining is doing nothing, which is
   * the whole posture — accepting moves money between months as well as onto a
   * name.
   */
  useEffect(() => {
    if (!open || !offerContributor || settledPayee.trim().length < 3) return
    if (contributorId !== undefined && !contributorGuessed) return
    const guess = suggestContributor(settledPayee, learnedContributors)
    if (guess && guess !== contributorId) {
      setContributorId(guess)
      setContributorGuessed(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPayee, open, offerContributor, learnedContributors])

  /** Other arrivals from this payee that are not tagged to the same person. */
  const similarArrivalRows =
    useLiveQuery(async () => {
      if (!open || !offerContributor || !contributorId || settledPayee.trim().length < 3) return []
      const all = await db.transactions.toArray()
      return similarArrivals(settledPayee, contributorId, all, books, editing?.id).filter((t) =>
        canEditTransaction(t, levelOn(t.accountId, levels), userId),
      )
      // `levels` is a fresh Map each render, so it is deliberately not a
      // dependency — the query re-runs on the inputs that change the answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, offerContributor, contributorId, settledPayee, editing?.id, userId, books]) ?? []

  /**
   * How wide the amount field is, and how big its number.
   *
   * Grows first, then shrinks the type once growing would push it past the
   * sheet. `ch` is exact here rather than approximate: the field is `tabular`,
   * so every digit is the width of a zero. The separator and the point are
   * narrower, which only ever leaves a little slack.
   *
   * The steps are deliberately coarse. A size that changed on every keystroke
   * would wobble while you type, and the point is to stop the number being cut
   * off, not to fill the width exactly.
   */
  const amountSize = useMemo(() => {
    const len = Math.max(amount.length, 1)
    const rem = len <= 7 ? 3 : len <= 9 ? 2.5 : len <= 11 ? 2 : 1.625
    return { fontSize: `${rem}rem`, width: `${Math.max(4, len + 1)}ch` }
  }, [amount])

  const amountMinor = parseAmount(amount)
  const canSave = amountMinor !== null && amountMinor > 0 && payee.trim() && categoryId !== undefined && accountId !== undefined

  async function save() {
    if (!canSave) return
    const signed = kind === 'expense' ? -Math.abs(amountMinor!) : Math.abs(amountMinor!)
    if (!editing) {
      // Same amount, similar payee, within a few days — probably the same purchase.
      //
      // Asked of the `date` index rather than of every transaction ever
      // recorded: `findLikelyDuplicate` discards anything more than three days
      // out, so reading the whole table was fetching years of rows in order to
      // throw all but a handful away — on the save path, where it is between
      // the press and the sheet closing.
      const [from, to] = dateWindow(date, DUPLICATE_DAYS)
      const existing = await db.transactions.where('date').between(from, to, true, true).toArray()
      const dup = findLikelyDuplicate({ date, payee: payee.trim(), amountMinor: signed }, existing)
      if (
        dup &&
        !(await confirmAction({
          title: 'This looks like a duplicate',
          body: `There is already “${displayName(dup)}” for ${money(dup.amountMinor)} on ${fmtFullDate(dup.date)}.`,
          confirmLabel: 'Add anyway',
          cancelLabel: 'Don’t add',
        }))
      ) {
        return
      }
    }
    if (editing) {
      await update('transactions', editing.id, {
        amountMinor: signed,
        payee: payee.trim(),
        // Explicitly undefined rather than omitted: clearing the box takes the
        // name off the row and puts the bank's own words back (see mapping.ts).
        title: cleanTitle(title),
        categoryId,
        date,
        accountId: accountId!,
        // Explicitly undefined rather than omitted: that is what clears the note
        // rather than leaving the old one in place (see mapping.ts).
        note: note.trim() || undefined,
        paidForHousehold: forHousehold && offerHousehold,
        // Explicitly undefined rather than omitted, so clearing the person
        // actually clears it — and gated on the offer, so switching a row from
        // income to expense drops a tag that would no longer mean anything.
        contributorId: offerContributor ? contributorId : undefined,
      })
    } else {
      await create('transactions', {
        amountMinor: signed,
        payee: payee.trim(),
        title: cleanTitle(title),
        categoryId,
        date,
        accountId: accountId!,
        note: note.trim() || undefined,
        paidForHousehold: forHousehold && offerHousehold,
        // Explicitly undefined rather than omitted, so clearing the person
        // actually clears it — and gated on the offer, so switching a row from
        // income to expense drops a tag that would no longer mean anything.
        contributorId: offerContributor ? contributorId : undefined,
        createdBy: userId,
        createdAt: new Date().toISOString(),
      })
    }
    // The quiet automation: every save teaches the categoriser — and, since
    // migration 20, the namer. A name is learned on income too: categories are
    // only ever learned from spending, but "FPI SMITH J LTD" is precisely the
    // sort of thing that wants calling "Salary".
    const learntTitle = cleanTitle(title)
    if (kind !== 'expense' && learntTitle) await learnRule(payee, { title: learntTitle })
    if (kind === 'expense') {
      await learnRule(payee, { categoryId: categoryId!, title: learntTitle })
      // …and, if asked, applies what it just learned backwards. `similar` is
      // already filtered to what this device may change, so the predicate here
      // passes everything through.
      if (applySimilar && similar.length > 0) {
        // Captured BEFORE the writes: undoing means putting each row back where
        // it was, and half of them may have had no category at all.
        const before = similar.map((t) => ({ id: t.id, categoryId: t.categoryId }))
        const { updated } = await applyCategory(similar, categoryId!, () => true)
        if (updated > 0) {
          toast(`${updated} other ${updated === 1 ? 'transaction' : 'transactions'} moved here too`, {
            undo: async () => {
              // `undefined` is what clears a field rather than leaving it
              // alone, which is exactly right for a row that had no category
              // before. See mapping.ts.
              for (const row of before) await update('transactions', row.id, { categoryId: row.categoryId })
            },
          })
        }
      }
    }
    // …and the same offer for the name, asked separately because it is a
    // different set of rows: a name is worth having on income and on transfer
    // legs, which `similar` deliberately never touches.
    if (learntTitle && renameSimilar && unnamed.length > 0) {
      const before = unnamed.map((t) => ({ id: t.id, title: t.title }))
      const { updated } = await applyTitle(unnamed, learntTitle, () => true)
      if (updated > 0) {
        toast(`${updated} other ${updated === 1 ? 'transaction' : 'transactions'} renamed too`, {
          undo: async () => {
            // `undefined` clears rather than leaving alone, which is exactly
            // right for a row that had no name of its own before.
            for (const row of before) await update('transactions', row.id, { title: row.title })
          },
        })
      }
    }
    // The same offer on the other side: this arrival is hers, and so are the
    // three the importer brought in last spring. Nothing is learned explicitly —
    // `learnContributors` reads the tagged rows back — so tagging these IS the
    // teaching, and untagging them un-teaches it.
    if (offerContributor && contributorId && tagSimilar && similarArrivalRows.length > 0) {
      const before = similarArrivalRows.map((t) => ({ id: t.id, contributorId: t.contributorId }))
      const { updated } = await applyContributor(similarArrivalRows, contributorId, () => true)
      if (updated > 0) {
        const who = nameOf(memberMap.get(contributorId))
        toast(`${updated} other ${updated === 1 ? 'payment' : 'payments'} tagged as ${who}`, {
          undo: async () => {
            for (const row of before) await update('transactions', row.id, { contributorId: row.contributorId })
          },
        })
      }
    }
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit transaction' : 'Add transaction'}
      // Enter saves, from any field in the sheet.
      onSubmit={() => void save()}
      footer={
        !editable ? (
          <p className="text-sm text-ink-3">
            {author
              ? `Added by ${author}. Only ${author}, or someone who manages this account, can change it.`
              : 'Added by someone who has left the household. Only someone who manages this account can change it.'}
          </p>
        ) : (
        <div className="flex gap-2">
          {editing && (
            <Button
              variant="danger"
              size="lg"
              onClick={async () => {
                /* Still a confirmation rather than a delete-then-undo, and
                   deliberately. A delete here is `set deleted_at` on the
                   server, and nothing on the client may write that column back
                   — `deletedAt` is readable but not writable (see mapping.ts) —
                   so an "Undo" could only re-insert, which `on conflict do
                   nothing` would quietly discard against the tombstone that is
                   already there. An undo that silently does nothing is worse
                   than a question. */
                if (
                  await confirmAction({
                    title: 'Delete this transaction?',
                    body: `“${payee.trim() || editing.payee}” will disappear from your reports and budgets too.`,
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  })
                ) {
                  await remove('transactions', editing.id)
                  toast('Transaction deleted')
                  onClose()
                }
              }}
            >
              Delete
            </Button>
          )}
          {/* No `onClick`: the sheet's `onSubmit` is what saves, and a handler
              here as well would run it twice per press. */}
          <Button type="submit" size="lg" className="flex-1" disabled={!canSave}>
            {editing ? 'Save changes' : 'Add transaction'}
          </Button>
        </div>
        )
      }
    >
      <fieldset disabled={!editable} className="space-y-4 disabled:opacity-60">
        <Segmented
          value={kind}
          onChange={(k) => {
            setKind(k)
            setCategoryId(undefined)
          }}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
          ]}
        />

        {/* The field is sized to the number, not to a guess about it. A fixed
            width clipped anything past six figures, which is not an unusual
            amount to type — a house deposit, a car, a year of rent. */}
        <div className="flex items-center justify-center gap-1 py-2">
          <span
            className="font-semibold text-ink-3 transition-[font-size] duration-150"
            style={{ fontSize: `calc(${amountSize.fontSize} * 0.62)` }}
          >
            {currencySymbol(currency)}
          </span>
          <input
            ref={amountRef}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            aria-label="Amount"
            style={amountSize}
            className="min-w-0 max-w-full bg-transparent text-center font-bold tracking-tight outline-none transition-[font-size,width] duration-150 placeholder:text-ink-3/40 tabular"
          />
        </div>

        {kind === 'expense' && !editing && (
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => receiptRef.current?.click()}
              disabled={scanState?.startsWith('Reading')}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-ink-2 transition hover:text-ink disabled:opacity-60"
            >
              <ScanLine size={15} /> {scanState?.startsWith('Reading') ? scanState : 'Scan a receipt'}
            </button>
            {scanState && !scanState.startsWith('Reading') && <p className="text-xs text-ink-3">{scanState}</p>}
            <input
              ref={receiptRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void onReceiptPhoto(f)
              }}
            />
          </div>
        )}

        <Field label={kind === 'expense' ? 'Where did you spend?' : 'Where from?'}>
          <TextInput
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder={kind === 'expense' ? 'e.g. Tesco' : 'e.g. Salary'}
            list="payee-suggestions"
            autoComplete="off"
          />
          <datalist id="payee-suggestions">
            {payees.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>

        {/* What this is CALLED, as opposed to what the bank called it. The
            payee above stays exactly as imported — it is what every rule,
            duplicate check and transfer pairing in the app compares — and this
            is what Activity, the widgets and the reports show. Learned back
            through the same rules that learn a category, so the next
            "SQ *THE GOOD FORK 3241" arrives already called "Dinner out". */}
        <Field
          label="Call it"
          hint={
            titleSuggested
              ? 'Remembered from the last one from here — change it and Hearth will learn the new name.'
              : 'Optional. Leave it blank to show whatever the bank wrote.'
          }
        >
          <TextInput
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleSuggested(false)
            }}
            placeholder={payee.trim() ? prettyPayee(payee) : 'e.g. Dinner out'}
            autoComplete="off"
          />
        </Field>

        {unnamed.length > 0 && (
          <CheckRow
            tone="accent"
            checked={renameSimilar}
            onChange={setRenameSimilar}
            label={`Rename ${unnamed.length} other ${unnamed.length === 1 ? 'transaction' : 'transactions'} too`}
            info={
              <p>
                {unnamed.length === 1 ? 'One is' : `${unnamed.length} are`} from &ldquo;{prettyPayee(payee)}&rdquo;
                and still show what the bank wrote. Their payees are left exactly as they are.
              </p>
            }
          />
        )}

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">
            Category
            {suggested && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">auto-suggested</span>}
          </span>
          {/* Parents only, with subcategories one tap behind the tile they
              belong to. See CategoryPicker for why. */}
          <CategoryPicker
            groups={visibleGroups}
            byId={catMap}
            value={categoryId}
            onChange={(id) => {
              setCategoryId(id)
              setSuggested(false)
            }}
          />
        </div>

        {similar.length > 0 && (
          <CheckRow
            tone="accent"
            checked={applySimilar}
            onChange={setApplySimilar}
            label={`Move ${similar.length} other ${similar.length === 1 ? 'transaction' : 'transactions'} here too`}
            info={
              <p>
                {similar.length === 1 ? 'One is' : `${similar.length} are`} from “{prettyPayee(payee)}” and filed
                somewhere else. There is more in{' '}
                <Link to="/settings/rules" className="underline underline-offset-2">
                  Settings › Rules
                </Link>
                .
              </p>
            }
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <TextInput type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Account">
            <Select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || undefined)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* Only where it can mean anything: an expense, from an account that is
            not already the household's. Money already in a joint account is the
            household's, so there is nothing to move. */}
        {offerHousehold && (
          <CheckRow
            checked={forHousehold}
            onChange={(next) => void toggleForHousehold(next)}
            label={<>I paid for this, but it was the household&rsquo;s</>}
            /* What the arithmetic cannot say by itself: whether the other
               person can see any of it. Three states, genuinely different —
               this used to be silently the middle one for everybody, which is
               the hole migration 19 closes. It stays on the face of the row
               rather than going behind the ⓘ, because it is the one part that
               is not the same answer every time. */
            status={
              someoneToTell &&
              (publishes
                ? 'Your household can read the rows you mark here'
                : mayPublish
                  ? 'Ticking this asks to share these rows with your household'
                  : 'Counts on your screen only')
            }
            info={
              <>
                <p>
                  Counted as household spending, and as money you put in — the same as moving it to the joint
                  account and spending it from there.
                </p>
                {someoneToTell &&
                  (publishes ? (
                    <p>
                      Everyone in your household can read the rows you mark here — and nothing else on
                      &ldquo;{account?.name}&rdquo;. Nobody can un-read one afterwards.
                    </p>
                  ) : mayPublish ? (
                    <p>
                      Ticking this asks whether the household may read the rows you mark on this account. The
                      balance, the account&rsquo;s name and every row you have not marked stay yours alone.
                    </p>
                  ) : (
                    <p>
                      It counts on your screen only: this account does not publish its household rows, and only
                      someone who can manage it can change that.
                    </p>
                  ))}
                {forHousehold && (
                  <p>
                    Your own private categories are not offered for a household row — nobody else could read
                    one, so the spending would arrive on their screen uncategorised.
                  </p>
                )}
              </>
            }
          />
        )}

        {/* The other half of the same idea: money arriving in a joint account
            that one of us moved there. A transfer says this properly, with two
            real rows — this is for the person who is not using the app, whose
            far leg does not exist and never will. */}
        {offerContributor && (
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <Field
              label="Paid in by"
              /* The guess is state — it is about THIS row and changes with the
                 payee — so it stays visible. What the setting means does not. */
              hint={contributorGuessed ? 'Suggested from this payee — change it if that is wrong' : undefined}
              info={
                <p>
                  Counts as money put into the household rather than income from outside it. Anything paid in
                  from the 25th counts towards the following month.
                </p>
              }
            >
              <Select
                value={contributorId ?? ''}
                onChange={(e) => {
                  setContributorId(e.target.value || undefined)
                  setContributorGuessed(false)
                }}
              >
                <option value="">Not sure — count it as other income</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.userId === userId ? `${nameOf(m)} (you)` : nameOf(m)}
                  </option>
                ))}
              </Select>
            </Field>
            {contributorId && similarArrivalRows.length > 0 && (
              <div className="mt-2.5">
                <CheckRow
                  tone="bare"
                  checked={tagSimilar}
                  onChange={setTagSimilar}
                  label={`Tag the other ${similarArrivalRows.length} ${similarArrivalRows.length === 1 ? 'payment' : 'payments'} from this payee too`}
                />
              </div>
            )}
          </div>
        )}

        <Field label="Note (optional)">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to remember" />
        </Field>

        {editing && editable && <Linkage txn={editing} onDone={onClose} />}
      </fieldset>
    </Sheet>
  )
}

/**
 * Which goal this transfer was paying into.
 *
 * The one place a *reconciled* transfer can be pointed at a pot. Money moved
 * from inside Hearth has always been able to name a goal, because
 * `create_transfer` takes one; money that arrived in a CSV and was paired
 * afterwards — which is nearly all of it, since the reviewer pairs cross-book
 * transfers on its own — had no way to say so at all.
 *
 * The value is held locally as well as read from the row: the tag is written by
 * an RPC, so the cached transaction keeps its old `goalId` until the next pull
 * lands, and without this the control would snap back a moment after being
 * used.
 */
function GoalTag({ txn }: { txn: Transaction }) {
  const goals = useGoals()
  const [chosen, setChosen] = useState<string>(txn.goalId ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  if (goals.length === 0) return null

  async function choose(next: string) {
    const was = chosen
    setChosen(next)
    setBusy(true)
    setFailed(false)
    try {
      await setTransferGoal(txn.transferId!, next || null)
      await syncNow()
    } catch {
      setChosen(was)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-2.5">
      <PiggyBank size={16} className="shrink-0 text-ink-3" />
      <span className="text-sm text-ink-2">Paying into</span>
      {/* `Select` carries `w-full`, so the width has to go on a wrapper — a
          class passed to it loses to the base class whatever the order. */}
      <div className="min-w-0 flex-1 basis-40">
        <Select value={chosen} disabled={busy} onChange={(e) => void choose(e.target.value)}>
          <option value="">No goal</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </div>
      {failed && <p className="basis-full text-xs text-critical-text">That didn’t save — you need a connection for this.</p>}
    </div>
  )
}

/**
 * What else this transaction is part of, and how to change your mind.
 *
 * Three states, and only ever one of them at a time — the server refuses to let
 * a row be both a bill payment and a transfer:
 *
 *   - recorded against a bill  → release it, freeing that occurrence
 *   - one leg of a transfer    → split it back into two ordinary transactions,
 *                                each getting back the category linking took
 *                                off it (migration 12)
 *   - neither                  → pair it with its other half by hand
 *
 * The manual pairing is what makes "Never" a usable answer to the transfer
 * setting rather than just switching the feature off. It searches a wider date
 * window than the automatic detector and ignores dismissals: you have asked, so
 * the app should stop being cautious on your behalf.
 */
/**
 * Asking the person who can see the other half.
 *
 * Offered only on a household row that reads like a movement of money and has
 * nothing to pair with here. That combination is precisely the blind spot: the
 * far leg is in an account this device is not on, so no amount of looking will
 * find it, and only the person who holds that account can say what it was.
 *
 * Not offered on a personal row, because I can see all of my own accounts — an
 * unpaired movement there is a pairing job, not an unanswerable question, and
 * the picker above already offers it.
 */
function Explain({ txn, onDone }: { txn: Transaction; onDone: () => void }) {
  const books = useBooks()
  const members = useMemberMap()
  const { userId } = useSyncState()
  const [busy, setBusy] = useState(false)

  const asking = isAsking(txn)
  const inHousehold = accountsInBook('household', books).has(txn.accountId)
  if (!asking && (!inHousehold || !looksLikeTransfer(txn))) return null

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
      await syncNow()
      onDone()
    }
  }

  if (asking) {
    const mine = txn.explainRequestedBy === userId
    const who = txn.explainRequestedBy ? nameOf(members.get(txn.explainRequestedBy)) : 'Somebody'
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warning/15 px-4 py-3">
        <HelpCircle size={16} className="shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-sm">
          {mine
            ? 'You have asked about this one. It will stay marked until it is paired or the question is withdrawn.'
            : `${who} asked what this was. If the other side is in one of your accounts, pair it above.`}
        </p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => clearExplanation(txn.id))}>
          {mine ? 'Never mind' : 'It is not a transfer'}
        </Button>
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void run(() => requestExplanation(txn.id))}
      className="flex w-full items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left text-sm text-ink-2 transition hover:text-ink disabled:opacity-60"
    >
      <HelpCircle size={16} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        Ask about this — the other side may be in an account only they can see
      </span>
    </button>
  )
}

function Linkage({ txn, onDone }: { txn: Transaction; onDone: () => void }) {
  const { money } = useApp()
  const { userId } = useSyncState()
  const levels = useMyLevels()
  const accMap = useAccountMap()
  const bills = useBills()
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)

  const partners =
    useLiveQuery(async () => {
      if (!picking) return []
      /* Only pairs involving THIS row are wanted, and a partner more than
         `PAIR_DAYS` away is not a candidate at all — so the window is exactly
         sufficient rather than an approximation. It does narrow what
         `findTransferCandidates` can see of the ambiguity around a pair, which
         is safe here and only here: this picker offers the readings and lets
         you choose, where auto-linking (TransferReview) must weigh them and so
         still works from the full set. */
      const [from, to] = dateWindow(txn.date, PAIR_DAYS)
      const near = await db.transactions.where('date').between(from, to, true, true).toArray()
      return findTransferCandidates(near, { maxDaysApart: PAIR_DAYS })
        .filter((c) => c.out.id === txn.id || c.in.id === txn.id)
        .filter(
          (c) =>
            canEditTransaction(c.out, levelOn(c.out.accountId, levels), userId) &&
            canEditTransaction(c.in, levelOn(c.in.accountId, levels), userId),
        )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [picking, txn.id, userId]) ?? []

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
      await syncNow()
      onDone()
    }
  }

  if (txn.billId) {
    const bill = bills.find((b) => b.id === txn.billId)
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-4 py-3">
        <CalendarClock size={16} className="shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-sm">
          Recorded as a payment of <span className="font-medium">{bill?.name ?? 'a bill'}</span>.
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run(() => unlinkBillPayment(txn.id))}
        >
          Not that bill
        </Button>
      </div>
    )
  }

  if (txn.transferId) {
    return (
      <div className="space-y-2.5 rounded-xl bg-surface-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <ArrowLeftRight size={16} className="shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1 text-sm">
            One side of a transfer between your accounts, so it counts as neither spending nor income.
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => unlinkTransfer(txn.transferId!))}
          >
            Not a transfer
          </Button>
        </div>
        {/* Only on the arriving leg. A goal is money that landed somewhere, the
            tag lives on the incoming side, and the server refuses a transfer
            with no incoming leg it can see — so offering this on the outgoing
            half would be offering a control that always fails. */}
        {txn.amountMinor > 0 && <GoalTag txn={txn} />}
      </div>
    )
  }

  if (!picking) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="flex w-full items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left text-sm text-ink-2 transition hover:text-ink"
        >
          <ArrowLeftRight size={16} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1">This was a transfer between my accounts</span>
        </button>
        <Explain txn={txn} onDone={onDone} />
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-xl bg-surface-2 px-4 py-3">
      <p className="text-sm text-ink-2">
        {partners.length === 0
          ? 'No matching payment found in another account. The other side has to be the exact same amount, within ten days, and not already spoken for.'
          : 'Pick the other side. Both will drop out of your spending and income totals.'}
      </p>
      {partners.map((c) => {
        const other = c.out.id === txn.id ? c.in : c.out
        return (
          <button
            key={other.id}
            type="button"
            disabled={busy}
            onClick={() => void run(() => linkTransfer(c.out.id, c.in.id))}
            className="flex w-full items-center gap-2.5 rounded-lg bg-surface px-3 py-2 text-left ring-1 ring-hairline transition hover:ring-accent/50 disabled:opacity-60"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {accMap.get(other.accountId)?.name ?? 'Unknown account'}
              </span>
              <span className="block truncate text-xs text-ink-3">
                {other.payee} · {fmtFullDate(other.date)}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold tabular">{money(other.amountMinor, { sign: true })}</span>
          </button>
        )
      })}
      <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
        Cancel
      </Button>
    </div>
  )
}

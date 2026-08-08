# Hearth — book accounting, reporting and visuals

The plan for reshaping Hearth around how we actually move money: salaries land in
private accounts, most of each salary moves to the joint account, the household
spends from there, and some personal spending stays behind.

**How to read this.** Everything still to do is at the top, grouped by what it is
rather than by when it was thought of; what has shipped is a one-line log at the
bottom. Anything marked **decision** is waiting on us, not on code. The
reasoning behind a shipped item lives in its commit message, not here — this
file is a plan, and a plan made mostly of finished work stops being read.

---

## The model, in short

Three sets of books, never summed together:

| Book | Accounts | Income is | Spending is |
|---|---|---|---|
| **Household** | joint current, joint savings | what we each put in, plus anything paid in from outside | what leaves a joint account on a purchase or bill |
| **Mine** | my private account, my cards | my salary | what I spend personally |
| **Hers** | hers | hers | hers — and invisible to me, by design |

A transfer **within** one book is nothing (joint current → joint savings). A
transfer **across** books is an outflow from one and income to the other
(my private → joint). Because the books are never added together, nothing is
double-counted.

Two consequences worth remembering:

- The household book is complete and **identical on both our screens**, without
  either of us seeing the other's salary — every joint transaction is visible to
  both of us.
- The household book is **right even before anything is linked**. Linking only
  matters for the personal book, and we can each do our own.

### Assumptions made (change these if wrong)

- [ ] **decision** — Joint savings is inside the household book. This is what makes
      "net" literally equal "saved". Alternative: its own book.
- [ ] **decision** — Credit cards follow the normal rule: a card only one of us
      holds is personal, a joint one is the household's. A personal card paid off
      from joint is then a household → personal flow, not household spending.

---

# Still to do

## Transfers, and what the app cannot see

The book model is right whenever a transfer is linked. Everything here is about
the gap before that happens, or where linking is not possible at all.

- [ ] Let the person who CAN see the far leg be told about it. `lib/unexplained.ts`
      names the blind spot on my screen; the other half is my device telling
      theirs "there is an arrival here waiting for you to link it", which needs
      somewhere shared to put the note
- [ ] **Recurring transfer routes** — learn "£2,000, my private → joint,
      monthly" the way a bill is learned
- [ ] **A household bill paid from a personal card** — a per-transaction "this
      was household spending, I just paid for it" flag
- [ ] **Reimbursements between us**
- [ ] **Explicit per-account book override**, for when derivation from grants is
      wrong. Needs a migration

## Reporting and visuals

### Sharpening what is there

- [ ] "Net each month" only claims to be saving where that is actually true
- [ ] Same month last year, where there is a year of history
- [ ] **Custom date range**, not just whole months. Left alone deliberately for
      now: unlike the year view, an arbitrary start and end cannot reuse the
      month-keyed aggregates — `bookTotals`, `bookSpendByCategory` and every
      function in `insights.ts` would have to take a range, and the
      contribution cut-off (`effectiveMonth`) has no meaning inside a period
      that does not align to a month. That is a bigger change than the rest of
      this section put together and wants its own pass

## Everyday screens


- [ ] Activity's search runs inside the book, so a payee in the other book
      returns nothing. The empty state says so, but a "search everything
      instead" escape from that state would beat making you find the switcher

## Safety nets

- [ ] **Deleting an account is not obviously undoable** — `delete_account` sets
      `deleted_at` and it vanishes for everybody, with no bin to recover from
- [ ] **Reclaim an ownerless account from Settings**, without the SQL editor.
      `dev-repair-accounts.sql` already does it by hand
- [ ] **Unlinking a transfer leaves both legs uncategorised**, and the old
      categories are not recoverable

## Recorded so it is not forgotten

- [ ] **Multi-currency** for Wise / Revolut. The app is single-currency today and
      any foreign amount is silently wrong. Out of scope for now

---

# Shipped

**The foundation.** `lib/books.ts` classifying accounts into household / mine /
someone else's, and every transaction into a flow; book-aware aggregates
(`bookTotals`, `bookSeries`); `useBook()` and the `BookSwitcher`, wired through
Home, Reports and Budgets; unit tests including the payday case and the
partner-leg-invisible case.

**Budgets, bills and goals per book.** Household budgets measure joint-account
spending, personal ones measure my private accounts — they used to filter on who
*recorded* a row, which got both cases wrong. Bills belong to the account they
leave, so the monthly total is what that book costs to run; under `Everything`
the list splits under headings. Goals take their book from their own `owner_id`.

**Migration 10** — a transfer that already exists can fund a goal.
`link_transfer` takes one, `set_transfer_goal` tags one afterwards (the case that
matters, since cross-book pairs link themselves), and `unlink_transfer` releases
it. `may_use_goal()` states the predicate once. Applied.

**Transfers.** Cross-book pairs auto-link even when row-ambiguous, in the one
direction that is safe. A cross-book pair reads as money into the household
rather than as a generic transfer.

**Reporting.** Drill into a category's subcategories from the donut or the table.
Click any slice through to Activity, filtered to that category, month and book.
Who contributed what, attributed from the far leg rather than from `created_by`.
The part-finished month says so everywhere — dimmed bars, a "so far" row, and the
book's balance at the 1st beside the figures. Both tables export as CSV.
`monthlySeries`' dead branch fixed, which had been counting every refund as
income.

**Activity and categorising.** The category picker shows parents only and opens
subcategories in a drawer under the row. Rows show both halves of the category.
Filter by one account, several or all. One continuous list, newest first, cut
into months, with a jump-to-month.

**Legs with no visible partner.** `lib/unexplained.ts` finds the rows in the
joint accounts that read as movements of money and that nothing has paired —
money out counted as household spending, money in counted as household income —
and Reports says so under the figures, with the row marked in Activity. It reads
the words the bank used and nothing else: no amount heuristic, and a category is
taken as the answer. Nothing is reclassified, because guessing here would make
the figures wrong in a way nobody could see.

**Seven report views** (`lib/insights.ts`, `components/insights.tsx`). Household
waterfall — paid in → spent → moved to savings → left in current, as one path
rather than three figures to subtract. What each salary turned into, where the
bar IS the salary. Committed vs chosen. Share kept, as a rate with a zero line.
Top payees, grouped by the app's own definition of "same merchant". Category by
month as a heatmap for spotting drift. And pace: spend-to-date against the same
point last month, the one comparison a part-finished month can honestly make.

**Month-on-month delta per category.** A "vs typical" column in the report
table, measured against the median of the months before it — the mean would let
one annual insurance payment become the norm — with months of no spending
dropped rather than counted as zero. Silent below three months of history, and
silent within a tenth of typical, because neither is news.

**A year at a time.** Reports switches between a month and a whole year, with
the aggregates taking a set of months rather than gaining a second code path.
The year stops at the month we are in rather than pretending the rest happened.

**Sticky month headings in Activity**, pinned under the mobile top bar — whose
height is measured into `--header-h` rather than guessed, since it varies with
the safe-area inset.

**Drilling into subcategories from Home**, the same breadcrumb Reports has.

**Restoring somebody else's backup** no longer produces a pile of dead letters.
Personal categories, budgets and goals owned by another person are left where
they are rather than claimed or published, budgets on a dropped category go with
it (the column is required), and a transaction keeps its money and loses only
its filing. The count of what was left alone is reported.

**CSV import remembers its columns**, keyed on the file's headers rather than
the account — one bank exports one format, so the answer carries across accounts
at the same bank and not across two banks sharing one. Validated against the
file in front of it before being applied, and saved at the point the columns are
known to have worked rather than at the end of the import.

**CSV import.** Handles a statement with separate money-out and money-in
columns, both positive — the commonest UK export, and the layout is now always
adjustable rather than only guessed. Detection reads the rows as well as the
headings, which fixed two silent failures: "Debit Amount" being read as a
signed column (every expense imported as income) and "Running Balance" being
read as money in.

**Bills.** Reconciliation walks both ways from `nextDue`, so a year of history
imported after a bill was created is offered rather than ignored.

**Edges.** A warning before removing your own access to an account.
`dev-repair-accounts.sql` and `dev-reset-data.sql`.

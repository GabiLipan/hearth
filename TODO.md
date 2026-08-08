# Hearth — book accounting, reporting and visuals

The plan for reshaping Hearth around how we actually move money: salaries land in
private accounts, most of each salary moves to the joint account, the household
spends from there, and some personal spending stays behind.

**How to read this.** `[x]` is done and on `main`. `[ ]` is not started. Anything
marked **decision** is waiting on us, not on code. Phases are in build order —
each one is useful on its own, and later phases assume earlier ones.

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

## Phase 1 — The foundation

- [x] `lib/books.ts` — classify accounts into household / mine / someone else's
- [x] Classify every transaction into a flow: contribution, household spend,
      personal spend, withdrawal, internal, external income
- [x] Unit tests for classification, including the payday case and the
      partner-leg-invisible case
- [x] Book-aware aggregates (`bookTotals`, `bookSeries`) alongside the existing ones
- [x] `useBook()` — the selected book, device-local like the theme
- [x] `BookSwitcher` — `Our household · Mine · Everything`
- [x] Wire Reports to the switcher
- [x] Wire Home to the switcher
- [x] Wire Budgets to the switcher

## Phase 2 — Budgets, bills and goals per book

- [x] Household budgets measure joint-account spending only, so both our screens
      agree on the same budget
- [x] Personal budgets measure my private accounts only — they used to filter on
      who *recorded* the transaction, which is a different question and got both
      cases wrong
- [ ] Bills grouped by book — household bills from joint, personal subscriptions
      from mine
- [ ] Goals marked household or personal, and shown in the matching book
- [ ] Migration 10: let `link_transfer` tag a goal, so a *reconciled* joint →
      savings transfer can fund a goal (today only `create_transfer` can)

## Phase 3 — Transfers under book accounting

- [ ] Auto-link cross-book pairs even when row-ambiguous — if both readings land
      in the same book every number is identical, so payday resolves itself
- [ ] Label a linked cross-book transfer as "contribution" / "withdrawal" rather
      than hiding it
- [ ] Handle joint → private properly as a withdrawal, not household spending
- [ ] Recurring transfer routes — learn "£2,000, my private → joint, monthly"
      the way a bill is learned
- [ ] Explain an incoming leg with no visible partner: "this looks like a
      transfer only <partner> can confirm", instead of silently counting it

## Phase 4 — Reporting and visuals

### Drill-down and navigation
- [x] Drill into a category's **subcategories** from the donut or the table,
      with a breadcrumb back out (Reports; Home still to do)
- [ ] Click through from any slice to Activity, filtered to that category,
      month and book
- [ ] Custom date range, not just whole months
- [ ] A 12-month / year view with an annual total

### New views
- [ ] **Household waterfall** — contributions in → spending → to savings → left
      in current, as one figure per step
- [ ] **Personal stacked bar** — `contributed | personal spend | left over` = salary,
      one bar per month
- [ ] **Who contributed what** — the split between us, newly possible because
      both contributions are visible in the joint account
- [ ] **Fixed vs variable** — tracked bills against everything else
- [ ] **Savings rate** — percentage put away, and its trend
- [ ] **Top payees** — where the money actually goes, under the category level
- [ ] **Category heatmap** — months across, categories down, for spotting drift
- [ ] **Pace line** — spend-to-date against the same point last month

### Making a part-finished month readable
- [ ] **Show the joint balance beside the figures.** On the 8th of the month,
      "Paid in £0.57, spent £3,142, left over −£3,141" is arithmetically right
      and reads like a disaster. "£4,200 at the start, £1,058 now" is the same
      fact and is actually useful
- [ ] **decision** — should the household month run payday-to-payday rather than
      1st-to-1st? If we fund the joint account at the end of the month for the
      next one, a calendar month will always show spending before its income
- [ ] Dim or annotate the current month as incomplete, everywhere it is compared
      against finished months

### Sharpening what's there
- [ ] Fix `monthlySeries` — the dead `else if`/`else` pair means *any* positive
      amount counts as income, including refunds and unlinked transfer legs
- [ ] "Net each month" only claims to be saving where that is actually true
- [ ] Month-on-month delta per category — "groceries £120 above typical"
- [ ] Same month last year, where there is a year of history
- [ ] Export the current report as CSV

## Phase 5 — Edges the model gets wrong

- [ ] A household bill paid from a personal card — a per-transaction "this was
      household spending, I just paid for it" flag
- [ ] Explicit per-account book override, for when derivation from grants is
      wrong (needs a migration)
- [ ] Reimbursements between us
- [ ] Multi-currency for Wise / Revolut — the app is single-currency today and
      any foreign amount is silently wrong. Out of scope, recorded so it is not
      forgotten

## Phase 6 — Carried over from the last round

- [ ] Bill reconciliation only looks forward from `nextDue`, so a year of history
      imported after a bill was created is never offered
- [ ] Unlinking a transfer leaves both legs uncategorised, and the old categories
      are not recoverable
- [ ] `importJSON` preserves `ownerId`, so a backup restored by the other person
      dead-letters rows RLS refuses

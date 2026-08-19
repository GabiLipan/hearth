# Reporting: three books, three questions

A proposal for the Home and Reports pages. Written after tracing why the same
figure printed two different numbers on the two of them.

The illustrated version, with mockups of every card proposed here, is
`reporting-proposal.html` beside this file — and is published at
<https://claude.ai/code/artifact/61d26159-f13f-44ce-b88d-9bd24e5aa5de>.

There are two separate problems underneath the three complaints this started
from, and they need different kinds of fix.

**The arithmetic was wrong in one place.** That is fixed, and the fix is
already on this branch — §1 records what it was, because it is the sort of
thing that comes back.

**The questions are wrong for two of the three books.** Every book is handed
the same catalogue of eleven sections with a different filter in front of it,
so each one answers the question the *household* book was designed around.
That is §2 onwards, and it is a proposal rather than a change.

---

## 1. Why the same figure printed two numbers  ·  *fixed*

`bookTotals` and `spendsIn` deliberately reach **outside** a book's own
accounts for one row type: household shopping bought off a personal card. That
is the whole point of `paid_for_household` and of migration 19 — the row is
household spending, and it lives in an account the household book is not made
of.

So those functions have to be handed everything the device can see. Reports
did. Home narrowed the list by account first, which disables that branch with
no error and no warning:

```
Home household spend  =  Reports household spend  −  Σ(paid-for-household)
```

and `Paid in` was short by exactly the same amount — which is why `Left over`
still agreed, and only the two figures either side of it were wrong.

Three more divergences fell out of tracing it:

| Where | What |
|---|---|
| Home's flow diagram | `split` from every row, `totals` from the narrowed one. `spendFlow` clamped the "You put in" band against a contributions figure that was missing everything bought on a card, and said nothing about having done so. |
| Reports, under Year | `contributionSplit` was asked for the selected **month** whatever the period was. Eleven months of perfectly well attributed money silently became "Put in — not sure by whom". |
| Budgets | Filtered by account, then asked `isSpend` — so it counted `paid-for-household` in no book at all. Worse, its six-month "typical" column used the flow-blind `monthlySpendByCategory`, which *did* count it. The two columns beside each other were computed by two different rules. |

All four are fixed by the same discipline: **anything that adds money up takes
the unscoped list and does its own selection; anything that lists rows filters
with `showsInBook`.** Budgets now goes through `bookSpendByCategory` and a new
`bookMonthlySpendByCategory`, so a household budget counts household spending
wherever it was paid from.

`books.test.ts` pins the trap itself — a narrowed list against a whole one,
asserted as arithmetic — so it fails rather than drifting back.

### A worked month, for the rest of this document

Every figure below comes from this month, and every one of them is computed by
the real functions rather than made up.

| | |
|---|---|
| My salary into my own account | £3,000 |
| I move to the joint account (2nd) | £2,000 |
| Sam's contribution arrives (2nd) | £1,800 |
| Child benefit into the joint account | £88 |
| Household spending from the joint account | £2,400 |
| Groceries I bought on my own card, for us | £90 |
| Groceries Sam bought on her card, for us | £44 |
| Joint current → joint savings | £1,000 |
| My own shopping | £700 |

|  | Ours | Mine | Everything |
|---|---:|---:|---:|
| Money in | £4,022 | £3,000 | £4,888 |
| Spent | £2,534 | £700 | £3,190 |
| Left | **£1,488** | **£210** | **£1,698** |

---

## 2. Ours — what was put in deliberately, and what was spent extra

The household book can tell you £3,934 was paid in. It cannot tell you that
£134 of that never went near the joint account — somebody bought something for
us and put it on their own card. Today the only route to that fact is hovering
one band of the flow diagram.

Both halves matter, and for different reasons. Money moved across is a
*decision*: we agreed a figure and it arrives every month. Money spent off a
personal card is an *accident of which card was in the wallet*, and it is the
half that quietly turns into somebody being owed.

### Proposed: a "Who paid in" section

An arrangeable card on Home and Reports, household book only. One row per
person, each a two-segment bar in that person's colour — solid for *moved
across*, a lighter step of the same colour (`lib/shade.ts`) for *bought
directly*:

```
You            ████████████████████▏░░        £2,090   £2,000 moved · £90 bought · 2 payments
Sam            ██████████████████▏░           £1,844   £1,800 moved · £44 bought · 2 payments
Other income   ▏                                 £88   child benefit
```

and under it one sentence with a way through:

> £134 of this month's household spending was bought straight from personal
> cards.  **See them →**

Where `showOwed` is on, a second line from the existing `settlement`: *"The
household owes you £90."* Nothing new is computed for that — it is already
there and already tested.

Three changes behind it:

- Move the "Who paid in" bar **out of** the fixed Reports summary card and into
  the arrangeable grid. It is currently the one figure on that page you cannot
  move, resize or hide, and it has no home at all on the Home page.
- `ContributionSplit` gains `externalMinor` and `unattributedMinor`. Today
  `otherMinor` merges outside income with arrivals nobody has linked, and the
  card needs them apart — "Other income £88" and "not sure by whom" are
  different facts, and only one of them is something you can act on. Keep
  `otherMinor` as their sum so nothing that reads it today has to change.
- A sub-line on the household hero: *"£134 of it from personal cards"*.

---

## 3. Mine — how much of my money went to the joint book

The personal book already draws a "To the household" band, so this is nearly
there. What it does not do is separate the two halves, and they are the two
halves you would want separated: £2,000 I decided to send, and £90 that
happened to me at a till.

### Proposed

1. **`BookTotals` gains `contributedMovedMinor` and `contributedPaidMinor`.**
   Filled in the same loop `contributed` already is — the `paid-for-household`
   branch feeds one, the `contribution` case the other, `contributed` stays
   their sum. No new pass, and no call site is forced to change.

2. **The band gets a `parts` breakdown**, built with the `partsOf` helper that
   already exists for the household side, and takes the household's own colour
   rather than a category slot — it is a destination, not a category:

   ```
   Earned  £3,000  ─────┐                    ┌─────  To our household   £2,090
                        ├──  The month  ──── ┤         moved across        £2,000
                        │                    │         bought for us          £90
                        └                    ├─────  Shopping              £700
                                             └─────  Left with me          £210
   ```

3. **`SalaryStack` splits its contributed segment in two** — four segments
   instead of three, so the monthly view answers the same question over time:
   is the share I send steady, and is the share that merely *happens* growing?

4. The phone hero on `mine` gains the "To household" figure the desktop strip
   already shows.

---

## 4. Everything — how the books relate

This is the one that needs new thinking rather than a better breakdown of an
existing figure.

Today "Everything" is the other two books flattened into one pool: the same
donut, the same monthly bars, the same flow diagram, with the household and
personal accounts added together. It answers *no* question that the other two
books do not answer better, and its income figure genuinely is not the two of
them added up — with nothing on screen to say why.

But the relationship between the books is exactly describable, and two of its
three identities are exact:

```
Left        all.net   ==  ours.net + mine.net                      always, no exceptions
Spending    all.spend ==  ours.spend + mine.spend  −  (bought for us from
                                                       an account you don't hold)
Money in    all.income ==  ours.income + mine.income −  (what crossed between us)
```

So "Everything" should stop being a fourth filter and start being the **view
that explains the other two**.

### 4a. Proposed: "How the books add up"

Full width, first in the `all` order. The bridge, with every figure real:

| | Ours | Mine | **Everything** |
|---|---:|---:|---:|
| From outside | £88 | £3,000 | **£4,888** |
| Put in between us | £3,934 | (£2,090) | **—** |
| Spent | £2,534 | £700 | **£3,190** |
| Bought for us on a card you can't see | (£44) | — | **—** |
| **Left** | **£1,488** | **£210** | **£1,698** |

> Money moved between our books is counted once in each book and in neither
> under Everything — the two legs are the same event, so counting either would
> be counting it twice. That is why Everything's income is not the two figures
> above it added together. **What is left always adds up exactly.**

Every cell drills to the rows behind it. This does not *assert* that the
numbers match; it shows the arithmetic, including the one line that does not
add up and why.

The `Bought for us on a card you can't see` row is not a rounding note. It is
Sam's £44: household spending, in an account this device holds no grant on, of
which exactly one row is published. It belongs in the household book and in no
account here. Left out of the table it is a £44 discrepancy the reader has to
find; in the table it is a fact about the privacy model.

Behind it: a `bookBridge(txns, flows, books, month | range)` returning the
three sets of totals plus the crossing figures. `others` needs totals over
`books.others`, which no `BookId` names — an internal `totalsFor(ids)` rather
than a fourth `BookId`, which would ripple into `BOOK_WORDS`, `BookSwitcher`,
the drill URLs and the sticky filters for nothing.

### 4b. Proposed: "Between our books"

The flow diagram, as four columns rather than three — stages of the money's
journey, which is genuinely what happened to it:

```
  where it came from      where it landed     where it was spent from      what it became
  ──────────────────      ───────────────     ───────────────────────      ──────────────

  You earned      ──→     Mine        ──┬──→  Mine              ──→        Shopping
                                        │                                  Left with me
  Sam put in      ──→     Ours        ──┤
                                        └──→  Ours              ──→        Home · Groceries
  Child benefit   ──→     Ours                                              Utilities
                                        ←──   (taken back out)              Left in ours
```

Columns 2 → 3 *are* the crossing. One ribbon Mine → Ours carrying
contributions moved plus bought-directly, one Ours → Mine carrying
withdrawals, and straight-through ribbons for everything that stayed where it
landed. No links within a column, so it fits a column-based layout cleanly.

What it costs, honestly — this is the largest item here and the only one that
touches shared geometry:

- `FlowNode` gains `column?: number`; `side` stays for the existing two-hop
  graphs.
- `layoutFlow` generalises from `in | hub | out` to *group by column, stack
  each on the one shared scale, ribbon between adjacent columns*. Today's
  behaviour becomes the case `columns = [in, hub, out]`, which is what
  `sankey.test.ts` should assert so every existing graph is provably
  unaffected.
- `Sankey.tsx` reads `side` for geometry in exactly two places — label
  anchoring and the hit rect. Both become "first column anchors end, last
  column anchors start, middle columns label above the node".

It can be deferred without blocking 4a.

### 4c. Smaller

- The categories card under `all` gains a **Split by book** option: `Combined`
  (today) or `Ours vs Mine`, each bar carrying two segments. Bars only — a
  split arc is unreadable.
- `BOOK_WORDS.all.netHint` and `BOOK_HINT.all` currently say "not a meaningful
  income figure", which is a shrug. They should name the rule and point at the
  reconciliation card.

---

## 5. Build order

| | | Touches |
|---|---|---|
| 1 | Who paid in (§2) | New card + two `ContributionSplit` fields. Data all exists. |
| 2 | How the books add up (§4a) | New card + `bookBridge`. Identities already pinned in tests. |
| 3 | To the household, split (§3) | Two `BookTotals` fields, one `parts` call, `SalaryStack`. |
| 4 | Between our books (§4b) | `layoutFlow` generalisation. The only shared-geometry change. |
| 5 | Split by book (§4c) | `bookSplitByCategory` + a bar variant. |

1 and 2 are self-contained cards over data that already exists, and between
them they answer all three of the complaints this started from. 4 is the one
worth doing only if the picture in §4b is the picture you want.

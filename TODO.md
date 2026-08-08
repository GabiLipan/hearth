# Hearth — what is left

The plan for reshaping Hearth around how we actually move money: salaries land in
private accounts, most of each salary moves to the joint account, the household
spends from there, and some personal spending stays behind.

**How to read this.** **Decided** is the answers we have already given, kept
because the reasoning behind a rule outlives the rule. **Waiting on code** is
the work, grouped by what it needs before it can start. What has shipped is not
here at all: it is in the git log, where it cannot rot, and a plan made mostly
of finished work stops being read.

Right now: **nothing waiting on us.** Every open question has been answered —
they are recorded below, because the reasoning is worth keeping. What is left is
**2 pieces of work**: one ready, one needing a migration of its own.

**`supabase/13-paid-for-household.sql` needs applying by hand**, like the
others. Until then the tick box on a transaction saves nothing.

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

---

# Decided

Answered 8 August 2026. Recorded here because the reasoning behind a rule is
worth more than the rule, and none of this is derivable from the code.

**Joint savings is inside the household book.** Confirmed. This is what makes
"net" literally equal "saved" — every account is inside the book, so nothing
leaves it except by being spent.

**Credit cards follow the normal rule.** Confirmed. A card only one of us holds
is personal; a joint one is the household's. A personal card paid off from joint
is a household → personal flow, not household spending.

**Unlinking a transfer puts the categories back.** Confirmed, and done —
migration 12 keeps them in `transactions.prior_category_id` between the two
operations. A category set while the transfer was linked wins over the
remembered one, since it is the newer answer.

**A household bill paid from a personal card moves the spending into the
household book and leaves a debt in the personal one.** Built — migration 13. In Gabi's words: it is
almost exactly as if the money had gone from the personal account into the joint
one and then been spent from there. So one flagged row is two events — a
contribution out of my book, and household spending in theirs — which is the
same "counted once on each side" rule that already governs a transfer crossing
between books.

**Reimbursements between us use the same mechanism**, and are built with it
rather than after it.

**Multi-currency is out of scope for now.** Foreign amounts stay silently wrong;
it is written down so nobody rediscovers it as a bug.

# Waiting on code

## Ready — nothing blocking this

**Recurring transfer routes.** Learn "£2,000, my private → joint, monthly" the
way a bill is learned, so payday stops needing confirmation every month.

## Needing a migration of their own

**Tell the person who CAN see the far leg.** `lib/unexplained.ts` names the
blind spot on my screen — money moved that only my partner can confirm. The
other half is my device telling theirs "there is an arrival here waiting for you
to link it", which needs somewhere shared to put the note.

**Explicit per-account book override**, for the cases where deriving the book
from grants gets it wrong. A column on `accounts` and a policy that lets an
owner set it.

**Reimbursements between us.** The mechanism from migration 13 exists now; what
is left is the other direction — paying somebody back, and seeing what is
outstanding between us. Wants no new column, only a view of what has been paid
for and not settled.

---

# Shipped

Deliberately not itemised. Every change is in the git log with its reasoning in
the commit message, and `CLAUDE.md` carries the parts that are still
load-bearing: the architecture, the invariants, the privacy model, the migration
order, and the traps that have actually bitten.

Broadly, and in build order: book accounting end to end (`lib/books.ts`, the
switcher, book-aware budgets, bills and goals); transfers that pair themselves
and can fund a goal after the fact (migration 10); Activity rebuilt as one
continuous list with a drawer category picker; the reports — donut drill-down,
click-through to Activity, seven analysis views, CSV export, and honesty about
part-finished months; a CSV importer that reads both statement layouts and
remembers which one your bank uses; and the safety work — bill reconciliation
both ways, backups that survive being restored by the other person, and the
blind spot in the book model said out loud rather than papered over.

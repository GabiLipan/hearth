# Hearth — what is left

The plan for reshaping Hearth around how we actually move money: salaries land in
private accounts, most of each salary moves to the joint account, the household
spends from there, and some personal spending stays behind.

**How to read this.** The work is finished, so what is left is **Decided** — the
answers we gave, kept because the reasoning behind a rule outlives the rule.
Anything new goes back under a "Waiting on code" heading, grouped by what it
needs before it can start. What has shipped is not itemised here: it is in the
git log, where it cannot rot, and a plan made mostly of finished work stops
being read.

Right now: **nothing waiting on us**, and **nothing left on this plan**. What
comes next is whatever we find by using it.

**Two migrations need applying by hand**, like the others:

- `supabase/15-purge-account.sql` — until then the bin in Settings only fills
  up, and "Delete for good" fails with "could not find the function".
- `supabase/16-explain-requests.sql` — until then "Ask about this" does the
  same.

Run `supabase/00-which-migrations-applied.sql` in the SQL editor when unsure
what a project has had; it now covers 11 through 16 as well.

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
rather than after it. Built — the figure is a view over what has been paid for
and not yet returned, and nothing is ever "marked settled": paying somebody back
is an ordinary transfer, so the figure falls to zero because the sum changed.

**Asking about a row needs less than changing it.** Migration 16. The person who
can see a puzzling arrival in the joint account is, by definition, the one who
cannot resolve it — the far leg is in an account they are not on. So
`request_explanation` takes `view`, below the bar for editing the row, and it is
safe to be lower only because the row is one both people can already read.
There is no "declined" state: a row that was linked reads as a transfer and one
that was dismissed is unmarked and still unpaired, which is a distinction two
people can draw without the database mediating it.

**A deleted account can be destroyed, but only from the bin.** Built —
migration 15. Deleting stays reversible and purging is a separate press on a
separate screen, because the bin is the entire safety net: there is no argument
to `delete_account()` that skips it. Purging bumps the visibility epoch, which
looks wrong (nobody's access changes) and is not: it removes the tombstone a
device that has been offline since the delete was going to learn from, and the
epoch is the only signal that survives a row ceasing to exist.

**Multi-currency is out of scope for now.** Foreign amounts stay silently wrong;
it is written down so nobody rediscovers it as a bug.

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

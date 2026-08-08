# Hearth — what is left

The plan for reshaping Hearth around how we actually move money: salaries land in
private accounts, most of each salary moves to the joint account, the household
spends from there, and some personal spending stays behind.

**How to read this.** Two sections. **Waiting on us** is decisions — nothing can
be built until we answer them. **Waiting on code** is work, each item labelled
`ready` or `migration 11` so you can see at a glance what is actually pickable
up. What has already shipped is not here at all: it is in the git log, where it
cannot rot, and a plan made mostly of finished work stops being read.

Right now: **6 decisions waiting on us**, and **3 pieces of work** — 1 ready, 2
needing schema changes of their own. Migration 11 is written and waiting to be
applied.

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

# Waiting on us

Six questions. None of them has code waiting behind it that I can write first —
answering them *is* the blocker.

**1. Is joint savings inside the household book?**
It is today, which is what makes "net" literally equal "saved". The alternative
is giving it its own book. Currently assumed, not decided.

**2. Do credit cards follow the normal rule?**
Assumed yes: a card only one of us holds is personal, a joint one is the
household's. A personal card paid off from joint is then a household → personal
flow rather than household spending. Say if that is wrong.

**3. Should unlinking a transfer put the categories back?**
Linking clears `category_id` on both legs and the old values are gone. Storing
them to restore is easy — the question is whether restoring is *right*, or
whether it re-creates an answer somebody deliberately cleared.

**4. A household bill paid from a personal card.**
Needs a per-transaction "this was household spending, I just paid for it" flag.
The column is the easy half; what it does to both books is the question. Does it
move the spending into the household book and leave a debt in mine? Or stay
where it is and only annotate?

**5. Reimbursements between us.**
Almost certainly the same mechanism as (4) — worth settling the two together
rather than building one and retrofitting the other.

**6. Multi-currency, for Wise and Revolut.**
The app is single-currency and any foreign amount is silently wrong today. Not
"out of scope" so much as "not decided": a real answer means a rate source and a
decision about which day's rate a transaction is worth.

---

# Waiting on code

## Ready — nothing blocking this

**Recurring transfer routes.** Learn "£2,000, my private → joint, monthly" the
way a bill is learned, so payday stops needing confirmation every month.

## Waiting to be applied

**`supabase/11-account-recovery.sql`. Run it by hand in the Supabase SQL
editor.** Until then the "Recoverable" section in Settings stays empty and its
RPCs fail. Undo for a deleted account and reclaiming an ownerless one are both
written and covered by `99g-recovery-tests.sql`.

## Needing a schema change of their own

Neither of these is part of migration 11 — each wants its own.

**Tell the person who CAN see the far leg.** `lib/unexplained.ts` names the
blind spot on my screen — money moved that only my partner can confirm. The
other half is my device telling theirs "there is an arrival here waiting for you
to link it", which needs somewhere shared to put the note.

**Explicit per-account book override**, for the cases where deriving the book
from grants gets it wrong. A column on `accounts` and a policy that lets an
owner set it.

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

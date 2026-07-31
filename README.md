# Hearth — Family Finance

A private, beautiful budgeting app for two. Track spending, budgets and recurring
bills; import bank statements; see where the money goes. Works as an installable
app (PWA) on phone, iPad and desktop, in light and dark mode.

## Features

- **Dashboard** — month-at-a-glance: spent vs budget, where it went, upcoming bills
- **Quick add** — 2-tap expense entry with payee memory and auto-suggested categories
- **Receipt scanning** — photograph a receipt and the payee, amount and date are
  read on-device (PaddleOCR via ONNX Runtime); nothing is uploaded
- **CSV and PDF import** — drop in a bank statement; columns and date format are
  detected, duplicates flagged, and transactions auto-categorised
- **Self-learning rules** — every categorisation you make teaches the importer
- **Recurring bills** — due-date tracking, optional automatic recording, and
  detection of payments that *look* recurring
- **Budgets** — monthly per-category targets, shared or personal
- **Reports** — category breakdown, monthly trends, income vs spending, net saved,
  with an accessible table view of every chart
- **Shared, with room for privacy** — one household, two people, everything in
  step. An account can be fully shared, balance-only (they see what it holds but
  not what you spent it on), or entirely private.

## How the data works

The server is the source of truth: a Supabase Postgres database that only you and
whoever you invite can read. Each device keeps a local mirror so the app opens
instantly and still works with no signal, plus a queue of changes waiting to be
sent. Edit on your phone on the tube and it goes up when you surface.

Two people editing at once is fine. Updates carry only the fields that changed, so
you can rename a transaction while your partner recategorises it and both survive.

**Nothing protects your data except the database itself.** Access is decided per
row by Postgres, against the token of whoever is signed in — never by the app,
which anyone can inspect and modify. That is why the Supabase URL and publishable
key are safe to commit and to ship in the bundle: they name the project, they do
not open it. See [`supabase/README.md`](supabase/README.md) for the details, and
[`supabase/99-rls-tests.sql`](supabase/99-rls-tests.sql) for the assertions that
prove a private account really is private.

The `service_role` key bypasses all of this. It must never appear in this repo, in
a build secret, or in the browser.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in from your Supabase project: Settings → API
npm run dev
```

Set the database up first: run `supabase/01-schema.sql`, `02-rls.sql` and
`03-rpc.sql` in your project's SQL editor, in that order.

```bash
npm test
```

## Deploy to GitHub Pages (free)

1. Push to the `main` branch of a GitHub repository.
2. Repo settings → **Secrets and variables → Actions**, add `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY`.
3. Repo settings → **Pages**, set **Source** to **GitHub Actions**.

`.github/workflows/deploy.yml` runs the tests, builds and publishes on every push.
Your app appears at `https://<username>.github.io/<repo>/`. Open it on your phone
and use **Add to Home Screen** to install it.

> A public repo is fine, and is what the free Pages tier needs. No data and no
> secrets ship in the bundle.

## Sharing with your partner

Settings → **Household** shows an invite code. They create an account, enter the
code, and both devices are looking at the same data within seconds.

## Tech

React 19 · TypeScript · Vite · Tailwind CSS 4 · Supabase (Postgres, auth, realtime)
· Dexie (IndexedDB cache) · Recharts · pdf.js · PaddleOCR · vite-plugin-pwa.

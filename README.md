# Hearth — Family Finance

A private, beautiful budgeting app for two. Track spending, budgets and recurring
bills; import bank statements; see where the money goes. Works as an installable
app (PWA) on phone, iPad and desktop, in light and dark mode.

## Features

- **Dashboard** — month-at-a-glance: spent vs budget, where it went, upcoming bills
- **Quick add** — 2-tap expense entry with payee memory and auto-suggested categories
- **CSV import** — drop in a bank statement; columns and date format are detected,
  duplicates skipped, and transactions auto-categorised
- **Self-learning rules** — every categorisation you make teaches the importer
- **Recurring bills** — due-date tracking, optional automatic recording, and
  detection of payments that *look* recurring
- **Budgets** — monthly per-category targets with progress and over-spend warnings
- **Reports** — category breakdown, monthly trends, income vs spending, net saved,
  with an accessible table view of every chart
- **Private by design** — all data stays in your browser (IndexedDB). Backup /
  restore via JSON export, which is also how you sync between devices.

## Run locally

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages (free)

1. Create a GitHub repository and push this folder to the `main` branch:

   ```bash
   git init
   git add -A
   git commit -m "Hearth family finance app"
   gh repo create hearth --private --source . --push   # or add a remote manually
   ```

2. In the repo settings → **Pages**, set **Source** to **GitHub Actions**.
3. Push (or re-run the workflow). The included workflow
   (`.github/workflows/deploy.yml`) builds and publishes automatically.
   Your app appears at `https://<username>.github.io/<repo>/`.

> Note: on a private repo, GitHub Pages requires a Pro plan — a **public repo is
> fine** because the app contains no data; all finance data lives only in each
> device's browser storage.

4. Open the URL on your phone/iPad and use **Add to Home Screen** to install it
   like a native app.

## Sharing between two people

Data is stored per device. To share: Settings → **Export backup** on one device,
then **Import backup** on the other. For automatic real-time sync a hosted
database (e.g. the free tier of Supabase) can be added later.

## Tech

React 19 · TypeScript · Vite · Tailwind CSS 4 · Dexie (IndexedDB) · Recharts ·
vite-plugin-pwa. No server, no accounts, no tracking.

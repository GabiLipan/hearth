import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Sun, Moon, MonitorSmartphone, Download, Upload, Trash2, Sparkles, Plus, Cloud, RefreshCw, LogOut, Users, Copy, Lock, Eye } from 'lucide-react'
import { db, type Category, type Account, type AccountVisibility } from '../lib/db'
import { createRow, updateRow, removeRow, notDeleted } from '../lib/data'
import { computeBalance, setAccountVisibility, VISIBILITY_LABEL } from '../lib/accounts'
import { parseAmount, CURRENCIES, currencySymbol } from '../lib/money'
import { exportJSON, downloadJSON, importJSON, clearAllData } from '../lib/backup'
import { seedDemoData } from '../lib/demo'
import { signIn, signUp, signOut, createHousehold, joinHousehold, syncNow } from '../lib/sync'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import { Card, SectionTitle, Segmented, Select, Button, Sheet, Field, TextInput, CategoryDot } from '../components/ui'

function HouseholdSync() {
  const sync = useSyncState()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    }
    setBusy(false)
  }

  if (!sync.email) {
    return (
      <Card className="space-y-3 p-4">
        <p className="text-sm text-ink-2">
          Sign in to sync your household's data between your devices — changes appear on your partner's phone in
          seconds, and everything still works offline.
        </p>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'signin', label: 'Sign in' },
            { value: 'signup', label: 'Create account' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email">
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
          </Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 6 characters.' : undefined}>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder="••••••••"
            />
          </Field>
        </div>
        {error && <p className="text-sm text-critical-text">{error}</p>}
        <Button
          disabled={busy || !email.trim() || password.length < 6}
          onClick={() => run(() => (mode === 'signup' ? signUp(email.trim(), password) : signIn(email.trim(), password)))}
        >
          <Cloud size={15} /> {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </Button>
      </Card>
    )
  }

  if (!sync.householdId) {
    return (
      <Card className="space-y-3 p-4">
        <p className="text-sm text-ink-2">
          Signed in as <span className="font-medium text-ink">{sync.email}</span>. One of you creates the household;
          the other joins with the invite code it generates.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Button disabled={busy} onClick={() => run(createHousehold)}>
            <Users size={15} /> Create our household
          </Button>
          <span className="text-sm text-ink-3">or</span>
          <TextInput
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Invite code"
            className="w-36 uppercase"
          />
          <Button
            variant="subtle"
            disabled={busy || joinCode.trim().length < 6}
            onClick={() => {
              if (confirm('Joining replaces any data on this device with the household’s shared data. Continue?')) {
                void run(() => joinHousehold(joinCode))
              }
            }}
          >
            Join
          </Button>
        </div>
        {error && <p className="text-sm text-critical-text">{error}</p>}
        <button onClick={() => void signOut()} className="text-sm text-ink-3 underline-offset-2 hover:underline">
          Sign out
        </button>
      </Card>
    )
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full bg-good/10 px-3 py-1 text-sm font-medium text-good-text">
          <Cloud size={14} /> Syncing
        </span>
        <span className="text-sm text-ink-2">{sync.email}</span>
        {sync.syncing && <RefreshCw size={14} className="animate-spin text-ink-3" />}
        {sync.lastSyncAt && !sync.syncing && (
          <span className="text-xs text-ink-3">updated {new Date(sync.lastSyncAt).toLocaleTimeString()}</span>
        )}
      </div>
      {sync.joinCode && (
        <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-3">Partner invite code — they enter this after creating their account</p>
            <p className="text-lg font-bold tracking-widest tabular">{sync.joinCode}</p>
          </div>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              void navigator.clipboard.writeText(sync.joinCode!)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {sync.error && <p className="text-sm text-critical-text">Last sync problem: {sync.error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="subtle" disabled={sync.syncing} onClick={() => void syncNow()}>
          <RefreshCw size={14} /> Sync now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void signOut()}>
          <LogOut size={14} /> Sign out
        </Button>
      </div>
    </Card>
  )
}

export default function SettingsPage() {
  const { themePref, setThemePref, currency, setCurrency } = useApp()
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').filter(notDeleted).toArray(), []) ?? []
  const rules = useLiveQuery(async () => (await db.rules.filter(notDeleted).toArray()).sort((a, b) => b.createdAt - a.createdAt), []) ?? []
  const [editingCat, setEditingCat] = useState<Category | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="max-w-2xl">
      <SectionTitle>Household sync</SectionTitle>
      <HouseholdSync />

      <SectionTitle>Appearance</SectionTitle>
      <Card className="p-4">
        <Segmented
          value={themePref}
          onChange={setThemePref}
          options={[
            { value: 'light', label: <span className="flex items-center justify-center gap-1.5"><Sun size={15} /> Light</span> },
            { value: 'dark', label: <span className="flex items-center justify-center gap-1.5"><Moon size={15} /> Dark</span> },
            { value: 'system', label: <span className="flex items-center justify-center gap-1.5"><MonitorSmartphone size={15} /> Auto</span> },
          ]}
        />
        <div className="mt-4">
          <Field label="Currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <AccountsSection />

      <SectionTitle
        action={
          <button onClick={() => setEditingCat('new')} className="flex items-center gap-1 text-sm font-medium text-accent">
            <Plus size={14} /> Add
          </button>
        }
      >
        Categories
      </SectionTitle>
      <Card>
        <ul className="divide-y divide-hairline">
          {categories.map((c) => (
            <li key={c.id}>
              <button onClick={() => setEditingCat(c)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/50">
                <CategoryDot category={c} size={32} />
                <span className="flex-1 font-medium">{c.name}</span>
                <span className="text-xs uppercase tracking-wide text-ink-3">{c.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <SectionTitle>Learned rules</SectionTitle>
      <Card className="p-4">
        {rules.length === 0 ? (
          <p className="text-sm text-ink-3">
            Nothing learned yet. Every time you categorise a payee, Hearth remembers and applies it to future entries and imports.
          </p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  “{r.match}” → {categories.find((c) => c.id === r.categoryId)?.name ?? '?'}
                </span>
                <button onClick={() => void removeRow('rules', r.id!)} aria-label={`Forget rule ${r.match}`} className="text-ink-3 hover:text-critical-text">
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SectionTitle>Your data</SectionTitle>
      <Card className="space-y-3 p-4">
        <p className="text-sm text-ink-2">
          Data lives on this device (and syncs via your household when signed in). Backups are handy before big
          changes, or for moving data without sync.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="subtle" onClick={async () => downloadJSON(await exportJSON())}>
            <Download size={15} /> Export backup
          </Button>
          <Button variant="subtle" onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> Import backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              if (!confirm('Importing a backup replaces everything on this device. Continue?')) return
              try {
                await importJSON(await f.text())
                alert('Backup imported.')
              } catch (err) {
                alert(err instanceof Error ? err.message : 'That file could not be imported.')
              }
            }}
          />
          <Button
            variant="subtle"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await seedDemoData()
              setBusy(false)
            }}
          >
            <Sparkles size={15} /> Load demo data
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (confirm('Delete ALL data on this device? Export a backup first if you want to keep it.') && confirm('Really delete everything? This cannot be undone.')) {
                await clearAllData()
              }
            }}
          >
            <Trash2 size={15} /> Erase everything
          </Button>
        </div>
      </Card>

      <p className="mt-6 px-1 text-xs text-ink-3">
        Hearth · a private family finance app. Install it from your browser's share / install menu for the full app
        experience.
      </p>

      <CategoryForm
        key={editingCat === 'new' ? 'new' : (editingCat?.id ?? 'closed')}
        category={editingCat === 'new' ? undefined : (editingCat ?? undefined)}
        open={editingCat !== null}
        onClose={() => setEditingCat(null)}
      />
    </div>
  )
}

function AccountsSection() {
  const { money } = useApp()
  const { userId } = useSyncState()
  const accounts = useLiveQuery(() => db.accounts.filter(notDeleted).toArray(), []) ?? []
  const txns = useLiveQuery(() => db.transactions.filter(notDeleted).toArray(), []) ?? []
  const [editing, setEditing] = useState<Account | 'new' | null>(null)

  const balanceOf = (a: Account) =>
    a.ownerId && a.ownerId !== userId ? (a.balanceMinor ?? 0) : computeBalance(a, txns)

  return (
    <>
      <SectionTitle
        action={
          <button onClick={() => setEditing('new')} className="flex items-center gap-1 text-sm font-medium text-accent">
            <Plus size={14} /> Add
          </button>
        }
      >
        Accounts
      </SectionTitle>
      <Card>
        <ul className="divide-y divide-hairline">
          {accounts.map((a) => {
            const vis = a.visibility ?? 'shared'
            const mine = !a.ownerId || a.ownerId === userId
            return (
              <li key={a.id}>
                <button
                  onClick={() => (mine ? setEditing(a) : undefined)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left ${mine ? 'hover:bg-surface-2/50' : 'cursor-default'}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-medium">
                      {a.name}
                      {vis === 'private' && <Lock size={13} className="text-ink-3" />}
                      {vis === 'balance' && <Eye size={13} className="text-ink-3" />}
                    </p>
                    <p className="text-sm text-ink-3">
                      {a.kind}
                      {!mine ? " · partner's" : vis !== 'shared' ? ` · ${VISIBILITY_LABEL[vis].toLowerCase()}` : ''}
                    </p>
                  </div>
                  <span className={`font-semibold tabular ${balanceOf(a) < 0 ? 'text-critical-text' : ''}`}>
                    {money(balanceOf(a))}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Card>
      <AccountForm
        key={editing === 'new' ? 'new' : (editing?.id ?? 'closed')}
        account={editing === 'new' ? undefined : (editing ?? undefined)}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
    </>
  )
}

function AccountForm({ account, open, onClose }: { account?: Account; open: boolean; onClose: () => void }) {
  const { currency } = useApp()
  const { userId, householdId } = useSyncState()
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<Account['kind']>(account?.kind ?? 'current')
  const [visibility, setVisibility] = useState<AccountVisibility>(account?.visibility ?? 'shared')
  const [opening, setOpening] = useState(
    account?.openingBalanceMinor != null ? String(account.openingBalanceMinor / 100) : '',
  )
  const canSave = name.trim().length > 0

  const visOptions: { value: AccountVisibility; hint: string }[] = [
    { value: 'shared', hint: 'You both see the account and all its transactions.' },
    { value: 'balance', hint: 'Your partner sees the account and its balance, but none of the transactions.' },
    { value: 'private', hint: 'Only you ever see this account.' },
  ]

  async function save() {
    if (!canSave) return
    const openingMinor = parseAmount(opening) ?? undefined
    if (account?.id) {
      await updateRow('accounts', account.id, { name: name.trim(), kind, openingBalanceMinor: openingMinor })
      await setAccountVisibility({ ...account, openingBalanceMinor: openingMinor }, visibility, userId)
    } else {
      await createRow<Account>('accounts', {
        name: name.trim(),
        kind,
        visibility,
        ownerId: visibility === 'shared' ? undefined : userId,
        openingBalanceMinor: openingMinor,
      })
    }
    onClose()
  }

  async function remove() {
    if (!account?.id) return
    const used = await db.transactions.where('accountId').equals(account.id).filter(notDeleted).count()
    if (used > 0) {
      alert(`"${account.name}" has ${used} transactions, so it can't be deleted.`)
      return
    }
    if (confirm(`Delete account "${account.name}"?`)) {
      await removeRow('accounts', account.id)
      onClose()
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={account ? 'Edit account' : 'New account'}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My current account" autoFocus={!account} />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Account['kind'])}>
              <option value="current">Current</option>
              <option value="credit">Credit card</option>
              <option value="savings">Savings</option>
              <option value="cash">Cash</option>
            </Select>
          </Field>
        </div>
        <Field label={`Opening balance (${currencySymbol(currency)}, optional)`} hint="The balance before the first transaction recorded in Hearth.">
          <TextInput value={opening} onChange={(e) => setOpening(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </Field>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Who can see it?</span>
          <div className="space-y-2">
            {visOptions.map((o) => (
              <label
                key={o.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3 ring-1 transition ${
                  visibility === o.value ? 'bg-accent/8 ring-accent' : 'bg-surface-2 ring-transparent'
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === o.value}
                  onChange={() => setVisibility(o.value)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-sm font-medium">{VISIBILITY_LABEL[o.value]}</span>
                  <span className="block text-xs text-ink-3">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {visibility !== 'shared' && !householdId && (
            <p className="mt-2 text-xs text-ink-3">Privacy applies once you're signed in to household sync.</p>
          )}
        </div>
        <div className="flex gap-2">
          {account?.id && (
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

function CategoryForm({ category, open, onClose }: { category?: Category; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [emoji, setEmoji] = useState(category?.emoji ?? '🏷️')
  const [kind, setKind] = useState<'expense' | 'income'>(category?.kind ?? 'expense')
  const canSave = name.trim().length > 0

  async function save() {
    if (!canSave) return
    if (category?.id) {
      await updateRow('categories', category.id, { name: name.trim(), emoji: emoji.trim() || '🏷️' })
    } else {
      const count = await db.categories.count()
      await createRow<Category>('categories', {
        name: name.trim(),
        emoji: emoji.trim() || '🏷️',
        kind,
        slot: (count % 8) + 1,
        sortOrder: count,
      })
    }
    onClose()
  }

  async function remove() {
    if (!category?.id) return
    const used = await db.transactions.where('categoryId').equals(category.id).filter(notDeleted).count()
    if (used > 0) {
      alert(`"${category.name}" is used by ${used} transactions, so it can't be deleted. Recategorise them first.`)
      return
    }
    if (confirm(`Delete category "${category.name}"?`)) {
      const budgets = await db.budgets.where('categoryId').equals(category.id).toArray()
      for (const b of budgets) await removeRow('budgets', b.id!)
      await removeRow('categories', category.id)
      onClose()
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={category ? 'Edit category' : 'New category'}>
      <div className="space-y-4">
        <div className="grid grid-cols-[5rem_1fr] gap-3">
          <Field label="Emoji">
            <TextInput value={emoji} onChange={(e) => setEmoji(e.target.value)} className="text-center text-xl" />
          </Field>
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pets" autoFocus />
          </Field>
        </div>
        {!category && (
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'expense', label: 'Expense' },
              { value: 'income', label: 'Income' },
            ]}
          />
        )}
        <div className="flex gap-2">
          {category?.id && (
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

import { useMemo, useRef, useState } from 'react'
import { Sun, Moon, MonitorSmartphone, Download, Upload, Trash2, Sparkles, Plus, Cloud, CloudOff, RefreshCw, LogOut, Copy, Lock, Eye, Check, AlertTriangle } from 'lucide-react'
import { db, type Category, type Account, type AccountVisibility } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import { balanceOf, setAccountVisibility, VISIBILITY_LABEL, VISIBILITY_HINT } from '../lib/accounts'
import { useAccounts, useAllTransactions, useCategories, useDeadLetters, useRemoteBalances, useRules } from '../lib/cache'
import { grouped, styleOf, topLevel } from '../lib/categories'
import { discardDeadLetter, retryDeadLetter } from '../lib/outbox'
import { parseAmount, CURRENCIES, currencySymbol } from '../lib/money'
import { exportJSON, downloadJSON, importJSON, clearAllData } from '../lib/backup'
import { SLOTS, SLOT_NAMES, slotVar, nextFreeSlot } from '../lib/palette'
import { seedDemoData } from '../lib/demo'
import { signOut, joinHousehold, leaveHousehold, syncNow } from '../lib/session'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import { Card, SectionTitle, Segmented, Select, Button, Sheet, Field, TextInput, CategoryDot, cx } from '../components/ui'
import { CategoryIcon, CATEGORY_ICON_KEYS } from '../components/CategoryIcon'

/**
 * The household card. Signing in and choosing a household happen in Onboarding
 * now — by the time this renders, both have already happened.
 */
function HouseholdCard() {
  const sync = useSyncState()
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    }
    setBusy(false)
  }

  return (
    <Card className="space-y-3 p-4 md:p-3">
      <div className="flex flex-wrap items-center gap-2">
        {sync.online ? (
          <span className="flex items-center gap-1.5 rounded-full bg-good/10 px-3 py-1 text-sm font-medium text-good-text">
            <Cloud size={14} /> Synced
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-sm font-medium text-ink-2">
            <CloudOff size={14} /> Offline
          </span>
        )}
        <span className="text-sm text-ink-2">{sync.email}</span>
        {sync.syncing && <RefreshCw size={14} className="animate-spin text-ink-3" />}
        {sync.lastSyncAt && !sync.syncing && (
          <span className="text-xs text-ink-3">updated {new Date(sync.lastSyncAt).toLocaleTimeString()}</span>
        )}
      </div>

      {sync.pending > 0 && (
        <p className="text-sm text-ink-3">
          {sync.pending} change{sync.pending === 1 ? '' : 's'} waiting to be saved
          {sync.online ? '…' : ' — they will go up when you are back online.'}
        </p>
      )}

      {sync.joinCode && (
        <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-3">Invite code — share with your partner so they can join this household</p>
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
      {error && <p className="text-sm text-critical-text">{error}</p>}

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-3 hover:text-ink-2">Join a different household</summary>
        <p className="mt-2 text-xs text-ink-3">
          Enter your partner's invite code to share one household. This device's copy is replaced by theirs, and
          anything not yet saved is discarded.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
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
              if (confirm('Joining replaces this device\u2019s data with your partner\u2019s household. Continue?')) {
                void run(() => joinHousehold(joinCode))
              }
            }}
          >
            Join
          </Button>
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="subtle" disabled={sync.syncing || !sync.online} onClick={() => void syncNow()}>
          <RefreshCw size={14} /> Sync now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void signOut()}>
          <LogOut size={14} /> Sign out
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (confirm('Leave this household? Your data stays with the household; this device is disconnected from it.')) {
              void run(leaveHousehold)
            }
          }}
        >
          Leave household
        </Button>
      </div>
    </Card>
  )
}

/**
 * Writes the server refused for a reason retrying cannot fix. Shown here rather
 * than as a toast because the failure usually happens while offline, long after
 * the user has put the phone down \u2014 a change that could not be saved must not
 * disappear quietly.
 */
function UnsavedChanges() {
  const deadLetters = useDeadLetters()
  if (deadLetters.length === 0) return null
  return (
    <section>
      <SectionTitle>Couldn\u2019t be saved</SectionTitle>
      <Card className="space-y-3 p-4 md:p-3">
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          These changes were rejected by the server. Usually it means the thing they referred to was deleted on another
          device.
        </p>
        <ul className="space-y-2">
          {deadLetters.map((d) => (
            <li key={d.id} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
              <p className="font-medium">{d.summary}</p>
              <p className="text-xs text-ink-3">{d.message}</p>
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" variant="subtle" onClick={() => void retryDeadLetter(d.id)}>
                  Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void discardDeadLetter(d.id)}>
                  Discard
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  )
}

export default function SettingsPage() {
  const { themePref, setThemePref, currency, setCurrency } = useApp()
  const categories = useCategories()
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const rules = useRules()
  const [editingCat, setEditingCat] = useState<Category | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    // Settings are independent blocks, so on a wide screen they flow into
    // columns rather than one long ribbon down the left edge.
    <div className="max-w-2xl xl:max-w-none xl:columns-2 xl:gap-6 2xl:columns-3 [&>section]:break-inside-avoid">
      <section>
        <SectionTitle>Household</SectionTitle>
        <HouseholdCard />
      </section>

      <UnsavedChanges />

      <section>
        <SectionTitle>Appearance</SectionTitle>
        <Card className="p-4 md:p-3">
          <Segmented
            value={themePref}
            onChange={setThemePref}
            options={[
              { value: 'light', label: <span className="flex items-center justify-center gap-1.5"><Sun size={15} /> Light</span> },
              { value: 'dark', label: <span className="flex items-center justify-center gap-1.5"><Moon size={15} /> Dark</span> },
              { value: 'system', label: <span className="flex items-center justify-center gap-1.5"><MonitorSmartphone size={15} /> Auto</span> },
            ]}
          />
          <div className="mt-3">
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
      </section>

      <AccountsSection />

      <section>
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
            {grouped(categories).map(({ parent, children }) => (
              <li key={parent.id}>
                <button
                  onClick={() => setEditingCat(parent)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/50 md:gap-2.5 md:px-3 desktop:py-1.5"
                >
                  <CategoryDot category={{ ...parent, ...styleOf(parent, catMap) }} size={32} className="md:[--dot:24px]" />
                  <span className="min-w-0 flex-1 truncate font-medium md:text-sm">{parent.name}</span>
                  {parent.ownerId && <Lock size={12} className="shrink-0 text-ink-3" />}
                  <span className="text-xs uppercase tracking-wide text-ink-3">{parent.kind}</span>
                </button>
                {children.length > 0 && (
                  <ul className="border-t border-hairline/60 bg-surface-2/30">
                    {children.map((child) => (
                      <li key={child.id}>
                        <button
                          onClick={() => setEditingCat(child)}
                          className="flex w-full items-center gap-3 py-2 pl-11 pr-4 text-left hover:bg-surface-2/60 md:gap-2.5 md:pl-10 md:pr-3 desktop:py-1.5"
                        >
                          <CategoryDot category={{ ...child, ...styleOf(child, catMap) }} size={22} />
                          <span className="min-w-0 flex-1 truncate text-sm">{child.name}</span>
                          {child.ownerId && <Lock size={12} className="shrink-0 text-ink-3" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section>
        <SectionTitle>Learned rules</SectionTitle>
        <Card className="p-4 md:p-3">
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
                  <button onClick={() => void removeRow('rules', r.id)} aria-label={`Forget rule ${r.match}`} className="text-ink-3 hover:text-critical-text">
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
      <SectionTitle>Your data</SectionTitle>
      <Card className="space-y-3 p-4 md:p-3">
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
              if (
                confirm(
                  'Delete all transactions, budgets, bills and accounts? If you sync with a partner, this deletes them for both of you. Export a backup first if you want to keep a copy.',
                ) &&
                confirm('Really delete everything? This cannot be undone.')
              ) {
                await clearAllData()
              }
            }}
          >
            <Trash2 size={15} /> Erase everything
          </Button>
        </div>
      </Card>

      <p className="mt-4 px-1 text-xs text-ink-3">
        Hearth · a private family finance app. Install it from your browser's share / install menu for the full app
        experience.
      </p>
      </section>

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
  const accounts = useAccounts()
  const txns = useAllTransactions() ?? []
  const remoteBalances = useRemoteBalances()
  const [editing, setEditing] = useState<Account | 'new' | null>(null)

  const balance = (a: Account) => balanceOf(a, txns, remoteBalances, userId)

  return (
    <section>
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
            const vis = a.visibility
            const mine = !a.ownerId || a.ownerId === userId
            return (
              <li key={a.id}>
                <button
                  onClick={() => (mine ? setEditing(a) : undefined)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left md:px-3 desktop:py-2 ${mine ? 'hover:bg-surface-2/50' : 'cursor-default'}`}
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
                  <span className={`font-semibold tabular ${balance(a) < 0 ? 'text-critical-text' : ''}`}>
                    {money(balance(a))}
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
    </section>
  )
}

function AccountForm({ account, open, onClose }: { account?: Account; open: boolean; onClose: () => void }) {
  const { currency } = useApp()
  const { userId } = useSyncState()
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<Account['kind']>(account?.kind ?? 'current')
  const [visibility, setVisibility] = useState<AccountVisibility>(account?.visibility ?? 'shared')
  const [opening, setOpening] = useState(
    account?.openingBalanceMinor ? String(account.openingBalanceMinor / 100) : '',
  )
  const canSave = name.trim().length > 0

  const visOptions: AccountVisibility[] = ['shared', 'balance', 'private']

  async function save() {
    if (!canSave) return
    const openingMinor = parseAmount(opening) ?? 0
    if (account?.id) {
      await update('accounts', account.id, { name: name.trim(), kind, openingBalanceMinor: openingMinor })
      // Separate call: changing privacy has server-side consequences (the
      // household's visibility epoch bumps, and the partner re-pulls).
      await setAccountVisibility({ ...account, openingBalanceMinor: openingMinor }, visibility, userId)
    } else {
      await create('accounts', {
        name: name.trim(),
        kind,
        visibility,
        // A non-shared account needs an owner: it is who it is private *to*.
        ownerId: visibility === 'shared' ? undefined : userId,
        openingBalanceMinor: openingMinor,
        sortOrder: 0,
      })
    }
    onClose()
  }

  async function deleteAccount() {
    if (!account?.id) return
    const used = await db.transactions.where('accountId').equals(account.id).count()
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
    <Sheet
      open={open}
      onClose={onClose}
      title={account ? 'Edit account' : 'New account'}
      footer={
        <div className="flex gap-2">
          {account?.id && (
            <Button variant="danger" size="lg" onClick={deleteAccount}>
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
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
                key={o}
                className={`flex cursor-pointer items-start gap-3 rounded-xl px-4 py-3 ring-1 transition ${
                  visibility === o ? 'bg-accent/8 ring-accent' : 'bg-surface-2 ring-transparent'
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === o}
                  onChange={() => setVisibility(o)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-sm font-medium">{VISIBILITY_LABEL[o]}</span>
                  <span className="block text-xs text-ink-3">{VISIBILITY_HINT[o]}</span>
                </span>
              </label>
            ))}
          </div>
          {visibility === 'balance' && (
            <p className="mt-2 text-xs text-ink-3">
              A balance is still a number they can watch change, so this hides what you spent it on rather than how
              much you have.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  )
}

function CategoryForm({ category, open, onClose }: { category?: Category; open: boolean; onClose: () => void }) {
  const existing = useCategories()
  const { userId } = useSyncState()
  const catMap = useMemo(() => new Map(existing.map((c) => [c.id, c])), [existing])
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState<string | undefined>(category?.icon)
  const [kind, setKind] = useState<'expense' | 'income'>(category?.kind ?? 'expense')
  const [slot, setSlot] = useState<number | null>(category?.slot ?? null)
  const [parentId, setParentId] = useState<string | undefined>(category?.parentId)
  const [personal, setPersonal] = useState(!!category?.ownerId)
  const canSave = name.trim().length > 0

  // Only a top-level category of the same kind can be a parent, and a category
  // that already has children of its own cannot become one.
  const hasChildren = existing.some((c) => c.parentId === category?.id)
  const parentOptions = topLevel(existing).filter((c) => c.kind === kind && c.id !== category?.id)
  const parent = parentId ? catMap.get(parentId) : undefined

  // A new top-level category defaults to whichever colour is least used, so it
  // is visually distinct from what is already there. A subcategory instead
  // shows its parent's, and stores nothing — which is what keeps the two in
  // step when the parent changes later.
  const autoSlot = nextFreeSlot(existing.map((c) => c.slot).filter((n): n is number => n != null))
  const inherited = parent ? styleOf(parent, catMap) : undefined
  const effectiveSlot = slot ?? inherited?.slot ?? autoSlot
  const effectiveIcon = icon ?? inherited?.icon ?? 'tag'
  const overriding = parentId != null && (icon != null || slot != null)

  async function save() {
    if (!canSave) return
    // Null icon and slot mean "inherit"; only send values when this is a
    // top-level category or the user has deliberately overridden them.
    const style = parentId && !overriding ? { icon: undefined, slot: undefined } : { icon: effectiveIcon, slot: effectiveSlot }
    if (category?.id) {
      await update('categories', category.id, {
        name: name.trim(),
        parentId,
        ownerId: personal ? userId : undefined,
        ...style,
      })
    } else {
      const count = await db.categories.count()
      await create('categories', {
        name: name.trim(),
        kind,
        sortOrder: count,
        parentId,
        ownerId: personal ? userId : undefined,
        ...style,
      })
    }
    onClose()
  }

  async function deleteCategory() {
    if (!category?.id) return
    const used = await db.transactions.where('categoryId').equals(category.id).count()
    if (used > 0) {
      alert(`"${category.name}" is used by ${used} transactions, so it can't be deleted. Recategorise them first.`)
      return
    }
    if (confirm(`Delete category "${category.name}"?`)) {
      const budgets = await db.budgets.where('categoryId').equals(category.id).toArray()
      for (const b of budgets) await removeRow('budgets', b.id)
      await removeRow('categories', category.id)
      onClose()
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={category ? 'Edit category' : 'New category'}
      footer={
        <div className="flex gap-2">
          {category?.id && (
            <Button variant="danger" size="lg" onClick={deleteCategory}>
              Delete
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Live preview — the icon and colour the category will actually wear. */}
        <div className="flex items-center gap-3">
          <CategoryDot category={{ icon: effectiveIcon, slot: effectiveSlot } as Category} size={44} />
          <div className="min-w-0 flex-1">
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pets" autoFocus />
            </Field>
          </div>
        </div>

        {!hasChildren && (
          <Field
            label="Part of"
            hint={parentId ? "It takes its parent's colour and icon, and its spending counts towards their budget." : undefined}
          >
            <Select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || undefined)}>
              <option value="">Nothing — this is a top-level category</option>
              {parentOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {userId && (
          <label className="flex items-start gap-3 rounded-xl bg-surface-2 px-4 py-3">
            <input
              type="checkbox"
              checked={personal}
              onChange={(e) => setPersonal(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-medium">Keep this to myself</span>
              <span className="block text-xs text-ink-3">
                Your partner won't see it, and it can only be used on your own private accounts.
              </span>
            </span>
          </label>
        )}

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs">
            Colour
            {parentId && !overriding && <span className="ml-1.5 font-normal text-ink-3">· inherited</span>}
          </span>
          <div className="flex flex-wrap gap-2">
            {SLOTS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSlot(s)}
                title={SLOT_NAMES[s]}
                aria-label={SLOT_NAMES[s]}
                aria-pressed={effectiveSlot === s}
                className={cx(
                  'grid size-8 place-items-center rounded-full transition desktop:size-7',
                  effectiveSlot === s ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'hover:scale-110',
                )}
                style={{ background: slotVar(s) }}
              >
                {effectiveSlot === s && <Check size={15} className="text-white drop-shadow" />}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2 md:mb-1 md:text-xs">
            Icon
            {parentId && !overriding && <span className="ml-1.5 font-normal text-ink-3">· inherited</span>}
          </span>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10">
            {CATEGORY_ICON_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setIcon(key)}
                aria-label={key}
                aria-pressed={icon === key}
                className={cx(
                  'grid aspect-square place-items-center rounded-xl ring-1 transition md:rounded-lg',
                  icon === key ? 'ring-2 ring-ink' : 'bg-surface-2 text-ink-2 ring-transparent hover:ring-hairline',
                )}
                style={
                  icon === key
                    ? { background: `color-mix(in oklab, ${slotVar(effectiveSlot)} 16%, var(--surface-2))`, color: slotVar(effectiveSlot) }
                    : undefined
                }
              >
                <CategoryIcon icon={key} size={17} />
              </button>
            ))}
          </div>
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
      </div>
    </Sheet>
  )
}

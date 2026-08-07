import { useMemo, useRef, useState } from 'react'
import { Sun, Moon, MonitorSmartphone, Download, Upload, Trash2, Sparkles, Plus, Cloud, CloudOff, RefreshCw, LogOut, Copy, Lock, Eye, Check, AlertTriangle, ChevronRight } from 'lucide-react'
import { db, type Category, type Account, type GrantLevel, type HouseholdMember } from '../lib/db'
import { create, update, remove as removeRow } from '../lib/data'
import {
  balanceOf,
  canAddTransactions,
  canAdministerAccount,
  canManageAccount,
  canSeeTransactionsAt,
  deleteAccount as removeAccount,
  levelOn,
  setAccountLevel,
  transactionsOn,
  LEVELS,
  LEVEL_LABEL,
  LEVEL_HINT,
} from '../lib/accounts'
import {
  useAccounts,
  useAllTransactions,
  useCategories,
  useDeadLetters,
  useGrantsFor,
  useIsAdmin,
  useMembers,
  useMyLevels,
  useRemoteBalances,
  useRules,
} from '../lib/cache'
import { grouped, styleOf, topLevel } from '../lib/categories'
import { discardAllDeadLetters, discardDeadLetter, retryDeadLetter } from '../lib/outbox'
import { parseAmount, CURRENCIES, currencySymbol } from '../lib/money'
import { exportJSON, downloadJSON, importJSON, clearAllData } from '../lib/backup'
import { SLOTS, SLOT_NAMES, slotVar, nextFreeSlot } from '../lib/palette'
import { seedDemoData } from '../lib/demo'
import { signOut, joinHousehold, leaveHousehold, syncNow } from '../lib/session'
import { rpc } from '../lib/api'
import { useSyncState } from '../hooks/useSync'
import { useApp } from '../state/AppContext'
import { Card, Chip, Columns, SectionTitle, Segmented, Select, Button, Sheet, Field, TextInput, CategoryDot, useColumnCount, cx } from '../components/ui'
import { CategoryIcon, CATEGORY_ICON_KEYS } from '../components/CategoryIcon'
import { PersonDot, nameOf } from '../components/PersonDot'

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
            <p className="text-xs text-ink-3">Invite code — share it with anyone you want in this household</p>
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
          Enter someone's invite code to share a household with them. Accounts you own come with you; anything you
          only had access to stays behind, and anything not yet saved is discarded.
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
              if (confirm('Joining replaces this device\u2019s data with that household\u2019s. Continue?')) {
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
/** One column on a phone or laptop, two at xl, three on a wide monitor. */
const COLUMN_STEPS: [number, number][] = [[1280, 2], [1536, 3]]

function UnsavedChanges() {
  const deadLetters = useDeadLetters()
  if (deadLetters.length === 0) return null
  return (
    <section>
      {/* A literal apostrophe: `\u2019` is an escape in a JS string but plain text in JSX. */}
      <SectionTitle
        action={
          <button
            onClick={() => {
              if (confirm(`Discard ${deadLetters.length} change${deadLetters.length === 1 ? '' : 's'} that could not be saved?`)) {
                void discardAllDeadLetters()
              }
            }}
            className="text-sm font-medium text-accent"
          >
            Discard all
          </button>
        }
      >
        Couldn’t be saved
      </SectionTitle>
      <Card className="space-y-3 p-4 md:p-3">
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          These changes were rejected by the server. Usually it means the thing they referred to was deleted on another
          device. “Try again” re-sends the same change, so when the server objected to the change itself, discarding is
          the only way out.
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
  const [demoOpen, setDemoOpen] = useState(false)
  const columnCount = useColumnCount(COLUMN_STEPS)
  const fileRef = useRef<HTMLInputElement>(null)

  // Settings are independent blocks, so on a wide screen they flow into columns
  // rather than one long ribbon down the left edge. `Columns` rather than CSS
  // `columns`, because Safari fragments cards across a column boundary there
  // whatever `break-inside` says.
  //
  // The gap between sections lives here too. It used to come from a top margin
  // on SectionTitle, which stopped working the day each section was wrapped in
  // its own element — see SectionTitle.
  return (
    <>
    <Columns count={columnCount} gap="gap-6 md:gap-5" className="max-w-2xl xl:max-w-none">
      <section>
        <SectionTitle>Household</SectionTitle>
        <HouseholdCard />
      </section>

      <section>
        <SectionTitle>People</SectionTitle>
        <MembersCard />
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
          <Button variant="subtle" onClick={() => setDemoOpen(true)}>
            <Sparkles size={15} /> Load demo data
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (
                confirm(
                  'Delete every account you own and everything on it, along with your own budgets, goals and categories, and the household\u2019s shared ones? Accounts other people own are untouched, and so is anything private to them. Export a backup first if you want a copy.',
                ) &&
                confirm('Really erase everything of yours? This cannot be undone.')
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
      </Columns>

      {/* Modals live outside the columns — they are not blocks on the page. */}
      <CategoryForm
        key={editingCat === 'new' ? 'new' : (editingCat?.id ?? 'closed')}
        category={editingCat === 'new' ? undefined : (editingCat ?? undefined)}
        open={editingCat !== null}
        onClose={() => setEditingCat(null)}
      />

      <DemoDataForm open={demoOpen} onClose={() => setDemoOpen(false)} />
    </>
  )
}


/**
 * Everyone in the household, and what an admin may do about them.
 *
 * An admin manages PEOPLE and nothing else — they gain no access to any account
 * they were not granted, which is why nothing here touches an account directly.
 * The one exception is removal, and that is spelled out on its own screen
 * before it happens.
 */
function MembersCard() {
  const { userId } = useSyncState()
  const members = useMembers()
  const isAdmin = useIsAdmin()
  // The open member is held as an ID and looked up live, never copied into
  // state. Changing a role bumps the visibility epoch, which drops the whole
  // cache and re-pulls; a captured object would survive that as a stale render
  // showing the value you had just changed away from.
  const [openId, setOpenId] = useState<string | null>(null)
  const open = members.find((m) => m.userId === openId)

  const me = members.find((m) => m.userId === userId)

  return (
    <>
      {me && <YouCard me={me} />}
      {members.length === 0 ? (
        <Card className="p-4 md:p-3">
          <p className="text-sm text-ink-3">
            Your household list has not synced yet. It will appear once you are back online.
          </p>
        </Card>
      ) : (
      <Card>
        <ul className="divide-y divide-hairline">
          {members.map((m) => (
            <li key={m.userId}>
              <button
                onClick={() => setOpenId(m.userId)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/50 md:px-3 desktop:py-2"
              >
                <PersonDot member={m} size={32} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {nameOf(m)}
                  {m.userId === userId && <span className="ml-1.5 text-sm font-normal text-ink-3">you</span>}
                </span>
                {m.role === 'admin' && <Chip tone="accent">Admin</Chip>}
                <ChevronRight size={16} className="shrink-0 text-ink-3" />
              </button>
            </li>
          ))}
        </ul>
      </Card>
      )}
      {members.length === 1 && (
        <p className="mt-2 px-1 text-xs text-ink-3">
          Share your invite code above to bring somebody in. Nothing of yours becomes visible to them until you
          share an account with them.
        </p>
      )}
      {/* Kept mounted across a cache rebuild: the sheet reads whichever row is
          current, so a role change updates it in place instead of closing and
          flashing back with the old value. */}
      {open && (
        <MemberSheet
          key={open.userId}
          member={open}
          isAdmin={isAdmin}
          isMe={open.userId === userId}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  )
}


/**
 * Your own name and picture.
 *
 * Both are optional in the sense that Hearth works without them, but a
 * household where everybody is "Someone" makes every permissions screen
 * useless, so the name is always set to *something* — the server backfills it
 * from your email address, and this is where you change it to what you would
 * rather be called.
 *
 * The picture is downscaled here, in the browser, and stored on the row rather
 * than in a bucket. At the size it is ever displayed that is a few kilobytes,
 * which is cheaper than the infrastructure and its extra failure mode.
 */
function YouCard({ me }: { me: HouseholdMember }) {
  const [name, setName] = useState(nameOf(me))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const fileRef = useRef<HTMLInputElement>(null)

  async function save(patch: { name?: string; avatar?: string }) {
    setBusy(true)
    setError(undefined)
    try {
      await rpc('set_profile', { p_name: patch.name ?? null, p_avatar: patch.avatar ?? null })
      await syncNow()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved')
    }
    setBusy(false)
  }

  async function pickPhoto(file: File) {
    try {
      const dataUrl = await downscaleImage(file, 96)
      await save({ avatar: dataUrl })
    } catch {
      setError('That image could not be read')
    }
  }

  return (
    <Card className="mb-3 space-y-3 p-4 md:mb-2.5 md:p-3">
      <div className="flex items-center gap-3">
        <PersonDot member={me} size={48} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-3">This is how you appear to everyone else</p>
          <TextInput
            className="mt-1"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const trimmed = name.trim()
              if (!trimmed) {
                setName(nameOf(me))
                return
              }
              if (trimmed !== nameOf(me)) void save({ name: trimmed })
            }}
            placeholder="Your name"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void pickPhoto(file)
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="subtle" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> {me.avatarUrl ? 'Change photo' : 'Add a photo'}
        </Button>
        {me.avatarUrl && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save({ avatar: '' })}>
            Remove photo
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-critical-text">{error}</p>}
    </Card>
  )
}

/**
 * Square-crop and shrink an image to `size` px, as a JPEG data URL.
 *
 * Done here rather than server-side because the alternative is uploading a
 * 4MB phone photo to store 4KB of it.
 */
async function downscaleImage(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  )
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}

interface DeparturePreviewRow {
  account_id: string
  account_name: string
  outcome: 'leaves_with_them' | 'stays_with_others' | 'loses_access'
}

function MemberSheet({
  member,
  isAdmin,
  isMe,
  onClose,
}: {
  member: HouseholdMember
  isAdmin: boolean
  isMe: boolean
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [preview, setPreview] = useState<DeparturePreviewRow[] | null>(null)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      await syncNow()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    }
    setBusy(false)
  }

  const name = nameOf(member)

  return (
    <Sheet open onClose={onClose} title={nameOf(member)}>
      <div className="space-y-4">
        {isAdmin && !isMe && (
          <Field
            label="Role"
            hint="Admins can invite and remove people, and reset the invite code. It gives them no access to any account."
          >
            <Segmented
              value={member.role}
              onChange={(role) => void run(() => rpc('set_member_role', { p_user_id: member.userId, p_role: role }))}
              options={[
                { value: 'member', label: 'Member' },
                { value: 'admin', label: 'Admin' },
              ]}
            />
          </Field>
        )}

        {error && <p className="text-sm text-critical-text">{error}</p>}

        {isAdmin && !isMe && !preview && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // Ask the server what would happen rather than guessing from
                // this device's cache, which cannot see accounts it holds no
                // grant on — exactly the accounts most affected.
                const rows = await rpc<DeparturePreviewRow[]>('preview_departure', { p_user_id: member.userId })
                setPreview(rows ?? [])
              })
            }
          >
            <Trash2 size={15} /> Remove from the household
          </Button>
        )}

        {preview && (
          <div className="space-y-3">
            <p className="text-sm font-medium">If you remove {name}:</p>
            <DepartureGroup
              title={`${name} takes these with them`}
              hint="They are the only owner, so it disappears from your list."
              rows={preview.filter((r) => r.outcome === 'leaves_with_them')}
            />
            <DepartureGroup
              title="These stay with you"
              hint={`Somebody else owns them too, so ${name} simply loses access.`}
              rows={preview.filter((r) => r.outcome === 'stays_with_others')}
            />
            <DepartureGroup
              title={`${name} loses access to these`}
              hint="They were never an owner of them."
              rows={preview.filter((r) => r.outcome === 'loses_access')}
            />
            <p className="text-xs text-ink-3">
              Anything {name} recorded on an account that stays here stays here too, under their name. They keep a
              copy of the category names so their own history still reads properly.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await rpc('remove_member', { p_user_id: member.userId })
                    onClose()
                  })
                }
              >
                {busy ? 'Removing…' : `Remove ${name}`}
              </Button>
            </div>
          </div>
        )}

        {!isAdmin && (
          <p className="text-sm text-ink-3">
            Only an admin can change roles or remove somebody from the household.
          </p>
        )}
      </div>
    </Sheet>
  )
}

function DepartureGroup({ title, hint, rows }: { title: string; hint: string; rows: DeparturePreviewRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="rounded-xl bg-surface-2 px-4 py-3">
      <p className="text-sm font-medium">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.account_id} className="text-sm text-ink-2">
            {r.account_name}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-3">{hint}</p>
    </div>
  )
}

function AccountsSection() {
  const { money } = useApp()
  const accounts = useAccounts()
  const txns = useAllTransactions() ?? []
  const remoteBalances = useRemoteBalances()
  const levels = useMyLevels()
  const [editing, setEditing] = useState<Account | 'new' | null>(null)

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
            const level = levelOn(a.id, levels)
            // Opening the edit sheet needs `manage`, the same bar as the
            // accounts_update policy. Below that there is nothing to edit, so
            // the row is a read-only line rather than a dead button.
            const editable = canManageAccount(level)
            return (
              <li key={a.id}>
                <button
                  onClick={() => (editable ? setEditing(a) : undefined)}
                  className={cx(
                    'flex w-full items-center gap-3 px-4 py-3 text-left md:px-3 desktop:py-2',
                    editable ? 'hover:bg-surface-2/50' : 'cursor-default',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-medium">
                      {a.name}
                      {/* The eye means the total is all you get: no line items,
                          so no Activity, no reports, no budget contribution. */}
                      {!canSeeTransactionsAt(level) && <Eye size={13} className="text-ink-3" />}
                    </p>
                    <p className="flex items-center gap-1.5 text-sm text-ink-3">
                      {a.kind}
                      {level !== 'owner' && <Chip>{LEVEL_LABEL[level]}</Chip>}
                    </p>
                  </div>
                  <span className={cx('font-semibold tabular', balanceOf(a, txns, remoteBalances, level) < 0 && 'text-critical-text')}>
                    {money(balanceOf(a, txns, remoteBalances, level))}
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

/**
 * Who can see one account, and at what level.
 *
 * A `Select` per person rather than the stack of radio cards the old
 * three-way visibility picker used: six levels times however many people is an
 * enormous scroll on a phone, and the explanation belongs behind a disclosure
 * rather than repeated on every row.
 *
 * Only an owner may change anything here — `upsert_account_grant` refuses
 * otherwise — so for everybody else this is a read-only summary.
 */
function AccountAccessSheet({ account, open, onClose }: { account: Account; open: boolean; onClose: () => void }) {
  const { userId } = useSyncState()
  const members = useMembers()
  const grants = useGrantsFor(account.id)
  const levels = useMyLevels()
  const mayShare = canAdministerAccount(levelOn(account.id, levels))
  const [error, setError] = useState<{ userId: string; message: string } | null>(null)

  const levelFor = (uid: string): GrantLevel =>
    (grants.find((g) => g.userId === uid)?.level as GrantLevel | undefined) ?? 'none'

  const owners = grants.filter((g) => g.level === 'owner')

  async function change(uid: string, next: GrantLevel) {
    setError(null)
    // The server refuses to leave an account with no owner. Saying so here,
    // against the row that caused it, beats an alert that has lost the context.
    if (next !== 'owner' && levelFor(uid) === 'owner' && owners.length <= 1) {
      setError({ userId: uid, message: 'An account must always have an owner. Make somebody else an owner first.' })
      return
    }
    await setAccountLevel(account.id, uid, next, grants.find((g) => g.userId === uid))
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Who can see ${account.name}`}>
      <div className="space-y-4">
        {!mayShare && (
          <p className="text-sm text-ink-3">
            Only an owner of this account can change who sees it.
          </p>
        )}
        <ul className="divide-y divide-hairline">
          {members.map((m) => {
            const level = levelFor(m.userId)
            return (
              <li key={m.userId} className="py-2.5">
                <div className="flex items-center gap-3">
                  <PersonDot member={m} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {nameOf(m)}
                    {m.userId === userId && <span className="ml-1.5 text-xs font-normal text-ink-3">you</span>}
                  </span>
                  {mayShare ? (
                    <Select
                      className="w-40"
                      value={level}
                      onChange={(e) => void change(m.userId, e.target.value as GrantLevel)}
                    >
                      {LEVELS.map((l) => (
                        <option key={l} value={l}>
                          {LEVEL_LABEL[l]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Chip>{LEVEL_LABEL[level]}</Chip>
                  )}
                </div>
                {error?.userId === m.userId && (
                  <p className="mt-1.5 text-xs text-critical-text">{error.message}</p>
                )}
              </li>
            )
          })}
        </ul>

        {members.length === 1 && (
          <p className="text-sm text-ink-3">
            Nobody else is in your household yet. Invite someone from the People section and they will appear here.
          </p>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-ink-3 hover:text-ink-2">What these mean</summary>
          <dl className="mt-2 space-y-2">
            {LEVELS.map((l) => (
              <div key={l}>
                <dt className="text-sm font-medium">{LEVEL_LABEL[l]}</dt>
                <dd className="text-xs text-ink-3">{LEVEL_HINT[l]}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </Sheet>
  )
}

/**
 * Where should six months of fake spending go?
 *
 * Asking is the whole point. This used to pick `db.accounts.toArray()[0]` —
 * whichever row Dexie happened to return first, which is primary-key order over
 * random uuids. In a household with a private account that meant demo data
 * landing in someone's personal account, unpredictably and with no way to say
 * otherwise. Only accounts you can actually record against are offered, matching
 * every other account picker in the app.
 */
function DemoDataForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const allAccounts = useAccounts()
  const levels = useMyLevels()
  const accounts = useMemo(
    () => allAccounts.filter((a) => canAddTransactions(levelOn(a.id, levels))),
    [allAccounts, levels],
  )
  // Default to one you own outright: demo data is for having a look around, and
  // an account you control is the least surprising place for it to appear.
  const preferred = accounts.find((a) => levelOn(a.id, levels) === 'owner') ?? accounts[0]
  const [accountId, setAccountId] = useState<string | undefined>(preferred?.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const chosen = accountId ?? preferred?.id

  async function load() {
    if (!chosen) return
    setBusy(true)
    setError(undefined)
    try {
      await seedDemoData(chosen)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Demo data could not be loaded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Load demo data"
      footer={
        <Button size="lg" className="flex-1" disabled={!chosen || busy} onClick={load}>
          {busy ? 'Loading…' : 'Load demo data'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          Adds six months of example transactions, bills and budgets so you can see how Hearth looks with data in it.
          It is added to the account you pick, and syncs to your household like anything else.
        </p>
        <Field label="Add it to" hint="Only accounts you can record against are listed.">
          <Select value={chosen ?? ''} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {levelOn(a.id, levels) !== 'owner' ? ` · ${LEVEL_LABEL[levelOn(a.id, levels)].toLowerCase()}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {accounts.length === 0 && (
          <p className="text-sm text-critical-text">You need an account before demo data has somewhere to go.</p>
        )}
        {error && <p className="text-sm text-critical-text">{error}</p>}
      </div>
    </Sheet>
  )
}

function AccountForm({ account, open, onClose }: { account?: Account; open: boolean; onClose: () => void }) {
  const { currency } = useApp()
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<Account['kind']>(account?.kind ?? 'current')
  const [sharing, setSharing] = useState(false)
  const [opening, setOpening] = useState(
    account?.openingBalanceMinor ? String(account.openingBalanceMinor / 100) : '',
  )
  const [deleting, setDeleting] = useState(false)
  const levels = useMyLevels()
  const grants = useGrantsFor(account?.id)
  const canDelete = !!account && canAdministerAccount(levelOn(account.id, levels))
  const canSave = name.trim().length > 0

  // Everyone with any access, so the row can say "3 people" without opening it.
  const sharedWith = grants.length

  async function save() {
    if (!canSave) return
    const openingMinor = parseAmount(opening) ?? 0
    if (account?.id) {
      await update('accounts', account.id, { name: name.trim(), kind, openingBalanceMinor: openingMinor })
    } else {
      // Nothing about sharing is decided here. Creating an account makes you
      // its owner (a server trigger writes the grant), and who else can see it
      // is a separate, deliberate step.
      await create('accounts', {
        name: name.trim(),
        kind,
        openingBalanceMinor: openingMinor,
        sortOrder: 0,
      })
    }
    onClose()
  }

  /**
   * Deleting one account, rather than the all-or-nothing "erase everything".
   *
   * The count comes from this device's cache, so it is what to WARN with, never
   * what to act on: the server counts again and refuses if it disagrees, which is
   * the case where a partner has recorded something this device has not pulled yet.
   */
  async function deleteAccount() {
    if (!account?.id) return
    const used = await transactionsOn(account.id)
    const warning =
      used > 0
        ? `Delete "${account.name}" and the ${used} transaction${used === 1 ? '' : 's'} on it? They disappear from your reports and budgets too. This cannot be undone.`
        : `Delete account "${account.name}"? This cannot be undone.`
    if (!confirm(warning)) return

    setDeleting(true)
    try {
      await removeAccount(account.id, used > 0)
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'That account could not be deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={account ? 'Edit account' : 'New account'}
      footer={
        <div className="flex gap-2">
          {canDelete && (
            <Button variant="danger" size="lg" disabled={deleting} onClick={deleteAccount}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
          <Button size="lg" className="flex-1" disabled={!canSave || deleting} onClick={save}>
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
        {account && (
          <button
            type="button"
            onClick={() => setSharing(true)}
            className="flex w-full items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/70"
          >
            <span className="flex-1 text-sm font-medium text-ink-2">Who can see it?</span>
            <span className="text-sm text-ink-3">
              {sharedWith === 1 ? 'Only you' : `${sharedWith} people`}
            </span>
            <ChevronRight size={16} className="text-ink-3" />
          </button>
        )}
        {!account && (
          <p className="text-sm text-ink-3">
            It starts as yours alone. Once it exists you can choose who else sees it, and how much.
          </p>
        )}
      </div>
      {account && (
        <AccountAccessSheet account={account} open={sharing} onClose={() => setSharing(false)} />
      )}
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
                Nobody else sees it, and it can only be used on an account nobody else shares.
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

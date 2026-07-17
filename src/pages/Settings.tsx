import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Sun, Moon, MonitorSmartphone, Download, Upload, Trash2, Sparkles, Plus } from 'lucide-react'
import { db, type Category } from '../lib/db'
import { CURRENCIES } from '../lib/money'
import { exportJSON, downloadJSON, importJSON, clearAllData } from '../lib/backup'
import { seedDemoData } from '../lib/demo'
import { useApp } from '../state/AppContext'
import { Card, SectionTitle, Segmented, Select, Button, Sheet, Field, TextInput, CategoryDot } from '../components/ui'

export default function SettingsPage() {
  const { themePref, setThemePref, currency, setCurrency } = useApp()
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), []) ?? []
  const rules = useLiveQuery(async () => (await db.rules.toArray()).sort((a, b) => b.createdAt - a.createdAt), []) ?? []
  const [editingCat, setEditingCat] = useState<Category | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="max-w-2xl">
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
                <button onClick={() => db.rules.delete(r.id!)} aria-label={`Forget rule ${r.match}`} className="text-ink-3 hover:text-critical-text">
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
          Everything lives privately on this device. To share with your partner or move to a new device, export a backup
          and import it there. Do it after big updates — it takes two taps.
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
        Hearth · a private, offline-first family finance app. Install it from your browser's share / install menu for the
        full app experience.
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

function CategoryForm({ category, open, onClose }: { category?: Category; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? '')
  const [emoji, setEmoji] = useState(category?.emoji ?? '🏷️')
  const [kind, setKind] = useState<'expense' | 'income'>(category?.kind ?? 'expense')
  const canSave = name.trim().length > 0

  async function save() {
    if (!canSave) return
    if (category?.id) {
      await db.categories.update(category.id, { name: name.trim(), emoji: emoji.trim() || '🏷️' })
    } else {
      const count = await db.categories.count()
      await db.categories.add({
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
    const used = await db.transactions.where('categoryId').equals(category.id).count()
    if (used > 0) {
      alert(`"${category.name}" is used by ${used} transactions, so it can't be deleted. Recategorise them first.`)
      return
    }
    if (confirm(`Delete category "${category.name}"?`)) {
      await db.budgets.where('categoryId').equals(category.id).delete()
      await db.categories.delete(category.id)
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

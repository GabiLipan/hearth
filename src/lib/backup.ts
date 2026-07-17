import { db } from './db'

const TABLES = ['transactions', 'categories', 'budgets', 'bills', 'rules', 'accounts', 'kv'] as const

/** Full-household JSON snapshot — used for backup and for device-to-device transfer. */
export async function exportJSON(): Promise<string> {
  const dump: Record<string, unknown[]> = {}
  for (const name of TABLES) {
    dump[name] = await db.table(name).toArray()
  }
  return JSON.stringify({ app: 'hearth', version: 1, exportedAt: new Date().toISOString(), data: dump }, null, 2)
}

export function downloadJSON(json: string) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hearth-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** Replace everything with a snapshot's contents. */
export async function importJSON(text: string) {
  const parsed = JSON.parse(text)
  if (parsed?.app !== 'hearth' || !parsed.data) throw new Error('Not a Hearth backup file')
  await db.transaction('rw', db.tables, async () => {
    for (const name of TABLES) {
      await db.table(name).clear()
      const rows = parsed.data[name]
      if (Array.isArray(rows) && rows.length) await db.table(name).bulkPut(rows)
    }
  })
}

export async function clearAllData() {
  await db.transaction('rw', db.tables, async () => {
    for (const name of TABLES) await db.table(name).clear()
  })
}

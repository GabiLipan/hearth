import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { db, rowKey, SYNCED_TABLES, type SyncedTable } from './db'
import { fromDb, type DbRow } from './mapping'
import { pendingKeys } from './outbox'

/**
 * Live updates from the other device.
 *
 * Two rules, both learned from the previous implementation:
 *
 *  1. **A realtime event never advances the pull cursor.** The old code moved
 *     the cursor to whatever record arrived, so an event landing while a
 *     backlog was still being fetched skipped everything older than it —
 *     permanently. Events here only write rows; the cursor belongs to the pull.
 *
 *  2. **A gap in the stream means re-pull.** Supabase Realtime has no replay,
 *     so anything that happened while the socket was down is simply not
 *     delivered. Every reconnection therefore triggers a delta pull rather than
 *     assuming the stream is complete.
 *
 * Note that a row the subscriber is not allowed to see produces no event at
 * all — RLS is evaluated per subscriber. That is why account visibility changes
 * are handled by the epoch on `households` instead of by watching for a
 * deletion that will never arrive.
 */

let channel: RealtimeChannel | null = null
let onGap: (() => void) | undefined
let onEpochChange: (() => void) | undefined

export function setRealtimeHandlers(handlers: { onGap: () => void; onEpochChange: () => void }) {
  onGap = handlers.onGap
  onEpochChange = handlers.onEpochChange
}

async function applyLive(table: SyncedTable, row: DbRow) {
  // An unsent local edit outranks the server's copy until it has been pushed;
  // overwriting it here is how the old sync used to lose in-flight changes.
  const pending = await pendingKeys()
  if (pending.has(rowKey(table, row.id))) return

  const cache = db.table(table)
  if (row.deleted_at) await cache.delete(row.id)
  else await cache.put(fromDb(row))
}

export function startRealtime(householdId: string) {
  stopRealtime()

  const filter = `household_id=eq.${householdId}`
  channel = supabase.channel(`hearth:${householdId}`)

  for (const table of SYNCED_TABLES) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter },
      (payload) => {
        const row = payload.new as DbRow | undefined
        if (row?.id) void applyLive(table, row)
      },
    )
  }

  // The household row carries `visibility_epoch`. It is the only signal a
  // partner gets when an account's privacy changes, because the rows that
  // became invisible cannot report their own disappearance.
  channel = channel.on(
    'postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'households', filter: `id=eq.${householdId}` },
    () => onEpochChange?.(),
  )

  channel.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      // Whatever happened while we were not listening is unrecoverable from the
      // stream, so fall back to a pull.
      onGap?.()
    }
  })
}

export function stopRealtime() {
  if (channel) {
    void supabase.removeChannel(channel)
    channel = null
  }
}

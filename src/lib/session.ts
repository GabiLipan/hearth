import { db, clearEverything, getSetting, setSetting } from './db'
import { cacheMonthRule, ruleFromRemote } from './monthRule'
import { supabase } from './supabase'
import { fetchHousehold, rpc, type RemoteHousehold } from './api'
import { countDeadLetters, countPending, flush, scheduleFlush, setCanFlush, setOnOutboxChange } from './outbox'
import { pull } from './pull'
import { setRealtimeHandlers, startRealtime, stopRealtime } from './realtime'

/**
 * Session, household and sync orchestration.
 *
 * Replaces the old `sync.ts`. The important behavioural change is that this
 * device is no longer authoritative about anything: it signs in, finds out
 * which household it belongs to, and from then on pushes its queue and pulls
 * the server's answer. It never seeds, never merges, never decides a winner.
 */

export interface SyncState {
  /** Auth has been resolved far enough to decide what to render. */
  ready: boolean
  email?: string
  userId?: string
  householdId?: string
  joinCode?: string
  /**
   * Who this device was last signed in as, persisted locally.
   *
   * The app gates on THIS rather than on a live session. Gating on a valid
   * session would show a login screen to someone opening the app on a plane —
   * exactly when they most want to see their cached data. A rejected refresh
   * token from a reachable server is what signs you out; being offline is not.
   */
  knownUser?: string
  online: boolean
  syncing: boolean
  lastSyncAt?: number
  /** Writes waiting to reach the server. */
  pending: number
  /** Writes the server refused; shown in Settings so they are not lost silently. */
  deadLetters: number
  /**
   * Arrived through a password-reset link, and has not chosen a new one yet.
   *
   * The link signs the device in, so without this the recovery would end with
   * somebody looking at their dashboard, still not knowing their password and
   * with no way to set one. The gate shows the "choose a new password" screen
   * while this is true.
   */
  recovering?: boolean
  error?: string
}

let state: SyncState = { ready: false, online: navigator.onLine, syncing: false, pending: 0, deadLetters: 0 }
const listeners = new Set<() => void>()

function set(partial: Partial<SyncState>) {
  state = { ...state, ...partial }
  listeners.forEach((l) => l())
}

export const syncStore = {
  getState: () => state,
  subscribe: (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}

async function refreshCounts() {
  const [pending, deadLetters] = await Promise.all([countPending(), countDeadLetters()])
  set({ pending, deadLetters })
}

/* ---------- auth ---------- */

export async function signUp(email: string, password: string) {
  // Send the confirmation link back to wherever the app is actually served —
  // the Pages URL in production, localhost in dev — rather than inheriting the
  // project's Site URL. Stripping the hash keeps HashRouter's route out of it.
  const emailRedirectTo = window.location.href.split('#')[0]
  const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } })
  if (error) throw new Error(error.message)
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
}

/**
 * The way back in.
 *
 * There was none: a forgotten password made the app a dead end, with the data
 * intact on the server and no route to it. The link comes back to wherever this
 * copy is served — the same reasoning as `signUp`'s `emailRedirectTo`, and the
 * hash is stripped for the same reason.
 *
 * It deliberately does not report whether the address is one we know. Telling a
 * stranger which emails have accounts is the one thing this endpoint must not
 * do, so the screen says "if that address has an account" and means it.
 */
export async function requestPasswordReset(email: string) {
  const redirectTo = window.location.href.split('#')[0]
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  if (error) throw new Error(error.message)
}

/**
 * Finish a recovery: the link has signed this device in, and now the password
 * behind it changes.
 *
 * Clearing `recovering` is what returns the app to its ordinary gate — by this
 * point there is a real session, so the household loads as usual.
 */
export async function setNewPassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw new Error(error.message)
  set({ recovering: false })
}

/**
 * Send the confirmation email again.
 *
 * Offered only when signing in has just failed *because* the address was never
 * confirmed — the one case where the right next step is an email rather than
 * another guess at the password.
 */
export async function resendConfirmation(email: string) {
  const emailRedirectTo = window.location.href.split('#')[0]
  const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo } })
  if (error) throw new Error(error.message)
}

/**
 * Signing out clears the cache as well as the session. The data belongs to the
 * account, not to the browser, and leaving a readable copy behind on a shared
 * machine would be a nasty surprise.
 */
export async function signOut() {
  stopRealtime()
  await supabase.auth.signOut()
  await clearEverything()
  set({
    email: undefined,
    userId: undefined,
    householdId: undefined,
    joinCode: undefined,
    knownUser: undefined,
    pending: 0,
    deadLetters: 0,
    error: undefined,
  })
}

/* ---------- household ---------- */

async function adopt(household: RemoteHousehold) {
  await setSetting('householdId', household.id)
  await setSetting('joinCode', household.join_code)
  await setSetting('currency', household.currency)
  await cacheMonthRule(ruleFromRemote(household))
  set({ householdId: household.id, joinCode: household.join_code })
  startRealtime(household.id)
}

export async function createHousehold(name?: string) {
  const household = await rpc<RemoteHousehold>('create_household', name ? { household_name: name } : {})
  await adopt(household)
  await syncNow({ full: true })
  return household
}

/**
 * Join a partner's household. Everything cached from the previous one is
 * dropped — including unsent writes, which belonged to a household this device
 * is leaving and could not be applied to the new one anyway.
 */
export async function joinHousehold(code: string) {
  const household = await rpc<RemoteHousehold>('join_household', { code })
  stopRealtime()
  await clearEverything()
  await adopt(household)
  if (state.userId) await setSetting('knownUser', state.userId)
  await syncNow({ full: true })
  return household
}

export async function leaveHousehold() {
  await rpc('leave_household')
  stopRealtime()
  await clearEverything()
  if (state.userId) await setSetting('knownUser', state.userId)
  set({ householdId: undefined, joinCode: undefined, pending: 0, deadLetters: 0 })
}

/* ---------- syncing ---------- */

let syncQueued = false

export async function syncNow({ full = false }: { full?: boolean } = {}) {
  if (!state.householdId || !state.online) return
  if (state.syncing) {
    syncQueued = true
    return
  }
  set({ syncing: true, error: undefined })
  try {
    // Push first: our changes should be on the server before we ask what the
    // server has, or we would pull a view that does not include them and
    // briefly render stale values over the user's own edits.
    await flush()
    await pull({ full })
    set({ syncing: false, lastSyncAt: Date.now(), error: undefined })
  } catch (e) {
    set({ syncing: false, error: e instanceof Error ? e.message : 'Sync failed' })
  }
  await refreshCounts()
  if (syncQueued) {
    syncQueued = false
    void syncNow()
  }
}

let syncTimer: ReturnType<typeof setTimeout> | undefined
export function queueSync(delay = 1500) {
  if (!state.householdId) return
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void syncNow(), delay)
}

/* ---------- boot ---------- */

export async function initSession() {
  setCanFlush(() => !!state.householdId && state.online)
  setOnOutboxChange(() => void refreshCounts())
  setRealtimeHandlers({
    onGap: () => queueSync(500),
    onEpochChange: () => void syncNow(),
  })

  // Render from cache before the network is consulted at all. An offline launch
  // must show the user's data, not a spinner and then a login screen.
  const [knownUser, householdId, joinCode] = await Promise.all([
    getSetting('knownUser'),
    getSetting('householdId'),
    getSetting('joinCode'),
  ])
  set({ knownUser, householdId, joinCode })
  await refreshCounts()
  if (householdId && knownUser) set({ ready: true })

  supabase.auth.onAuthStateChange((event, session) => {
    void (async () => {
      try {
        // Arriving on a recovery link. Raised before anything else, because
        // the same tick also carries a perfectly ordinary SIGNED_IN.
        if (event === 'PASSWORD_RECOVERY') set({ recovering: true })
        if (session?.user) {
          set({ email: session.user.email ?? undefined, userId: session.user.id })
          await setSetting('knownUser', session.user.id)
          set({ knownUser: session.user.id })

          // A different account on this device must not inherit the previous
          // one's cache.
          const cachedFor = await getSetting('cacheOwner')
          if (cachedFor && cachedFor !== session.user.id) {
            stopRealtime()
            await clearEverything()
            await setSetting('knownUser', session.user.id)
            set({ householdId: undefined, joinCode: undefined })
          }
          await setSetting('cacheOwner', session.user.id)

          const household = await fetchHousehold()
          if (household) {
            await adopt(household)
            await syncNow({ full: !state.lastSyncAt })
          } else {
            // No household yet — onboarding will offer create-or-join. This is
            // deliberately not automatic: silently creating one is how the old
            // client stranded a household full of data when the user then went
            // on to join their partner's.
            set({ householdId: undefined })
          }
        } else if (event === 'SIGNED_OUT') {
          stopRealtime()
          set({ email: undefined, userId: undefined, householdId: undefined, knownUser: undefined })
        }
      } catch (e) {
        set({ error: e instanceof Error ? e.message : 'Could not reach the server' })
      } finally {
        set({ ready: true })
      }
    })()
  })

  window.addEventListener('online', () => {
    set({ online: true })
    void scheduleFlush(200)
    queueSync(400)
  })
  window.addEventListener('offline', () => set({ online: false }))

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') queueSync(200)
  })

  setInterval(() => {
    if (document.visibilityState === 'visible') queueSync(0)
  }, 60_000)

  // Local changes poke the queue; the sync loop is what talks to the server.
  db.outbox.hook('creating', () => void scheduleFlush())
}

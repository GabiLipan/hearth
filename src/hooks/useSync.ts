import { useSyncExternalStore } from 'react'
import { syncStore, type SyncState } from '../lib/session'

export function useSyncState(): SyncState {
  return useSyncExternalStore(syncStore.subscribe, syncStore.getState)
}

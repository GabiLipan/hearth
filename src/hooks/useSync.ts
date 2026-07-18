import { useSyncExternalStore } from 'react'
import { syncStore, type SyncState } from '../lib/sync'

export function useSyncState(): SyncState {
  return useSyncExternalStore(syncStore.subscribe, syncStore.getState)
}

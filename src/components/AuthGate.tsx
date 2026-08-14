import type { ReactNode } from 'react'
import { useSyncState } from '../hooks/useSync'
import { isConfigured } from '../lib/supabase'
import { NewPassword, NotConfigured, Onboarding, Splash } from '../pages/Onboarding'

/**
 * Decides whether to show the app or the sign-in flow.
 *
 * The gate deliberately checks `knownUser` — a flag persisted on this device
 * once sign-in has succeeded — rather than whether there is a live session
 * right now. Checking for a live session would bounce someone to a login screen
 * the moment they opened the app on a plane, which is exactly when they most
 * want to see their cached data. Being offline is not being signed out.
 *
 * You leave only by signing out deliberately, or when a reachable server
 * rejects the refresh token.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, knownUser, householdId, recovering } = useSyncState()

  if (!isConfigured) return <NotConfigured />
  // Before `ready`, and before the household check: a recovery link signs the
  // device in, so every other branch here would happily show the app to
  // somebody who still does not know their password.
  if (recovering) return <NewPassword />
  if (!ready) return <Splash />
  if (!knownUser) return <Onboarding stage="auth" />
  if (!householdId) return <Onboarding stage="household" />
  return <>{children}</>
}

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * Whether the app has been pointed at a Supabase project yet. Checked by
 * AuthGate so a missing `.env` produces instructions rather than a white
 * screen — throwing here would take the whole bundle down at import time.
 */
export const isConfigured = Boolean(url && anonKey)

/**
 * The publishable key ships in the bundle by design. It names the project; it
 * does not grant access to anything. Every request carries the signed-in user's
 * token, and row level security decides per row what that user may see — see
 * supabase/02-rls.sql. A stranger with this key and no session gets an empty
 * result, not an error.
 *
 * The `service_role` key is the one that must never appear here, in the repo,
 * or in a build secret: it bypasses row level security entirely.
 */
export const supabase = createClient(url || 'https://unconfigured.invalid', anonKey || 'unconfigured', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

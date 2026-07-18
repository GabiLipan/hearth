import { createClient } from '@supabase/supabase-js'

// These identify the household's Supabase project. The publishable key is
// designed to ship in client bundles — data access is enforced by Row Level
// Security on the server, not by secrecy of this key.
export const SUPABASE_URL = 'https://mwcsglhtygpuvgdyjfpq.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_cmtPOngJ16UK9F9rggclFA_gTEfC5Ys'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

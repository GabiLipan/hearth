/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** When this bundle was built — see `define` in vite.config.ts. */
declare const __BUILT_AT__: string

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  readonly VITE_SUPABASE_URL: string
  /**
   * The publishable ("anon") key. This is not a secret and is meant to ship in
   * the bundle — it identifies the project, it does not grant access. Access is
   * decided by row level security against the signed-in user's token. The
   * `service_role` key is the one that must never appear here.
   */
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

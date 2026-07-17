import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, setSetting } from '../lib/db'
import { fmtMoney } from '../lib/money'

export type ThemePref = 'light' | 'dark' | 'system'

interface AppState {
  themePref: ThemePref
  setThemePref: (t: ThemePref) => void
  resolvedTheme: 'light' | 'dark'
  currency: string
  setCurrency: (c: string) => void
  money: (minor: number, opts?: { sign?: boolean; compact?: boolean; hideDecimals?: boolean }) => string
}

const Ctx = createContext<AppState | null>(null)

function systemDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [themePref, setThemePrefState] = useState<ThemePref>(
    () => (localStorage.getItem('hearth-theme') as ThemePref) || 'system',
  )
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  useEffect(() => {
    const apply = () => {
      const dark = themePref === 'dark' || (themePref === 'system' && systemDark())
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      setResolvedTheme(dark ? 'dark' : 'light')
      // Keep the browser chrome (PWA title bar) in step with the theme
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
      }
      meta.content = dark ? '#0d0d0d' : '#f9f9f7'
    }
    apply()
    if (themePref === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [themePref])

  const setThemePref = useCallback((t: ThemePref) => {
    localStorage.setItem('hearth-theme', t)
    setThemePrefState(t)
  }, [])

  const currency = useLiveQuery(async () => (await db.kv.get('currency'))?.value, [], undefined) ?? 'GBP'

  const setCurrency = useCallback((c: string) => {
    void setSetting('currency', c)
  }, [])

  const money = useCallback(
    (minor: number, opts?: { sign?: boolean; compact?: boolean; hideDecimals?: boolean }) =>
      fmtMoney(minor, currency, opts),
    [currency],
  )

  const value = useMemo(
    () => ({ themePref, setThemePref, resolvedTheme, currency, setCurrency, money }),
    [themePref, setThemePref, resolvedTheme, currency, setCurrency, money],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp outside provider')
  return ctx
}

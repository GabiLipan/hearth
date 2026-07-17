import { useMemo } from 'react'
import { useApp } from '../state/AppContext'

/**
 * Resolves the design-token CSS variables to concrete hex values for Recharts,
 * re-resolving whenever the theme flips.
 */
export function useChartColors() {
  const { resolvedTheme } = useApp()
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    return {
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
      slot: (n: number) => v(`--series-${((n - 1) % 8) + 1}`),
      grid: v('--grid'),
      baseline: v('--baseline'),
      ink: v('--ink'),
      ink2: v('--ink-2'),
      ink3: v('--ink-3'),
      surface: v('--surface'),
      accent: v('--accent'),
      good: v('--good'),
      critical: v('--critical'),
      theme: resolvedTheme,
    }
  }, [resolvedTheme])
}

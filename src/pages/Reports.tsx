import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronLeft, ChevronRight, Table2, ChartPie } from 'lucide-react'
import { db } from '../lib/db'
import { thisMonthKey, shiftMonth, monthLabel } from '../lib/dates'
import { spendByCategory, monthlySeries, monthTotals } from '../lib/stats'
import { useApp } from '../state/AppContext'
import { Card, Segmented, Empty } from '../components/ui'
import { CategoryDonut, SpendBars, IncomeSpendBars, NetLine } from '../components/charts'

export default function Reports() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [range, setRange] = useState<'6' | '12'>('6')
  const [view, setView] = useState<'charts' | 'table'>('charts')

  const txns = useLiveQuery(() => db.transactions.toArray(), [])
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? []

  const slices = useMemo(() => spendByCategory(txns ?? [], categories, month, 8), [txns, categories, month])
  const series = useMemo(() => monthlySeries(txns ?? [], categories, Number(range)), [txns, categories, range])
  const totals = useMemo(() => monthTotals(txns ?? [], month), [txns, month])

  if (txns && txns.length === 0) {
    return <Empty emoji="📊" title="Nothing to report yet" hint="Add or import some transactions and your charts will appear here." />
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={view}
          onChange={setView}
          className="w-44"
          options={[
            { value: 'charts', label: <span className="flex items-center justify-center gap-1"><ChartPie size={14} /> Charts</span> },
            { value: 'table', label: <span className="flex items-center justify-center gap-1"><Table2 size={14} /> Table</span> },
          ]}
        />
        <Segmented
          value={range}
          onChange={setRange}
          className="w-44"
          options={[
            { value: '6', label: '6 mo' },
            { value: '12', label: '12 mo' },
          ]}
        />
      </div>

      {/* Spending by category */}
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Spending by category</h3>
          <div className="flex items-center">
            <button className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-surface-2" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
              <ChevronLeft size={16} />
            </button>
            <span className="w-32 text-center text-sm font-medium">{monthLabel(month)}</span>
            <button
              className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-surface-2 disabled:opacity-30"
              aria-label="Next month"
              disabled={month >= thisMonthKey()}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        {slices.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-3">No spending recorded in {monthLabel(month)}.</p>
        ) : view === 'charts' ? (
          <CategoryDonut slices={slices} centerLabel={{ title: 'spent', value: money(totals.spend, { compact: true }) }} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-ink-3">
                <th className="py-2 font-medium">Category</th>
                <th className="py-2 text-right font-medium">Spent</th>
                <th className="py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {slices.map((s) => (
                <tr key={s.categoryId} className="border-b border-hairline last:border-0">
                  <td className="py-2">{s.emoji} {s.name}</td>
                  <td className="py-2 text-right tabular">{money(s.totalMinor)}</td>
                  <td className="py-2 text-right text-ink-3 tabular">{Math.round(s.fraction * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {view === 'charts' ? (
        <>
          <Card className="p-5">
            <h3 className="mb-3 font-semibold">Monthly spending</h3>
            <SpendBars data={series} />
          </Card>
          <Card className="p-5">
            <h3 className="mb-3 font-semibold">Income vs spending</h3>
            <IncomeSpendBars data={series} />
          </Card>
          <Card className="p-5">
            <h3 className="mb-1 font-semibold">Net each month</h3>
            <p className="mb-3 text-sm text-ink-3">Income minus spending — above the line means you saved.</p>
            <NetLine data={series} />
          </Card>
        </>
      ) : (
        <Card className="p-5">
          <h3 className="mb-3 font-semibold">Month by month</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-ink-3">
                  <th className="py-2 font-medium">Month</th>
                  <th className="py-2 text-right font-medium">Income</th>
                  <th className="py-2 text-right font-medium">Spending</th>
                  <th className="py-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {[...series].reverse().map((p) => (
                  <tr key={p.key} className="border-b border-hairline last:border-0">
                    <td className="py-2">{p.label}</td>
                    <td className="py-2 text-right tabular">{money(p.income)}</td>
                    <td className="py-2 text-right tabular">{money(p.spend)}</td>
                    <td className={`py-2 text-right font-medium tabular ${p.net < 0 ? 'text-critical-text' : 'text-good-text'}`}>
                      {money(p.net, { sign: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

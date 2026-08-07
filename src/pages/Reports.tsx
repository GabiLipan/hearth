import { useMemo, useState } from 'react'
import { Table2, ChartPie } from 'lucide-react'
import { useAllTransactions, useCategories } from '../lib/cache'
import { thisMonthKey, monthLabel } from '../lib/dates'
import { spendByCategory, monthlySeries, monthTotals } from '../lib/stats'
import { useApp } from '../state/AppContext'
import { Card, Segmented, Empty, Toolbar, MonthStepper, table, ScrollTable, cx } from '../components/ui'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryDonut, SpendBars, IncomeSpendBars, NetLine } from '../components/charts'

export default function Reports() {
  const { money } = useApp()
  const [month, setMonth] = useState(thisMonthKey())
  const [range, setRange] = useState<'6' | '12'>('6')
  const [view, setView] = useState<'charts' | 'table'>('charts')

  const txns = useAllTransactions()
  const categories = useCategories()

  const slices = useMemo(() => spendByCategory(txns ?? [], categories, month, 8), [txns, categories, month])
  const series = useMemo(() => monthlySeries(txns ?? [], categories, Number(range)), [txns, categories, range])
  const totals = useMemo(() => monthTotals(txns ?? [], month), [txns, month])

  if (txns && txns.length === 0) {
    return <Empty icon={ChartPie} title="Nothing to report yet" hint="Add or import some transactions and your charts will appear here." />
  }

  return (
    <div>
      <Toolbar>
        <Segmented
          value={view}
          onChange={setView}
          className="w-40"
          options={[
            { value: 'charts', label: <span className="flex items-center justify-center gap-1"><ChartPie size={14} /> Charts</span> },
            { value: 'table', label: <span className="flex items-center justify-center gap-1"><Table2 size={14} /> Table</span> },
          ]}
        />
        <Segmented
          value={range}
          onChange={setRange}
          className="w-36"
          options={[
            { value: '6', label: '6 mo' },
            { value: '12', label: '12 mo' },
          ]}
        />
        <MonthStepper month={month} onChange={setMonth} label={monthLabel} canGoForward={month < thisMonthKey()} />
      </Toolbar>

      {/* Charts sit side by side once there's width for them, rather than
          running down a single tall column. */}
      <div className="grid gap-3 md:gap-2.5 xl:grid-cols-2">
      {/* Spending by category */}
      <Card className="p-5 md:p-4 xl:col-span-2">
        <div className="mb-3 flex items-center justify-between md:mb-2">
          <h3 className="font-semibold md:text-sm">Spending by category · {monthLabel(month)}</h3>
        </div>
        {slices.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-3">No spending recorded in {monthLabel(month)}.</p>
        ) : view === 'charts' ? (
          <CategoryDonut slices={slices} centerLabel={{ title: 'spent', value: money(totals.spend, { compact: true }) }} />
        ) : (
          <ScrollTable minWidth={360}>
            <thead>
              <tr className={table.head}>
                <th className={cx(table.th, table.pinned)}>Category</th>
                <th className={cx(table.th, 'text-right')}>Spent</th>
                <th className={cx(table.th, 'text-right')}>Share</th>
              </tr>
            </thead>
            <tbody>
              {slices.map((s) => (
                <tr key={s.categoryId} className={table.row}>
                  <td className={cx(table.cell, table.pinned)}>
                    <span className="inline-flex items-center gap-2">
                      <span style={{ color: `var(--series-${s.slot})` }}>
                        <CategoryIcon icon={s.icon} size={15} />
                      </span>
                      {s.name}
                    </span>
                  </td>
                  <td className={cx(table.cell, 'text-right tabular')}>{money(s.totalMinor)}</td>
                  <td className={cx(table.cell, 'text-right text-ink-3 tabular')}>{Math.round(s.fraction * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Card>

      {view === 'charts' ? (
        <>
          <Card className="p-5 md:p-4">
            <h3 className="mb-3 font-semibold md:mb-2 md:text-sm">Monthly spending</h3>
            <SpendBars data={series} />
          </Card>
          <Card className="p-5 md:p-4">
            <h3 className="mb-3 font-semibold md:mb-2 md:text-sm">Income vs spending</h3>
            <IncomeSpendBars data={series} />
          </Card>
          <Card className="p-5 md:p-4 xl:col-span-2">
            <h3 className="mb-1 font-semibold md:text-sm">Net each month</h3>
            <p className="mb-3 text-sm text-ink-3 md:mb-2 md:text-xs">
              Income minus spending — above the line means you saved.
            </p>
            <NetLine data={series} />
          </Card>
        </>
      ) : (
        <Card className="p-5 md:p-4 xl:col-span-2">
          <h3 className="mb-3 font-semibold md:mb-2 md:text-sm">Month by month</h3>
          <ScrollTable minWidth={480}>
            <thead>
              <tr className={table.head}>
                <th className={cx(table.th, table.pinned)}>Month</th>
                <th className={cx(table.th, 'text-right')}>Income</th>
                <th className={cx(table.th, 'text-right')}>Spending</th>
                <th className={cx(table.th, 'text-right')}>Net</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((p) => (
                <tr key={p.key} className={table.row}>
                  <td className={cx(table.cell, table.pinned)}>{p.label}</td>
                  <td className={cx(table.cell, 'text-right tabular')}>{money(p.income)}</td>
                  <td className={cx(table.cell, 'text-right tabular')}>{money(p.spend)}</td>
                  <td
                    className={cx(
                      table.cell,
                      'text-right font-medium tabular',
                      p.net < 0 ? 'text-critical-text' : 'text-good-text',
                    )}
                  >
                    {money(p.net, { sign: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </Card>
      )}
      </div>
    </div>
  )
}

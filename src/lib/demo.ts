import { format, subMonths, addDays, startOfMonth } from 'date-fns'
import { db, ensureDefaults, type Transaction, type Bill, type Budget } from './db'
import { createMany, notDeleted } from './data'

/** Deterministic pseudo-random so demo data is stable between runs. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export async function seedDemoData() {
  await ensureDefaults()
  const cats = await db.categories.filter(notDeleted).toArray()
  const byName = (n: string) => cats.find((c) => c.name === n)!.id!
  const account = (await db.accounts.filter(notDeleted).toArray())[0]?.id
  const rand = mulberry32(42)
  const today = new Date()
  const txns: Transaction[] = []

  const shops: [string, string, number, number][] = [
    // payee, category, typical £, monthly count
    ['Tesco', 'Groceries', 5200, 6],
    ['Sainsburys Local', 'Groceries', 1800, 4],
    ['Pret A Manger', 'Dining out', 780, 3],
    ['Dishoom', 'Dining out', 6400, 1],
    ['Pizza Express', 'Dining out', 3900, 1],
    ['TfL Travel', 'Transport', 620, 12],
    ['Shell Petrol', 'Transport', 5400, 2],
    ['Amazon', 'Shopping', 2300, 3],
    ['Zara', 'Shopping', 4600, 1],
    ['Boots Pharmacy', 'Health', 1250, 1],
    ['PureGym', 'Health', 2499, 1],
    ['Vue Cinema', 'Fun & leisure', 2400, 1],
    ['Waterstones', 'Fun & leisure', 1500, 1],
  ]

  for (let m = 5; m >= 0; m--) {
    const monthStart = startOfMonth(subMonths(today, m))
    const daysInScope = m === 0 ? today.getDate() : 28
    txns.push({
      date: format(monthStart, 'yyyy-MM-dd'),
      payee: 'Acme Ltd Salary',
      categoryId: byName('Salary'),
      accountId: account,
      amountMinor: 412000,
      createdAt: Date.now(),
    })
    txns.push({
      date: format(monthStart, 'yyyy-MM-dd'),
      payee: 'Brightside Salary',
      categoryId: byName('Salary'),
      accountId: account,
      amountMinor: 358000,
      createdAt: Date.now(),
    })
    for (const [payee, cat, typical, perMonth] of shops) {
      for (let i = 0; i < perMonth; i++) {
        const day = 1 + Math.floor(rand() * (daysInScope - 1))
        const wobble = 0.7 + rand() * 0.6
        txns.push({
          date: format(addDays(monthStart, day - 1), 'yyyy-MM-dd'),
          payee,
          categoryId: byName(cat),
          accountId: account,
          amountMinor: -Math.round(typical * wobble),
          createdAt: Date.now(),
        })
      }
    }
  }
  await createMany('transactions', txns)

  // Recurring bills
  const day = (d: number) => {
    const base = new Date(today.getFullYear(), today.getMonth(), d)
    if (base <= today) base.setMonth(base.getMonth() + 1)
    return format(base, 'yyyy-MM-dd')
  }
  const bills: Bill[] = [
    { name: 'Rent', payee: 'Foxtons Lettings', amountMinor: -185000, categoryId: byName('Home & utilities'), accountId: account, freq: 'monthly', nextDue: day(1), active: 1, autoPost: 1 },
    { name: 'Council tax', payee: 'Hackney Council', amountMinor: -16200, categoryId: byName('Home & utilities'), accountId: account, freq: 'monthly', nextDue: day(3), active: 1, autoPost: 1 },
    { name: 'Energy', payee: 'Octopus Energy', amountMinor: -13400, categoryId: byName('Home & utilities'), accountId: account, freq: 'monthly', nextDue: day(12), active: 1, autoPost: 1 },
    { name: 'Broadband', payee: 'Hyperoptic', amountMinor: -3500, categoryId: byName('Home & utilities'), accountId: account, freq: 'monthly', nextDue: day(15), active: 1, autoPost: 1 },
    { name: 'Netflix', payee: 'Netflix.com', amountMinor: -1599, categoryId: byName('Subscriptions'), accountId: account, freq: 'monthly', nextDue: day(18), active: 1, autoPost: 1 },
    { name: 'Spotify Duo', payee: 'Spotify', amountMinor: -1499, categoryId: byName('Subscriptions'), accountId: account, freq: 'monthly', nextDue: day(21), active: 1, autoPost: 1 },
    { name: 'Car insurance', payee: 'Admiral Insurance', amountMinor: -6200, categoryId: byName('Transport'), accountId: account, freq: 'monthly', nextDue: day(24), active: 1, autoPost: 1 },
  ]
  await createMany('bills', bills)

  // Bill history so charts include them
  const billHistory: Transaction[] = []
  const billDefs = await db.bills.filter(notDeleted).toArray()
  for (let m = 5; m >= 0; m--) {
    const monthStart = startOfMonth(subMonths(today, m))
    for (const b of billDefs) {
      const dueDay = Number(b.nextDue.slice(8, 10))
      const d = addDays(monthStart, Math.min(dueDay, 28) - 1)
      if (d > today) continue
      billHistory.push({
        date: format(d, 'yyyy-MM-dd'),
        payee: b.payee,
        note: b.name,
        categoryId: b.categoryId,
        accountId: account,
        amountMinor: b.amountMinor,
        billId: b.id,
        createdAt: Date.now(),
      })
    }
  }
  await createMany('transactions', billHistory)

  // Budgets
  const budgetDefs: [string, number][] = [
    ['Groceries', 45000],
    ['Home & utilities', 225000],
    ['Transport', 22000],
    ['Dining out', 20000],
    ['Shopping', 15000],
    ['Subscriptions', 3500],
    ['Health', 8000],
    ['Fun & leisure', 10000],
  ]
  const budgets: Budget[] = budgetDefs.map(([name, amountMinor]) => ({ categoryId: byName(name), amountMinor }))
  await createMany('budgets', budgets)
}

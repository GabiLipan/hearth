import { describe, it, expect } from 'vitest'
import { layoutFlow, spendFlow, type FlowGraph, type FlowInput } from './sankey'
import type { BookTotals, ContributionSplit } from './books'
import type { CategorySlice } from './stats'

const totals = (over: Partial<BookTotals> = {}): BookTotals => ({
  income: 0,
  contributions: 0,
  externalIncome: 0,
  returned: 0,
  spend: 0,
  contributed: 0,
  withdrawn: 0,
  net: 0,
  ...over,
})

/** Only ever the two or three fields a case is actually about. */
const split = (over: Partial<ContributionSplit> = {}): ContributionSplit => ({
  mineMinor: 0,
  theirsMinor: 0,
  minePaidMinor: 0,
  theirsPaidMinor: 0,
  mineCount: 0,
  theirsCount: 0,
  minePaidCount: 0,
  theirsPaidCount: 0,
  otherMinor: 0,
  ...over,
})

const slice = (id: string, totalMinor: number, slot = 1): CategorySlice => ({
  categoryId: id,
  name: id,
  icon: 'tag',
  slot,
  totalMinor,
  fraction: 0,
})

/** What flows in must flow out — the invariant the whole diagram rests on. */
function sides(graph: FlowGraph) {
  const into = graph.links.filter((l) => l.to === 'hub').reduce((s, l) => s + l.valueMinor, 0)
  const outOf = graph.links.filter((l) => l.from === 'hub').reduce((s, l) => s + l.valueMinor, 0)
  return { into, outOf }
}

const household = (over: Partial<FlowInput> = {}): FlowInput => ({
  book: 'household',
  totals: totals(),
  slices: [],
  ...over,
})

describe('spendFlow', () => {
  it('balances an ordinary household month', () => {
    const g = spendFlow(
      household({
        totals: totals({ contributions: 2000_00, income: 2000_00, spend: 1500_00, net: 500_00 }),
        slices: [slice('food', 900_00), slice('bills', 600_00)],
        split: split({ mineMinor: 1200_00, theirsMinor: 800_00, otherMinor: 0 }),
        partner: 'Sam',
      }),
    )
    const { into, outOf } = sides(g)
    expect(into).toBe(outOf)
    expect(into).toBe(2000_00)
    expect(g.nodes.find((n) => n.id === 'in:theirs')?.name).toBe('Sam put in')
    expect(g.nodes.find((n) => n.id === 'out:kept')?.valueMinor).toBe(500_00)
  })

  it('names the money a month spent out of what was already there', () => {
    const g = spendFlow(
      household({
        totals: totals({ contributions: 1000_00, income: 1000_00, spend: 1400_00, net: -400_00 }),
        slices: [slice('food', 1400_00)],
        split: split({ mineMinor: 1000_00, theirsMinor: 0, otherMinor: 0 }),
      }),
    )
    expect(g.nodes.find((n) => n.id === 'in:reserves')?.valueMinor).toBe(400_00)
    const { into, outOf } = sides(g)
    expect(into).toBe(outOf)
    // And nothing claims to have been kept in a month that overspent.
    expect(g.nodes.some((n) => n.id === 'out:kept')).toBe(false)
  })

  it('shows spending that has no category rather than losing it', () => {
    const g = spendFlow(
      household({
        totals: totals({ contributions: 500_00, income: 500_00, spend: 500_00, net: 0 }),
        slices: [slice('food', 320_00)],
        split: split({ mineMinor: 500_00, theirsMinor: 0, otherMinor: 0 }),
      }),
    )
    expect(g.nodes.find((n) => n.id === 'out:uncategorised')?.valueMinor).toBe(180_00)
    const { into, outOf } = sides(g)
    expect(into).toBe(outOf)
  })

  it('attributes no more to a person than there were contributions', () => {
    // A split that overshoots — arrivals the totals counted into an earlier
    // month, say — must not invent inflow.
    const g = spendFlow(
      household({
        totals: totals({ contributions: 300_00, income: 300_00, spend: 300_00, net: 0 }),
        slices: [slice('food', 300_00)],
        split: split({ mineMinor: 900_00, theirsMinor: 900_00, otherMinor: 0 }),
      }),
    )
    expect(sides(g).into).toBe(300_00)
    expect(g.nodes.find((n) => n.id === 'in:mine')?.valueMinor).toBe(300_00)
    expect(g.nodes.some((n) => n.id === 'in:theirs')).toBe(false)
  })

  it('does not put a name on contributions it cannot attribute', () => {
    // The residual band. It is not a person, so it does not wear a person's
    // colour — and it must still exist, or the two sides stop balancing.
    const g = spendFlow(
      household({
        totals: totals({ contributions: 500_00, income: 500_00, spend: 500_00, net: 0 }),
        slices: [slice('food', 500_00)],
        split: split({ mineMinor: 400_00, theirsMinor: 0, otherMinor: 0 }),
      }),
    )
    const left = g.nodes.find((n) => n.id === 'in:unnamed')
    expect(left?.valueMinor).toBe(100_00)
    expect(left?.muted).toBe(true)
    expect(sides(g).into).toBe(sides(g).outOf)
  })

  it('keeps what somebody paid on their own card in their own band', () => {
    // It used to be a band of its own, which put a KIND of contribution beside
    // two PEOPLE. Same claim, one ribbon: this is what you put in.
    const g = spendFlow(
      household({
        totals: totals({ contributions: 500_00, income: 500_00, spend: 500_00, net: 0 }),
        slices: [slice('food', 500_00)],
        split: split({
          mineMinor: 500_00,
          minePaidMinor: 100_00,
          mineCount: 3,
          minePaidCount: 2,
        }),
      }),
    )
    expect(g.nodes.find((n) => n.id === 'in:mine')?.valueMinor).toBe(500_00)
    expect(g.nodes.some((n) => n.id === 'in:unnamed')).toBe(false)
  })

  it('breaks that band into its two halves for the tooltip, and they add up', () => {
    const g = spendFlow(
      household({
        totals: totals({ contributions: 500_00, income: 500_00, spend: 500_00, net: 0 }),
        slices: [slice('food', 500_00)],
        split: split({
          mineMinor: 500_00,
          minePaidMinor: 100_00,
          mineCount: 3,
          minePaidCount: 2,
        }),
      }),
    )
    const band = g.nodes.find((n) => n.id === 'in:mine')!
    expect(band.parts).toEqual([
      { label: 'Moved across', valueMinor: 400_00, count: 1 },
      { label: 'Paid from a personal account', valueMinor: 100_00, count: 2 },
    ])
    // The rule the parts exist under: a breakdown that does not add up to the
    // band above it is the same lie as a donut short of its own heading.
    expect(band.parts!.reduce((s, p) => s + p.valueMinor, 0)).toBe(band.valueMinor)
  })

  it('says nothing where the band is only one of those things', () => {
    // A breakdown of one line repeats the band and reads as a rendering fault.
    const all = spendFlow(
      household({
        totals: totals({ contributions: 100_00, income: 100_00, spend: 100_00, net: 0 }),
        slices: [slice('food', 100_00)],
        split: split({ mineMinor: 100_00, minePaidMinor: 100_00, mineCount: 1, minePaidCount: 1 }),
      }),
    )
    expect(all.nodes.find((n) => n.id === 'in:mine')?.parts).toBeUndefined()

    const none = spendFlow(
      household({
        totals: totals({ contributions: 100_00, income: 100_00, spend: 100_00, net: 0 }),
        slices: [slice('food', 100_00)],
        split: split({ mineMinor: 100_00, mineCount: 1 }),
      }),
    )
    expect(none.nodes.find((n) => n.id === 'in:mine')?.parts).toBeUndefined()
  })

  it('draws the personal book from earnings to the household and back', () => {
    const g = spendFlow({
      book: 'mine',
      totals: totals({ externalIncome: 3000_00, returned: 100_00, income: 3100_00, spend: 400_00, contributed: 2000_00, net: 700_00 }),
      slices: [slice('hobbies', 400_00)],
    })
    expect(g.nodes.find((n) => n.id === 'out:contributed')?.valueMinor).toBe(2000_00)
    expect(g.nodes.find((n) => n.id === 'in:returned')?.valueMinor).toBe(100_00)
    const { into, outOf } = sides(g)
    expect(into).toBe(outOf)
  })

  it('is empty when there is nothing to draw', () => {
    expect(spendFlow(household()).totalMinor).toBe(0)
    expect(spendFlow(household()).nodes).toEqual([])
  })
})

describe('layoutFlow', () => {
  const graph = spendFlow(
    household({
      totals: totals({ contributions: 2000_00, income: 2000_00, spend: 1500_00, net: 500_00 }),
      slices: [slice('food', 900_00), slice('bills', 590_00), slice('crumb', 10_00)],
      split: split({ mineMinor: 1200_00, theirsMinor: 800_00, otherMinor: 0 }),
    }),
  )
  const out = layoutFlow(graph, { width: 600, height: 400 })

  it('places every node inside the box it was given', () => {
    for (const b of out.boxes) {
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.height).toBeLessThanOrEqual(400 + 0.001)
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(600)
    }
  })

  it('gives a ribbon the same thickness at both ends', () => {
    for (const r of out.ribbons) {
      const box = out.boxes.find((b) => b.node.id === (r.link.from === 'hub' ? r.link.to : r.link.from))!
      expect(r.thickness).toBeCloseTo(box.height, 6)
    }
  })

  it('fills the hub exactly from each side', () => {
    const hub = out.boxes.find((b) => b.node.side === 'hub')!
    const into = out.ribbons.filter((r) => r.link.to === 'hub')
    const outOf = out.ribbons.filter((r) => r.link.from === 'hub')
    const span = (rs: typeof out.ribbons, end: 'y0' | 'y1') => {
      const tops = rs.map((r) => r[end])
      const bottoms = rs.map((r, i) => r[end] + rs[i].thickness)
      return { top: Math.min(...tops), bottom: Math.max(...bottoms) }
    }
    const inSpan = span(into, 'y1')
    const outSpan = span(outOf, 'y0')
    // The busier side meets the bar edge to edge; the other is centred inside it.
    expect(Math.min(inSpan.top, outSpan.top)).toBeCloseTo(hub.y, 6)
    expect(Math.max(inSpan.bottom, outSpan.bottom)).toBeCloseTo(hub.y + hub.height, 6)
    expect(inSpan.top).toBeGreaterThanOrEqual(hub.y - 0.001)
    expect(outSpan.bottom).toBeLessThanOrEqual(hub.y + hub.height + 0.001)
  })

  it('leaves no band too thin to see or to hover', () => {
    for (const b of out.boxes) expect(b.height).toBeGreaterThanOrEqual(3)
  })

  it('stacks each column in order, with a gap between bands', () => {
    const column = out.boxes.filter((b) => b.node.side === 'out')
    for (let i = 1; i < column.length; i++) {
      expect(column[i].y).toBeGreaterThan(column[i - 1].y + column[i - 1].height - 0.001)
    }
  })

  it('has nothing to lay out when there is nothing to draw', () => {
    expect(layoutFlow({ nodes: [], links: [], totalMinor: 0 }, { width: 600, height: 400 })).toEqual({
      boxes: [],
      ribbons: [],
    })
  })
})

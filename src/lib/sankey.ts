import type { BookId, BookTotals, ContributionSplit } from './books'
import type { CategorySlice } from './stats'

/**
 * A month as one picture: what came in, on the left; what it turned into, on
 * the right; and the width of every ribbon between them the amount of money it
 * carried.
 *
 * The figures are the same ones the summary card shows. That is the point of
 * it — the card is five numbers you have to subtract in your head to see the
 * shape of a month, and this is the shape. It invents nothing and it hides
 * nothing:
 *
 *   - the two sides BALANCE, always. Where more went out than came in, the
 *     difference is drawn as an inflow called what it is — money that was
 *     already there — rather than the ribbons quietly not adding up;
 *   - spending that has no category is its own band rather than being left out,
 *     because a diagram whose right-hand side is smaller than its left is a
 *     diagram that is lying about one of them;
 *   - the contributions are split by person only as far as the far legs allow.
 *     `contributionSplit` explains why that is the honest limit.
 *
 * Two halves, kept apart: `spendFlow` decides WHAT the bands are, and
 * `layoutFlow` decides where they go. The second is pure geometry over the
 * first, which is what makes both of them testable without a browser.
 */

export interface FlowNode {
  id: string
  name: string
  valueMinor: number
  side: 'in' | 'hub' | 'out'
  /** A palette slot, where the band stands for a category that has one. */
  slot?: number
  /** Drawn in ink rather than colour: a total, a residual, something unassigned. */
  muted?: boolean
}

export interface FlowLink {
  from: string
  to: string
  valueMinor: number
}

export interface FlowGraph {
  nodes: FlowNode[]
  links: FlowLink[]
  /** What flows through the middle. Both sides sum to this. */
  totalMinor: number
}

/** Everything a book needs to be drawn as a flow. */
export interface FlowInput {
  book: BookId
  totals: BookTotals
  /** The category breakdown already on screen, so the two cannot disagree. */
  slices: CategorySlice[]
  /** Household only, and only where it is knowable. */
  split?: ContributionSplit
  /** What to call the other person, where there is exactly one of them. */
  partner?: string
}

export function spendFlow({ book, totals, slices, split, partner }: FlowInput): FlowGraph {
  const nodes: FlowNode[] = []
  const links: FlowLink[] = []
  const hub = 'hub'

  const inflow = (id: string, name: string, valueMinor: number, extra?: Partial<FlowNode>) => {
    if (valueMinor <= 0) return
    nodes.push({ id, name, valueMinor, side: 'in', ...extra })
    links.push({ from: id, to: hub, valueMinor })
  }
  const outflow = (id: string, name: string, valueMinor: number, extra?: Partial<FlowNode>) => {
    if (valueMinor <= 0) return
    nodes.push({ id, name, valueMinor, side: 'out', ...extra })
    links.push({ from: hub, to: id, valueMinor })
  }

  /* ---- what came in ---- */
  if (book === 'household') {
    // Attributed as far as the far legs allow, and no further. A contribution
    // whose other leg is in an account this device is not on is still known to
    // be somebody else's — that is what makes the split possible at all — but
    // an arrival nobody has linked cannot be assigned to a person by guessing.
    const named = Math.min(totals.contributions, Math.max(0, split?.mineMinor ?? 0))
    const theirs = Math.min(Math.max(0, totals.contributions - named), Math.max(0, split?.theirsMinor ?? 0))
    inflow('in:mine', 'You put in', named, { slot: 2 })
    inflow('in:theirs', `${partner ?? 'They'} put in`, theirs, { slot: 5 })
    // Whatever is left of the contributions once both names are accounted for:
    // household spending paid out of a personal account, which is a
    // contribution the household never saw arrive.
    inflow('in:paid', 'Paid from a personal account', totals.contributions - named - theirs, { slot: 7 })
    inflow('in:external', 'Other income', totals.externalIncome, { slot: 1 })
  } else if (book === 'mine') {
    inflow('in:external', 'Earned', totals.externalIncome, { slot: 2 })
    inflow('in:returned', 'Back from the household', totals.returned, { slot: 5 })
  } else {
    inflow('in:external', 'Income', totals.externalIncome, { slot: 2 })
  }

  /* ---- what it turned into ---- */
  const categorised = slices.reduce((s, x) => s + x.totalMinor, 0)
  for (const s of slices) {
    outflow(`cat:${s.categoryId}`, s.name, s.totalMinor, { slot: s.slot })
  }
  // The slices only count rows that carry a category. Left out, the right-hand
  // side would be short by however much has not been filed yet, and nothing on
  // the diagram would say so.
  outflow('out:uncategorised', 'Not categorised', totals.spend - categorised, { muted: true })

  if (book === 'household') outflow('out:withdrawn', 'Taken back out', totals.withdrawn, { slot: 6 })
  if (book === 'mine') outflow('out:contributed', 'To the household', totals.contributed, { slot: 1 })
  outflow('out:kept', 'Left over', Math.max(0, totals.net), { slot: 4 })

  /* ---- and the difference, where a month spent more than it earned ---- */
  const out = links.filter((l) => l.from === hub).reduce((s, l) => s + l.valueMinor, 0)
  const inTotal = links.filter((l) => l.to === hub).reduce((s, l) => s + l.valueMinor, 0)
  if (out > inTotal) {
    // Not a fudge factor. A month that spends more than it takes in is spending
    // a balance that was already there, and that is a real source of money —
    // naming it is what keeps the diagram both balanced and true.
    inflow('in:reserves', 'From what was already there', out - inTotal, { muted: true })
  }

  const totalMinor = Math.max(out, inTotal)
  if (totalMinor <= 0) return { nodes: [], links: [], totalMinor: 0 }

  nodes.push({ id: hub, name: 'The month', valueMinor: totalMinor, side: 'hub', muted: true })
  return { nodes, links, totalMinor }
}

/* ---------- geometry ---------- */

export interface FlowBox {
  node: FlowNode
  x: number
  y: number
  width: number
  height: number
}

export interface FlowRibbon {
  link: FlowLink
  /** The node whose colour the ribbon takes: the source on the way in, the target on the way out. */
  colourFrom: string
  x0: number
  y0: number
  x1: number
  y1: number
  thickness: number
}

export interface FlowLayout {
  boxes: FlowBox[]
  ribbons: FlowRibbon[]
}

export interface FlowLayoutOptions {
  width: number
  height: number
  /** How thick the bars themselves are. */
  nodeWidth?: number
  /** The space left between two stacked bands. */
  padding?: number
  /** Nothing may be thinner than this, or a small band is invisible and unhoverable. */
  minBand?: number
}

/**
 * Where every band goes.
 *
 * One scale for the whole diagram, taken from whichever column needs the most
 * room once its gaps are subtracted. Two scales would be easier and would make
 * a ribbon a different thickness at each end, which is the one thing a diagram
 * like this must never do — the whole claim it makes is that the width of a
 * ribbon IS the money.
 *
 * The cost is that the shorter column does not fill the height. That is the
 * right trade: an unfilled column is obviously an unfilled column, whereas a
 * ribbon that tapers looks like money going missing on the way across.
 */
export function layoutFlow(graph: FlowGraph, options: FlowLayoutOptions): FlowLayout {
  const { width, height, nodeWidth = 12, padding = 6, minBand = 3 } = options
  if (graph.totalMinor <= 0) return { boxes: [], ribbons: [] }

  const ins = graph.nodes.filter((n) => n.side === 'in')
  const outs = graph.nodes.filter((n) => n.side === 'out')
  const hub = graph.nodes.find((n) => n.side === 'hub')
  if (!hub || ins.length === 0 || outs.length === 0) return { boxes: [], ribbons: [] }

  // Each column loses `padding` between every pair of bands, and a band can
  // never be thinner than `minBand` — so the room a column actually has for
  // money is what is left after both.
  const roomFor = (n: number) => Math.max(1, height - padding * (n - 1) - minBand * n)
  const scale = Math.min(roomFor(ins.length), roomFor(outs.length)) / graph.totalMinor

  const bandOf = (n: FlowNode) => minBand + n.valueMinor * scale

  const stack = (nodes: FlowNode[], x: number) => {
    const total = nodes.reduce((s, n) => s + bandOf(n), 0) + padding * (nodes.length - 1)
    // Centred: a column with less in it hangs in the middle rather than being
    // stretched to the height or pinned to the top.
    let y = Math.max(0, (height - total) / 2)
    const boxes: FlowBox[] = []
    for (const node of nodes) {
      const h = bandOf(node)
      boxes.push({ node, x, y, width: nodeWidth, height: h })
      y += h + padding
    }
    return boxes
  }

  const inBoxes = stack(ins, 0)
  const outBoxes = stack(outs, width - nodeWidth)
  const thickness = (boxes: FlowBox[]) => boxes.reduce((s, b) => s + b.height, 0)

  /**
   * The hub is as tall as the busier side.
   *
   * Not `total * scale`: the `minBand` floor means a side with eleven bands
   * carries a little more than the money alone would, and a hub sized to the
   * money would then be met by ribbons that do not fit it — a stack overhanging
   * its own bar, which looks like an arithmetic error. Sizing it to the thicker
   * side and centring the thinner one inside keeps every ribbon exactly as
   * thick at the hub as it is at its own end, which is the claim the diagram
   * makes.
   */
  const inThickness = thickness(inBoxes)
  const outThickness = thickness(outBoxes)
  const hubHeight = Math.max(inThickness, outThickness)
  const hubBox: FlowBox = {
    node: hub,
    x: (width - nodeWidth) / 2,
    y: Math.max(0, (height - hubHeight) / 2),
    width: nodeWidth,
    height: hubHeight,
  }
  const boxes = [...inBoxes, hubBox, ...outBoxes]

  /**
   * The hub is met from both sides in the order the bands are stacked, so a
   * ribbon leaving the top of the left column arrives at the top of the hub.
   * Anything else and the ribbons cross for no reason.
   */
  const ribbons: FlowRibbon[] = []
  let hubIn = hubBox.y + (hubHeight - inThickness) / 2
  for (const box of inBoxes) {
    const t = box.height
    ribbons.push({
      link: { from: box.node.id, to: hub.id, valueMinor: box.node.valueMinor },
      colourFrom: box.node.id,
      x0: box.x + nodeWidth,
      y0: box.y,
      x1: hubBox.x,
      y1: hubIn,
      thickness: t,
    })
    hubIn += t
  }

  let hubOut = hubBox.y + (hubHeight - outThickness) / 2
  for (const box of outBoxes) {
    const t = box.height
    ribbons.push({
      link: { from: hub.id, to: box.node.id, valueMinor: box.node.valueMinor },
      colourFrom: box.node.id,
      x0: hubBox.x + nodeWidth,
      y0: hubOut,
      x1: box.x,
      y1: box.y,
      thickness: t,
    })
    hubOut += t
  }

  return { boxes, ribbons }
}

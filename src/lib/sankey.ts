import type { BookBridge, BookId, BookTotals, ContributionSplit } from './books'
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
  /**
   * Which column the band stands in, left to right.
   *
   * `side` says the same thing for the two-hop graphs `spendFlow` builds, and
   * stays because that is what decides which way a label points and what a
   * click on a band means. `column` is what the LAYOUT reads: a diagram with
   * four columns has no "the hub", and `in | hub | out` cannot describe one.
   * Omitted, it is derived from `side` — so every graph written before this
   * lays out exactly as it did, which `sankey.test.ts` asserts.
   */
  column?: number
  side: 'in' | 'hub' | 'out'
  /** A palette slot, where the band stands for a category that has one. */
  slot?: number
  /** The category's own colour, where it has one. Overrides `slot`. See `paintOf`. */
  color?: string
  /** Drawn in ink rather than colour: a total, a residual, something unassigned. */
  muted?: boolean
  /**
   * What the band is made of, where it is made of more than one kind of thing.
   *
   * A band is one ribbon because it is one claim — "this is what you put in" —
   * and splitting it in two on the diagram would answer a question nobody asked
   * with a permanent extra row. The parts belong in the tooltip, which is where
   * somebody has asked. They must sum to `valueMinor`, and `spendFlow` is
   * responsible for that: a breakdown that does not add up to the band above it
   * is the same lie as a donut that does not add up to its heading.
   */
  parts?: FlowPart[]
}

export interface FlowPart {
  label: string
  valueMinor: number
  /** How many transactions, where the caller knows. */
  count?: number
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
  /**
   * Of what is left over, how much went into a savings account inside the book.
   *
   * Drawn out of "Left over" rather than beside it: the money is still the
   * book's, so it was never anything but left over — the band simply says which
   * part of it stopped being available. See `savedInto`.
   */
  savedMinor?: number
}

/**
 * A contribution band's two halves: moved into a joint account, and bought for
 * the household straight off a personal card.
 *
 * Returns nothing unless both halves are real. One part that IS the band says
 * nothing the band did not already say, and a breakdown of one line reads as a
 * rendering fault rather than as detail.
 *
 * `paid` is clamped to the band because the band itself is clamped: `named` and
 * `theirs` are capped against `totals.contributions`, so in the rare month where
 * the split and the totals disagree the parts must give way rather than sum to
 * more than the ribbon they describe.
 */
function partsOf(
  valueMinor: number,
  paidMinor: number,
  count: number,
  paidCount: number,
): FlowPart[] | undefined {
  const paid = Math.min(Math.max(0, paidMinor), valueMinor)
  const moved = valueMinor - paid
  if (paid <= 0 || moved <= 0) return undefined
  return [
    // A zero count is omitted rather than printed: the personal book knows the
    // two amounts and not how many rows each is, and "0 payments" under a real
    // figure reads as a bug rather than as an absence.
    { label: 'Moved across', valueMinor: moved, count: Math.max(0, count - paidCount) || undefined },
    { label: 'Paid from a personal account', valueMinor: paid, count: paidCount || undefined },
  ]
}

export function spendFlow({ book, totals, slices, split, partner, savedMinor = 0 }: FlowInput): FlowGraph {
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
    inflow('in:mine', 'You put in', named, {
      slot: 2,
      parts: partsOf(named, split?.minePaidMinor ?? 0, split?.mineCount ?? 0, split?.minePaidCount ?? 0),
    })
    inflow('in:theirs', `${partner ?? 'They'} put in`, theirs, {
      slot: 5,
      parts: partsOf(theirs, split?.theirsPaidMinor ?? 0, split?.theirsCount ?? 0, split?.theirsPaidCount ?? 0),
    })
    // Whatever is left once both names are accounted for.
    //
    // This used to be the band for household spending paid out of a personal
    // account, which put a KIND of contribution beside two PEOPLE — three bands
    // answering two different questions, and the odd one out was the one nobody
    // could place. Those rows are now attributed to whoever paid them and join
    // that person's band, broken out in its tooltip. What is left here is money
    // that genuinely has no name on it: a transfer whose far leg is in an
    // account this device can see and that belongs to neither book, which is
    // rare and is not a person. Muted, because an unattributed figure should not
    // wear somebody's colour.
    inflow('in:unnamed', 'Put in — not sure by whom', totals.contributions - named - theirs, { muted: true })
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
    outflow(`cat:${s.categoryId}`, s.name, s.totalMinor, { slot: s.slot, color: s.color })
  }
  // The slices only count rows that carry a category. Left out, the right-hand
  // side would be short by however much has not been filed yet, and nothing on
  // the diagram would say so.
  outflow('out:uncategorised', 'Not categorised', totals.spend - categorised, { muted: true })

  if (book === 'household') outflow('out:withdrawn', 'Taken back out', totals.withdrawn, { slot: 6 })
  if (book === 'mine') {
    // Slot 5, the same colour the household side paints "they put in", rather
    // than a category slot: this band is a DESTINATION, and it is the same
    // money seen from the other end.
    //
    // One ribbon, because it is one claim — but reached two ways, and the
    // second is the one somebody will not have expected to be in there. Same
    // `partsOf` the household bands use, so it disappears by itself in a
    // household that only ever moves money across.
    outflow('out:contributed', 'To our household', totals.contributed, {
      slot: 5,
      parts: partsOf(totals.contributed, totals.contributedPaid, 0, 0)?.map((part) =>
        part.label === 'Paid from a personal account'
          ? { ...part, label: 'Bought for the household' }
          : part,
      ),
    })
  }

  /**
   * What is left, split into the part that was put by and the part that simply
   * stayed. Both are `net` — moving money to a savings account inside the book
   * changes nothing about what the book has — so the saved half is taken OUT of
   * the kept band rather than added beside it, or the two sides stop balancing.
   */
  const kept = Math.max(0, totals.net)
  const saved = Math.min(Math.max(0, savedMinor), kept)
  outflow('out:saved', 'Moved to savings', saved, { slot: 9 })
  outflow('out:kept', saved > 0 ? 'Left in current' : 'Left over', kept - saved, { slot: 4 })

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

/* ---------- the books, and what crosses between them ---------- */

export interface BooksFlowInput {
  bridge: BookBridge
  split: ContributionSplit
  /** The household's spending by category, and the personal book's. */
  householdSlices: CategorySlice[]
  mineSlices: CategorySlice[]
  partner?: string
}

/**
 * Four columns: where the money came from, whose it became, and what it turned
 * into.
 *
 * The Everything book used to be the other two poured into one pool — the same
 * donut and the same three-column diagram, with the household and personal
 * accounts added together. It answered nothing the other two answer better.
 * This is the question only Everything can answer: how the two books RELATE,
 * and it is a picture rather than a table because the interesting part is a
 * quantity crossing between them.
 *
 * The middle pair is the whole point. Column 1 is where money arrived, column 2
 * is whose it ended up being, and the ribbons between them are the crossing: one
 * from Mine to Ours carrying everything contributed — moved across and bought
 * straight off a card alike — and one back the other way for anything taken out
 * again. Everything else goes straight across.
 *
 * It balances exactly, and not by construction: each column's outflows are
 * derived from the book totals and happen to sum to its inflows, because
 * `mine.spend + mine.net === mine.income − mine.contributed` and
 * `household.spend + household.net === household.income − household.withdrawn`
 * are identities of `bookTotals`. `books.test.ts` pins both.
 */
export function booksFlow({
  bridge,
  split,
  householdSlices,
  mineSlices,
  partner,
}: BooksFlowInput): FlowGraph {
  const { household, mine } = bridge
  const nodes: FlowNode[] = []
  const links: FlowLink[] = []

  const at = (
    column: number,
    side: FlowNode['side'],
    id: string,
    name: string,
    valueMinor: number,
    extra?: Partial<FlowNode>,
  ) => {
    if (valueMinor <= 0) return false
    nodes.push({ id, name, valueMinor, column, side, ...extra })
    return true
  }
  const join = (from: string, to: string, valueMinor: number) => {
    if (valueMinor <= 0) return
    links.push({ from, to, valueMinor })
  }

  /* ---- 0. where it came from ---- */
  const earned = mine.externalIncome
  const theirs = Math.max(0, split.theirsMinor)
  const outside = Math.max(0, split.externalMinor)
  const unnamed = Math.max(0, split.unattributedMinor)
  at(0, 'in', 'from:you', 'You earned', earned, { slot: 2 })
  at(0, 'in', 'from:them', `${partner ?? 'They'} put in`, theirs, { slot: 5 })
  at(0, 'in', 'from:outside', 'Other income', outside, { slot: 1 })
  at(0, 'in', 'from:unnamed', 'Paid in — not sure by whom', unnamed, { muted: true })

  /* ---- 1. where it landed ---- */
  const landedMine = earned
  const landedOurs = theirs + outside + unnamed
  at(1, 'hub', 'in:mine', 'Mine', landedMine, { slot: 2 })
  at(1, 'hub', 'in:ours', 'Ours', landedOurs, { slot: 1 })
  join('from:you', 'in:mine', earned)
  join('from:them', 'in:ours', theirs)
  join('from:outside', 'in:ours', outside)
  join('from:unnamed', 'in:ours', unnamed)

  /* ---- 2. whose it became — and the crossing ---- */
  // Clamped against what actually landed, because a month can move more across
  // than arrived in it by spending a balance that was already there. The bands
  // may then be short of the money; a ribbon thicker than the band it leaves
  // would be a diagram claiming something impossible.
  const crossed = Math.min(mine.contributed, landedMine)
  const backOut = Math.min(mine.returned, landedOurs)
  const becameMine = mine.spend + Math.max(0, mine.net)
  const becameOurs = household.spend + Math.max(0, household.net)
  at(2, 'hub', 'own:mine', 'Mine', becameMine, { slot: 2 })
  at(2, 'hub', 'own:ours', 'Ours', becameOurs, { slot: 1 })
  join('in:mine', 'own:mine', landedMine - crossed)
  join('in:mine', 'own:ours', crossed)
  join('in:ours', 'own:ours', landedOurs - backOut)
  join('in:ours', 'own:mine', backOut)

  /* ---- 3. what it turned into ---- */
  const spendBands = (
    from: string,
    slices: CategorySlice[],
    spend: number,
    leftId: string,
    leftName: string,
    leftMinor: number,
  ) => {
    let named = 0
    for (const slice of slices) {
      if (at(3, 'out', `${from}:cat:${slice.categoryId}`, slice.name, slice.totalMinor, {
        slot: slice.slot,
        color: slice.color,
      })) {
        join(from, `${from}:cat:${slice.categoryId}`, slice.totalMinor)
        named += slice.totalMinor
      }
    }
    // The slices only count rows that carry a category. Left out, the right-hand
    // side would be short by however much has not been filed yet, and nothing on
    // the diagram would say so.
    if (at(3, 'out', `${from}:rest`, 'Not categorised', spend - named, { muted: true })) {
      join(from, `${from}:rest`, spend - named)
    }
    if (at(3, 'out', leftId, leftName, leftMinor, { slot: 4 })) join(from, leftId, leftMinor)
  }

  spendBands('own:ours', householdSlices, household.spend, 'left:ours', 'Left in ours', Math.max(0, household.net))
  spendBands('own:mine', mineSlices, mine.spend, 'left:mine', 'Left with me', Math.max(0, mine.net))

  const totalMinor = nodes.filter((n) => n.column === 1).reduce((sum, n) => sum + n.valueMinor, 0)
  if (totalMinor <= 0) return { nodes: [], links: [], totalMinor: 0 }
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

  /**
   * The columns, in order.
   *
   * `in | hub | out` is columns 0, 1, 2 — so the two-hop graphs need no
   * `column` of their own and lay out exactly as they always did. A graph that
   * states its own columns can have as many as it likes, and the only rule is
   * that a link goes between ADJACENT ones: a ribbon that skipped a column
   * would have to pass behind a band, and there is no honest way to draw that.
   */
  const columnOf = (n: FlowNode) => n.column ?? (n.side === 'in' ? 0 : n.side === 'hub' ? 1 : 2)
  const indices = [...new Set(graph.nodes.map(columnOf))].sort((a, b) => a - b)
  if (indices.length < 2) return { boxes: [], ribbons: [] }
  const columns = indices.map((i) => graph.nodes.filter((n) => columnOf(n) === i))
  if (columns.some((c) => c.length === 0)) return { boxes: [], ribbons: [] }

  // Each column loses `padding` between every pair of bands, and a band can
  // never be thinner than `minBand` — so the room a column actually has for
  // money is what is left after both. One scale for the whole diagram, taken
  // from whichever column needs the most room: two scales would make a ribbon a
  // different thickness at each end, which is the one thing a diagram like this
  // must never do, since the width of a ribbon IS the money.
  const roomFor = (n: number) => Math.max(1, height - padding * (n - 1) - minBand * n)
  const scale = Math.min(...columns.map((c) => roomFor(c.length))) / graph.totalMinor

  /**
   * How thick every ribbon is, decided before any box exists.
   *
   * `minBand` is a floor on a BAND, so that a small one stays visible and
   * hoverable — and a ribbon that is the only one its band carries has to be
   * fattened with it, or the two disagree at the join and it reads as money
   * going missing at one end. Where a band carries several ribbons there is no
   * floor to share out, and each is exactly its money.
   *
   * Stated over links rather than over boxes because the boxes are sized FROM
   * this: an interior band is as tall as the busier of the two stacks it
   * carries, which is the general form of "the hub is as tall as the busier
   * side" and reduces to exactly that when there are three columns.
   */
  const outLinks = (id: string) => graph.links.filter((l) => l.from === id)
  const inLinks = (id: string) => graph.links.filter((l) => l.to === id)
  const sole = (l: FlowLink) => outLinks(l.from).length === 1 || inLinks(l.to).length === 1
  const thicknessOf = (l: FlowLink) => l.valueMinor * scale + (sole(l) ? minBand : 0)
  const spanOf = (links: FlowLink[]) => links.reduce((sum, l) => sum + thicknessOf(l), 0)

  const heightOf = (n: FlowNode) =>
    Math.max(minBand + n.valueMinor * scale, spanOf(inLinks(n.id)), spanOf(outLinks(n.id)))

  const step = indices.length > 1 ? (width - nodeWidth) / (indices.length - 1) : 0
  const stack = (nodes: FlowNode[], x: number) => {
    const total = nodes.reduce((sum, n) => sum + heightOf(n), 0) + padding * (nodes.length - 1)
    // Centred: a column with less in it hangs in the middle rather than being
    // stretched to the height or pinned to the top.
    let y = Math.max(0, (height - total) / 2)
    const boxes: FlowBox[] = []
    for (const node of nodes) {
      const h = heightOf(node)
      boxes.push({ node, x, y, width: nodeWidth, height: h })
      y += h + padding
    }
    return boxes
  }

  const stacks = columns.map((nodes, i) => stack(nodes, Math.round(i * step)))
  const boxes = stacks.flat()
  const boxOf = new Map(boxes.map((b) => [b.node.id, b]))

  /**
   * The bands are met in the order they are stacked, so a ribbon leaving the
   * top of one column arrives at the top of the next; anything else and they
   * cross for no reason. Each stack is centred against its band, which matters
   * only where a band is taller than the ribbons it carries — the outer ones
   * never are.
   */
  const usedOut = new Map<string, number>()
  const usedIn = new Map<string, number>()
  const centred = (b: FlowBox, links: FlowLink[]) => b.y + (b.height - spanOf(links)) / 2

  const ribbons: FlowRibbon[] = []
  for (const link of graph.links) {
    const from = boxOf.get(link.from)
    const to = boxOf.get(link.to)
    if (!from || !to) continue
    const t = thicknessOf(link)
    const y0 = usedOut.get(from.node.id) ?? centred(from, outLinks(from.node.id))
    const y1 = usedIn.get(to.node.id) ?? centred(to, inLinks(to.node.id))
    ribbons.push({
      link,
      // The source on the way towards the middle, the target on the way out of
      // it — so a ribbon always wears the colour of the thing being named
      // rather than of the pool it passed through.
      colourFrom: from.node.side === 'in' ? from.node.id : to.node.id,
      x0: from.x + nodeWidth,
      y0,
      x1: to.x,
      y1,
      thickness: t,
    })
    usedOut.set(from.node.id, y0 + t)
    usedIn.set(to.node.id, y1 + t)
  }

  return { boxes, ribbons }
}

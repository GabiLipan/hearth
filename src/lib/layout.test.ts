import { describe, it, expect } from 'vitest'
import {
  bands,
  effectiveSpan,
  moveTo,
  nextSpan,
  normaliseLayout,
  optionValue,
  optionsFor,
  setOption,
  setSpan,
  toggle,
  type LayoutItem,
  type SectionDef,
} from './layout'

const COUNTS = {
  id: 'count',
  label: 'How many',
  choices: [
    { value: '5', label: 'Top 5' },
    { value: '10', label: 'Top 10' },
  ],
}

const CATALOGUE: SectionDef[] = [
  { id: 'hero', label: 'Hero', defaultSpan: 'full' },
  {
    id: 'donut',
    label: 'Donut',
    variants: [{ value: 'donut', label: 'Ring' }, { value: 'bars', label: 'Bars' }],
    options: [COUNTS],
  },
  { id: 'trend', label: 'Trend' },
  { id: 'flow', label: 'Flow', defaultOn: false, defaultSpan: 'full' },
]

const item = (id: string, over: Partial<LayoutItem> = {}): LayoutItem => ({ id, on: true, span: 1, ...over })

describe('normaliseLayout', () => {
  it('starts from the catalogue when there is nothing stored', () => {
    expect(normaliseLayout(null, CATALOGUE)).toEqual([
      { id: 'hero', on: true, span: 'full', variant: undefined },
      { id: 'donut', on: true, span: 1, variant: undefined },
      { id: 'trend', on: true, span: 1, variant: undefined },
      // Big enough to be an imposition, so it waits to be asked for.
      { id: 'flow', on: false, span: 'full', variant: undefined },
    ])
  })

  it('keeps the stored order and appends what the catalogue has gained', () => {
    const stored = [item('trend'), item('hero', { span: 2 })]
    expect(normaliseLayout(stored, CATALOGUE).map((i) => i.id)).toEqual(['trend', 'hero', 'donut', 'flow'])
  })

  it('drops sections the page no longer has, and duplicates', () => {
    const stored = [item('gone'), item('donut'), item('donut', { span: 2 })]
    const out = normaliseLayout(stored, CATALOGUE)
    expect(out.filter((i) => i.id === 'donut')).toHaveLength(1)
    expect(out.some((i) => i.id === 'gone')).toBe(false)
  })

  /**
   * The contract a section that can be switched on and off relies on.
   *
   * "Owed to you" is absent from the home catalogue unless the preference in
   * Settings is on, so the same page normalises against two different
   * catalogues over its life — and `useLayout` re-runs when the offer changes,
   * which is the only reason turning it on takes effect without a reload.
   */
  it('lets a section come and go with the catalogue that offers it', () => {
    const withOwed: SectionDef[] = [...CATALOGUE, { id: 'owed', label: 'Owed' }]
    const stored = [item('hero'), item('owed', { span: 2 })]

    // Offered: kept, exactly as it was stored.
    expect(normaliseLayout(stored, withOwed).find((i) => i.id === 'owed')).toEqual({
      id: 'owed',
      on: true,
      span: 2,
      variant: undefined,
    })

    // Not offered: gone, and gone from what is written back — so turning it on
    // again puts it at the end with its defaults rather than where it was.
    const without = normaliseLayout(stored, CATALOGUE)
    expect(without.some((i) => i.id === 'owed')).toBe(false)
    const backOn = normaliseLayout(without, withOwed)
    expect(backOn[backOn.length - 1]).toEqual({ id: 'owed', on: true, span: 1, variant: undefined })
  })

  it('refuses a span or a variant the section does not offer', () => {
    const stored = [{ id: 'donut', on: true, span: 7, variant: 'treemap' }]
    expect(normaliseLayout(stored, CATALOGUE)[0]).toEqual({ id: 'donut', on: true, span: 1, variant: undefined })
  })

  it('keeps a variant the section still offers', () => {
    const stored = [{ id: 'donut', on: true, span: 1, variant: 'bars' }]
    expect(normaliseLayout(stored, CATALOGUE)[0].variant).toBe('bars')
  })

  it('keeps an option the section still offers, and drops one it does not', () => {
    const stored = [{ id: 'donut', on: true, span: 1, opts: { count: '10', gone: '3' } }]
    expect(normaliseLayout(stored, CATALOGUE)[0].opts).toEqual({ count: '10' })
  })

  it('refuses a choice that is not on offer, rather than storing it', () => {
    const stored = [{ id: 'donut', on: true, span: 1, opts: { count: '999' } }]
    expect(normaliseLayout(stored, CATALOGUE)[0].opts).toBeUndefined()
  })

  it('leaves a section with no options carrying none', () => {
    const stored = [{ id: 'trend', on: true, span: 1, opts: { count: '10' } }]
    expect(normaliseLayout(stored, CATALOGUE)[0].opts).toBeUndefined()
  })

  it('survives junk, because the string came off disk', () => {
    expect(normaliseLayout('not a layout', CATALOGUE)).toHaveLength(CATALOGUE.length)
    expect(normaliseLayout([null, 3, { nope: true }], CATALOGUE)).toHaveLength(CATALOGUE.length)
  })
})

describe('moveTo', () => {
  const items = [item('a'), item('b'), item('c')]

  it('moves forwards, counting gaps rather than items', () => {
    // Gap 3 is "after c" — which, with `a` lifted out first, is the end.
    expect(moveTo(items, 'a', 3).map((i) => i.id)).toEqual(['b', 'c', 'a'])
  })

  it('moves backwards', () => {
    expect(moveTo(items, 'c', 0).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('returns the same array when the drop changes nothing', () => {
    expect(moveTo(items, 'b', 1)).toBe(items)
    expect(moveTo(items, 'b', 2)).toBe(items)
  })

  it('ignores hidden sections and leaves them at the end', () => {
    const mixed = [item('a'), item('h', { on: false }), item('b')]
    expect(moveTo(mixed, 'b', 0).map((i) => i.id)).toEqual(['b', 'a', 'h'])
  })

  it('does nothing for an id that is not visible', () => {
    const mixed = [item('a'), item('h', { on: false })]
    expect(moveTo(mixed, 'h', 0)).toBe(mixed)
  })
})

describe('toggle', () => {
  it('hides to the end of the list', () => {
    const out = toggle([item('a'), item('b'), item('c')], 'a')
    expect(out.map((i) => i.id)).toEqual(['b', 'c', 'a'])
    expect(out[2].on).toBe(false)
  })

  it('brings a section back at the end of the VISIBLE run, not the whole list', () => {
    const out = toggle([item('a'), item('h1', { on: false }), item('h2', { on: false })], 'h2')
    expect(out.map((i) => i.id)).toEqual(['a', 'h2', 'h1'])
    expect(out[1].on).toBe(true)
  })
})

describe('nextSpan', () => {
  it('only offers widths the screen can tell apart', () => {
    expect(nextSpan(1, 1)).toBe(1)
    // On two columns, "2" and "full" are the same picture.
    expect(nextSpan(1, 2)).toBe('full')
    expect(nextSpan('full', 2)).toBe(1)
    expect(nextSpan(1, 4)).toBe(2)
    expect(nextSpan(2, 4)).toBe('full')
    expect(nextSpan('full', 4)).toBe(1)
  })

  it('lands somewhere valid from a width the screen has outgrown', () => {
    expect(nextSpan(2, 2)).toBe(1)
  })
})

describe('effectiveSpan', () => {
  it('clamps rather than overflowing', () => {
    expect(effectiveSpan(2, 1)).toBe(1)
    expect(effectiveSpan('full', 3)).toBe(3)
    expect(effectiveSpan(2, 4)).toBe(2)
  })
})

describe('bands', () => {
  it('gathers a run of narrow sections into one masonry band', () => {
    const out = bands([item('a'), item('b'), item('c')], 3)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('masonry')
  })

  it('a wide section splits the run in two', () => {
    const out = bands([item('a'), item('w', { span: 'full' }), item('b')], 3)
    expect(out.map((b) => b.kind)).toEqual(['masonry', 'rows', 'masonry'])
  })

  it('packs consecutive wide sections into a row until the row is full', () => {
    const out = bands([item('x', { span: 2 }), item('y', { span: 2 }), item('z', { span: 2 })], 4)
    expect(out).toHaveLength(1)
    if (out[0].kind !== 'rows') throw new Error('expected rows')
    expect(out[0].rows.map((r) => r.map((c) => c.item.id))).toEqual([['x', 'y'], ['z']])
  })

  it('on one column everything is narrow, so it is all one band', () => {
    const out = bands([item('a', { span: 'full' }), item('b', { span: 2 })], 1)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('masonry')
  })
})

describe('setSpan', () => {
  it('touches only the section named', () => {
    const items = [item('a'), item('b')]
    const out = setSpan(items, 'b', 'full')
    expect(out[0]).toBe(items[0])
    expect(out[1].span).toBe('full')
  })
})

describe('options', () => {
  const donut = CATALOGUE[1]

  it('falls back to the first choice, which is the default', () => {
    expect(optionValue(donut, item('donut'), 'count')).toBe('5')
  })

  it('honours a stated default over the first choice, and ignores a nonsense one', () => {
    const stated: SectionDef = { id: 's', label: 'S', options: [{ ...COUNTS, defaultValue: '10' }] }
    expect(optionValue(stated, item('s'), 'count')).toBe('10')
    const bogus: SectionDef = { id: 's', label: 'S', options: [{ ...COUNTS, defaultValue: '7' }] }
    expect(optionValue(bogus, item('s'), 'count')).toBe('5')
  })

  it('reads a choice that was made', () => {
    expect(optionValue(donut, item('donut', { opts: { count: '10' } }), 'count')).toBe('10')
  })

  // The stored value is normalised on load, but a section can lose a choice
  // inside one session — a catalogue is rebuilt every render — and a chart
  // handed a number nobody offers is worse than one showing the default.
  it('falls back when the stored choice is no longer offered', () => {
    expect(optionValue(donut, item('donut', { opts: { count: '99' } }), 'count')).toBe('5')
  })

  it('says nothing about an option the section does not have', () => {
    expect(optionValue(donut, item('donut'), 'nope')).toBeUndefined()
    expect(optionsFor(CATALOGUE[2], item('trend'))).toEqual({})
  })

  it('resolves every option at once', () => {
    expect(optionsFor(donut, item('donut', { opts: { count: '10' } }))).toEqual({ count: '10' })
  })

  it('setOption touches only the section named, and keeps its other choices', () => {
    const items = [item('donut', { opts: { count: '5', other: 'x' } }), item('trend')]
    const out = setOption(items, 'donut', 'count', '10')
    expect(out[0].opts).toEqual({ count: '10', other: 'x' })
    expect(out[1]).toBe(items[1])
  })
})

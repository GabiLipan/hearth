import { describe, expect, it } from 'vitest'
import { CATEGORY_ICONS, CATEGORY_ICON_KEYS, ICON_GROUPS, searchIcons } from './CategoryIcon'

/**
 * The registry's rules, pinned. All three have a way of being broken by an
 * ordinary-looking edit, and none of them fail loudly at runtime.
 */

/**
 * Every key the app has ever stored. A key lives on rows in the database, so
 * renaming or removing one turns every category using it into the fallback tag
 * — silently, on both devices. This list only ever grows.
 */
const SHIPPED_KEYS = [
  'cart', 'home', 'car', 'dining', 'bag', 'tv', 'health', 'fun', 'package', 'wallet', 'coins',
  'bus', 'plane', 'fuel', 'coffee', 'gift', 'shirt', 'dumbbell', 'pill', 'stethoscope', 'book',
  'music', 'gamepad', 'film', 'pet', 'baby', 'education', 'plug', 'wifi', 'phone', 'card',
  'piggy', 'banknote', 'trending', 'heart', 'sparkles', 'plant', 'scissors', 'wrench', 'bike',
  'train', 'hotel', 'tag',
]

describe('the icon registry', () => {
  it('still has every key it has ever shipped', () => {
    const missing = SHIPPED_KEYS.filter((k) => !CATEGORY_ICONS[k])
    expect(missing).toEqual([])
  })

  it('never uses one key twice', () => {
    const keys = ICON_GROUPS.flatMap((g) => Object.keys(g.icons))
    expect(keys.length).toBe(new Set(keys).size)
  })

  it('never shows the same picture under two keys', () => {
    // Not a correctness problem, but a picker offering one icon twice looks
    // broken and nobody can tell which of the two they chose.
    const comps = ICON_GROUPS.flatMap((g) => Object.values(g.icons))
    expect(comps.length).toBe(new Set(comps).size)
  })

  it('is big enough to be worth searching', () => {
    expect(CATEGORY_ICON_KEYS.length).toBeGreaterThan(150)
  })
})

/**
 * The bank and card marks. They are ours rather than Lucide's, so two things
 * that come free everywhere else have to be asserted here: that they are in the
 * registry at all, and that each one carries a `displayName` — the search terms
 * are derived from it, so a mark without one can be found by typing its key and
 * by nothing else, which for a brand is the same as being unfindable.
 */
const BRAND_KEYS = [
  'visa', 'mastercard', 'amex', 'paypal', 'contactless', 'chipCard', 'atm', 'cheque',
  'lloyds', 'halifax', 'bankOfScotland', 'natwest', 'rbs', 'hsbc', 'barclays', 'santander',
  'nationwide', 'chase', 'monzo', 'starling',
]

describe('the bank and card marks', () => {
  it('are all in the registry', () => {
    expect(BRAND_KEYS.filter((k) => !CATEGORY_ICONS[k])).toEqual([])
  })

  it('each say what they are, so the search can find them', () => {
    const unnamed = BRAND_KEYS.filter(
      (k) => !(CATEGORY_ICONS[k] as { displayName?: string }).displayName,
    )
    expect(unnamed).toEqual([])
  })

  it('are findable by the name somebody would type rather than by their key', () => {
    // None of these words is the key.
    expect(searchIcons('american express')).toContain('amex')
    expect(searchIcons('royal bank')).toContain('rbs')
    expect(searchIcons('national westminster')).toContain('natwest')
    expect(searchIcons('building society')).toContain('nationwide')
    expect(searchIcons('tap')).toContain('contactless')
  })

  it('are a group you can pull up whole', () => {
    const hits = searchIcons('banks')
    for (const key of BRAND_KEYS) expect(hits).toContain(key)
  })
})

describe('searchIcons', () => {
  it('returns everything for an empty query', () => {
    expect(searchIcons('')).toEqual(CATEGORY_ICON_KEYS)
    expect(searchIcons('   ')).toEqual(CATEGORY_ICON_KEYS)
  })

  it('matches the key', () => {
    expect(searchIcons('coffee')).toContain('coffee')
  })

  it('matches the group, so a whole section can be pulled up by name', () => {
    expect(searchIcons('transport')).toContain('car')
    expect(searchIcons('transport')).not.toContain('coffee')
  })

  it('matches words in the Lucide name that the key never says', () => {
    // The reason the terms are derived rather than written: none of these keys
    // contains the word "shopping".
    const hits = searchIcons('shopping')
    expect(hits).toContain('cart')
    expect(hits).toContain('bag')
    expect(hits).toContain('basket')
  })

  it('narrows on each extra word rather than widening', () => {
    const food = searchIcons('food')
    const both = searchIcons('food cup')
    expect(both.length).toBeLessThan(food.length)
    expect(both.every((k) => food.includes(k))).toBe(true)
  })

  it('is case and space insensitive', () => {
    expect(searchIcons('  CoFFee ')).toEqual(searchIcons('coffee'))
  })

  it('finds nothing rather than everything for nonsense', () => {
    expect(searchIcons('zzzzzz')).toEqual([])
  })
})

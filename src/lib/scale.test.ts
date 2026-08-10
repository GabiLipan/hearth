import { describe, it, expect } from 'vitest'
import { niceScale } from './scale'

describe('niceScale', () => {
  it('rounds the top up to a step people read money in', () => {
    const s = niceScale(0, 237_00)
    expect(s.min).toBe(0)
    expect(s.max).toBe(300_00)
    expect(s.ticks).toEqual([0, 100_00, 200_00, 300_00])
  })

  it('picks the half-steps where they are the rounder answer', () => {
    expect(niceScale(0, 90_00).ticks).toEqual([0, 25_00, 50_00, 75_00, 100_00])
  })

  it('always includes zero, so a difference is not magnified into a collapse', () => {
    const s = niceScale(3_100_00, 3_300_00)
    expect(s.min).toBe(0)
    expect(s.ticks[0]).toBe(0)
  })

  it('puts zero inside the domain when something is negative', () => {
    const s = niceScale(-420_00, 900_00)
    expect(s.min).toBeLessThan(0)
    expect(s.max).toBeGreaterThanOrEqual(900_00)
    expect(s.ticks).toContain(0)
  })

  it('gives an empty chart an axis rather than one flat line', () => {
    expect(niceScale(0, 0)).toEqual({ min: 0, max: 1, ticks: [0, 1] })
  })

  it('produces integers — the values are minor units and land on pixels', () => {
    for (const max of [1, 7, 99, 1234, 987_654_32]) {
      for (const t of niceScale(0, max).ticks) expect(Number.isInteger(t)).toBe(true)
    }
  })

  it('spans the data it was given, whatever the magnitude', () => {
    for (const max of [3, 45, 512, 8_800, 1_250_000]) {
      const s = niceScale(0, max)
      expect(s.max).toBeGreaterThanOrEqual(max)
      expect(s.ticks[s.ticks.length - 1]).toBe(s.max)
      expect(s.ticks.length).toBeGreaterThanOrEqual(3)
      expect(s.ticks.length).toBeLessThanOrEqual(9)
    }
  })
})

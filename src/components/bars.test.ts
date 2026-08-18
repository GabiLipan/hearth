import { describe, expect, it } from 'vitest'
import { BAR_RADIUS, barRadius, roundedBar, stackedBar } from './charts'

/** The geometry a shape actually drew, read off the element it returned. */
const drew = (el: ReturnType<typeof roundedBar>) => el.props as Record<string, number | undefined>

describe('barRadius', () => {
  it('is the standard radius on a bar with room for it', () => {
    expect(barRadius(36, 120)).toBe(BAR_RADIUS)
  })

  it('never exceeds half the short side, whichever side that is', () => {
    // A low bar: what "fully rounded" means, and the case a fixed radius drew
    // as a shape with overlapping corners.
    expect(barRadius(36, 5)).toBe(2.5)
    // And a narrow one, which is the same rule ninety degrees round.
    expect(barRadius(3, 120)).toBe(1.5)
  })

  it('is never negative, however the box was measured', () => {
    expect(barRadius(0, 0)).toBe(0)
  })
})

describe('bar shapes', () => {
  it('draws a plain bar exactly where it was told to', () => {
    const r = drew(roundedBar({ x: 10, y: 20, width: 30, height: 100 }))
    expect([r.x, r.y, r.width, r.height]).toEqual([10, 20, 30, 100])
    expect(r.rx).toBe(BAR_RADIUS)
  })

  it('holds a stacked segment clear of the ones either side', () => {
    const r = drew(stackedBar({ x: 0, y: 50, width: 30, height: 100 }))
    // Half the gap at each end, so the band sits centred in the space it was
    // given rather than drifting up the stack.
    expect(r.height).toBe(98)
    expect(r.y).toBe(51)
  })

  it('will not squeeze a thin band out of existence to make room for a gap', () => {
    // A real figure disappearing because it was small is the one failure a
    // stack must not have.
    const r = drew(stackedBar({ x: 0, y: 0, width: 30, height: 1 }))
    expect(r.height).toBe(1)
    expect(r.rx).toBe(0.5)
  })

  it('draws a bar that hangs below the baseline', () => {
    // Recharts measures `base - value`, so a negative month arrives as a
    // negative height with `y` at the bar's LOWER edge. Read at face value that
    // is a rect the browser refuses to draw, which is how every negative bar in
    // "Kept each month" came to be missing.
    const r = drew(roundedBar({ x: 10, y: 160, width: 30, height: -40 }))
    expect(r.y).toBe(120)
    expect(r.height).toBe(40)
    expect(r.rx).toBe(BAR_RADIUS)
  })

  it('draws a bar measured leftwards, for a chart laid out the other way', () => {
    const r = drew(roundedBar({ x: 90, y: 0, width: -30, height: 20 }))
    expect(r.x).toBe(60)
    expect(r.width).toBe(30)
  })

  it('holds a stacked segment below the baseline clear too', () => {
    const r = drew(stackedBar({ x: 0, y: 150, width: 30, height: -100 }))
    expect(r.y).toBe(51)
    expect(r.height).toBe(98)
  })

  it('draws nothing at all for a bar with no value', () => {
    expect(drew(roundedBar({ x: 0, y: 0, width: 30, height: 0 })).x).toBeUndefined()
  })
})

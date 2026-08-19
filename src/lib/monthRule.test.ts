import { describe, expect, it } from 'vitest'
import { DEFAULT_MONTH_RULE } from './books'
import { parseMonthRule, ruleFromRemote } from './monthRule'

/**
 * The rule arrives from two directions — the server, and this device's cache of
 * what the server last said — and both of them can be nonsense. A screen that
 * cannot count a month is worse than one counting it the old way, so every path
 * here falls back rather than throwing.
 */
describe('reading the household month rule', () => {
  it('falls back to what the app did before the setting existed', () => {
    expect(parseMonthRule(undefined)).toEqual(DEFAULT_MONTH_RULE)
    expect(parseMonthRule('')).toEqual(DEFAULT_MONTH_RULE)
    expect(parseMonthRule('not json')).toEqual(DEFAULT_MONTH_RULE)
  })

  it('reads a rule that has been turned off', () => {
    // Null is a real answer — "never shift this" — and must survive the round
    // trip, rather than being mistaken for an absent value and defaulted to 25.
    expect(parseMonthRule('{"contributionDay":null,"incomeDay":null}')).toEqual({
      contributionDay: null,
      incomeDay: null,
    })
  })

  it('keeps the two days apart', () => {
    expect(parseMonthRule('{"contributionDay":24,"incomeDay":23}')).toEqual({
      contributionDay: 24,
      incomeDay: 23,
    })
  })

  it('refuses a day it could not act on', () => {
    // 31 is the interesting one: it is a real day, and a cutoff on it would do
    // nothing at all in February. The constraint says 1..28 and so does this.
    expect(parseMonthRule('{"contributionDay":31,"incomeDay":0}')).toEqual({
      contributionDay: null,
      incomeDay: null,
    })
    expect(parseMonthRule('{"contributionDay":"25"}').contributionDay).toBeNull()
    expect(parseMonthRule('{"contributionDay":12.5}').contributionDay).toBeNull()
  })

  it('reads the server row, where an unset day is null', () => {
    expect(ruleFromRemote({ contribution_cutoff_day: 24, income_cutoff_day: null })).toEqual({
      contributionDay: 24,
      incomeDay: null,
    })
  })

  it('defaults both days to the constant it replaced', () => {
    // Nothing may move for anybody on the day this ships. 18-contributions.sql
    // had already widened the shift from contributions to every arrival, so
    // both halves start where that left them.
    expect(DEFAULT_MONTH_RULE).toEqual({ contributionDay: 25, incomeDay: 25 })
  })
})

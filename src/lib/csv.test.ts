import { describe, expect, it } from 'vitest'
import { toCSV, csvAmount } from './csv'

describe('toCSV', () => {
  it('quotes every cell, so a comma in a name cannot shift a column', () => {
    expect(toCSV([['Category', 'Spent'], ['Home & utilities, shared', '120.00']])).toBe(
      '"Category","Spent"\r\n"Home & utilities, shared","120.00"',
    )
  })

  it('doubles a quote rather than escaping it, which is what the format says', () => {
    expect(toCSV([['He said "hi"']])).toBe('"He said ""hi"""')
  })

  it('survives a newline inside a cell — a note pasted from somewhere else', () => {
    // Legal CSV: the quoting is what makes the embedded break parseable.
    expect(toCSV([['two\nlines', 1]])).toBe('"two\nlines","1"')
  })

  it('writes nothing for no rows rather than a stray line ending', () => {
    expect(toCSV([])).toBe('')
  })
})

describe('csvAmount', () => {
  it('is a plain decimal, not money — a spreadsheet has to be able to add it up', () => {
    expect(csvAmount(123456)).toBe('1234.56')
    expect(csvAmount(-500)).toBe('-5.00')
    expect(csvAmount(0)).toBe('0.00')
  })

  it('keeps the pence a whole pound would drop', () => {
    expect(csvAmount(100)).toBe('1.00')
  })
})

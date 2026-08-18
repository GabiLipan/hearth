import { describe, expect, it } from 'vitest'
import { toCSV, csvAmount, parseCSV, guessMapping, extractRows, mappingKey, readMapping, writeMapping } from './csv'

/** Read a whole file the way the wizard does: guess, then extract. */
const importAll = (text: string) => {
  const csv = parseCSV(text)
  const mapping = guessMapping(csv)
  return { mapping, rows: extractRows(csv, mapping) }
}
const amounts = (text: string) => importAll(text).rows.map((r) => r.amountMinor)

describe('working out how a statement is laid out', () => {
  it('reads two positive columns, out and in', () => {
    // The commonest UK export, and the one the app used to get wrong.
    const { mapping, rows } = importAll(
      [
        'Date,Description,Money Out,Money In',
        '01/03/2026,TESCO STORES,45.20,',
        '02/03/2026,SALARY,,2500.00',
        '03/03/2026,ODEON,15.00,',
      ].join('\n'),
    )

    expect(mapping.layout).toBe('split')
    expect(mapping.amount).toBe(2)
    expect(mapping.moneyIn).toBe(3)
    expect(rows.map((r) => r.amountMinor)).toEqual([-4520, 250000, -1500])
    expect(rows.every((r) => r.valid)).toBe(true)
  })

  it('does not mistake "Debit Amount" for a signed column', () => {
    // The generic search for `amount` used to hit the DEBIT column and read it
    // as signed, so every expense in the file imported as income.
    expect(
      amounts(
        [
          'Date,Narrative,Debit Amount,Credit Amount,Balance',
          '01/03/2026,TESCO,45.20,,1000.00',
          '02/03/2026,SALARY,,2500.00,3500.00',
        ].join('\n'),
      ),
    ).toEqual([-4520, 250000])
  })

  it('does not read a running balance as money in', () => {
    // A substring search for `in` matched "Running Balance" — importing the
    // balance as income on every row.
    const { mapping } = importAll(
      [
        'Date,Description,Amount,Running Balance',
        '01/03/2026,TESCO,-45.20,954.80',
        '02/03/2026,SALARY,2500.00,3454.80',
      ].join('\n'),
    )

    expect(mapping.layout).toBe('signed')
    expect(mapping.moneyIn).toBe(-1)
  })

  it('still reads a plain signed column', () => {
    expect(
      amounts(
        ['Date,Description,Amount', '01/03/2026,TESCO,-45.20', '02/03/2026,SALARY,2500.00'].join('\n'),
      ),
    ).toEqual([-4520, 250000])
  })

  it('takes the side as the sign, not the value', () => {
    // Some banks write money out negative in a split file. Whatever is in the
    // out column is an outflow, however it was written.
    expect(
      amounts(
        [
          'Date,Description,Paid Out,Paid In',
          '01/03/2026,TESCO,-45.20,',
          '02/03/2026,SALARY,,2500.00',
        ].join('\n'),
      ),
    ).toEqual([-4520, 250000])
  })

  it('finds the pair from the rows when the headings are no help', () => {
    // Headerless, or named in a language nobody thought of. The two columns are
    // complementary, which is the giveaway.
    const { mapping } = importAll(
      [
        'Dato,Tekst,Ut,Inn',
        '01/03/2026,REMA 1000,45.20,',
        '02/03/2026,LONN,,2500.00',
        '03/03/2026,KAFFE,8.00,',
      ].join('\n'),
    )

    expect(mapping.layout).toBe('split')
    expect(mapping.amount).toBe(2)
    expect(mapping.moneyIn).toBe(3)
  })

  it('does not pair two columns that are both filled on every row', () => {
    // Amount beside Balance is not an out/in pair, whatever they are called.
    const { mapping } = importAll(
      [
        'Date,Description,Out,Balance',
        '01/03/2026,TESCO,45.20,954.80',
        '02/03/2026,COFFEE,3.20,951.60',
      ].join('\n'),
    )
    expect(mapping.layout).toBe('signed')
  })

  it('handles currency symbols, thousands separators and parentheses', () => {
    expect(
      amounts(
        [
          'Date,Description,Amount',
          '01/03/2026,RENT,"(1,250.00)"',
          '02/03/2026,BONUS,"£1,000.00"',
        ].join('\n'),
      ),
    ).toEqual([-125000, 100000])
  })

  it('reads a card statement, where a purchase is a plus', () => {
    // Amex: one Amount column, positive for a charge and negative for the
    // payment that clears the card — a bank statement with every sign the
    // other way round. Read at face value, every purchase became income.
    const { mapping, rows } = importAll(
      [
        'Date,Description,Card Member,Account #,Amount',
        '01/03/2026,TESCO STORES,A LIPAN,-71001,45.20',
        '02/03/2026,ODEON CINEMAS,A LIPAN,-71001,15.00',
        '03/03/2026,AMAZON UK,A LIPAN,-71001,32.99',
        '15/03/2026,PAYMENT RECEIVED - THANK YOU,A LIPAN,-71001,-300.00',
      ].join('\n'),
    )

    expect(mapping.layout).toBe('signed')
    expect(mapping.invert).toBe(true)
    expect(rows.map((r) => r.amountMinor)).toEqual([-4520, -1500, -3299, 30000])
  })

  it('leaves a bank statement alone, which is the half that matters', () => {
    // Mostly negatives with a salary in the middle. A false positive here would
    // invert a file that has always imported correctly.
    const { mapping, rows } = importAll(
      [
        'Date,Description,Amount',
        '01/03/2026,TESCO,-45.20',
        '02/03/2026,RENT,-1250.00',
        '03/03/2026,SALARY,2500.00',
        '04/03/2026,COFFEE,-3.20',
      ].join('\n'),
    )

    expect(mapping.invert).toBe(false)
    expect(rows.map((r) => r.amountMinor)).toEqual([-4520, -125000, 250000, -320])
  })

  it('never asks the sign question of a split file, where the column has answered it', () => {
    const { mapping } = importAll(
      [
        'Date,Description,Money Out,Money In',
        '01/03/2026,TESCO,45.20,',
        '02/03/2026,SALARY,,2500.00',
      ].join('\n'),
    )

    expect(mapping.layout).toBe('split')
    expect(mapping.invert).toBe(false)
  })

  it('does not call a column of pure income a card', () => {
    // No negative at all is step 4's case — a direction living in some column
    // we never matched — not a card statement.
    const { mapping } = importAll(
      [
        'Date,Description,Amount',
        '01/03/2026,SALARY,2500.00',
        '02/03/2026,INTEREST,1.20',
      ].join('\n'),
    )

    expect(mapping.invert).toBe(false)
  })

  it('marks a row with no amount as invalid rather than importing a zero', () => {
    const { rows } = importAll(
      [
        'Date,Description,Money Out,Money In',
        '01/03/2026,TESCO,45.20,',
        '02/03/2026,BALANCE BROUGHT FORWARD,,',
      ].join('\n'),
    )
    expect(rows[1].valid).toBe(false)
  })
})

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

describe('remembering a layout', () => {
  const file = parseCSV(
    ['Date,Description,Money Out,Money In', '01/03/2026,TESCO,45.20,', '02/03/2026,SALARY,,2500.00'].join('\n'),
  )

  it('keys on the headers, not the account', () => {
    // One bank exports one format, so the answer should carry across accounts
    // at the same bank and not across two banks sharing one.
    const same = parseCSV(['date,description,money out,money in', '01/03/2026,X,1.00,'].join('\n'))
    expect(mappingKey(file.headers)).toBe(mappingKey(same.headers))
    expect(mappingKey(file.headers)).not.toBe(mappingKey(['Date', 'Detail', 'Amount']))
  })

  it('round-trips a mapping', () => {
    const m = guessMapping(file)
    expect(readMapping(writeMapping(m, file), file)).toEqual(m)
  })

  it('refuses a mapping from a file with a different number of columns', () => {
    // Stored state can outlive the thing it describes, and applying a stale
    // mapping would point "money in" at a column that is now something else.
    const narrower = parseCSV(['Date,Description,Amount', '01/03/2026,TESCO,-45.20'].join('\n'))
    expect(readMapping(writeMapping(guessMapping(file), file), narrower)).toBeUndefined()
  })

  it('refuses an index that is out of range, and anything unreadable', () => {
    expect(readMapping(JSON.stringify({ ...guessMapping(file), columns: 4, amount: 9 }), file)).toBeUndefined()
    expect(readMapping('not json', file)).toBeUndefined()
    expect(readMapping(undefined, file)).toBeUndefined()
  })

  it('accepts a mapping stored before the sign question existed', () => {
    // The columns in it are still right, and rejecting it would send every bank
    // the app has already learned back to guessing.
    const card = parseCSV(['Date,Description,Amount', '01/03/2026,TESCO,45.20'].join('\n'))
    const { invert: _dropped, ...old } = guessMapping(card)
    const m = readMapping(JSON.stringify({ ...old, columns: 3 }), card)
    expect(m?.invert).toBe(false)
  })

  it('remembers the sign question, so a card is answered once', () => {
    const card = parseCSV(
      [
        'Date,Description,Amount',
        '01/03/2026,TESCO,45.20',
        '02/03/2026,ODEON,15.00',
        '03/03/2026,AMAZON,32.99',
        '15/03/2026,PAYMENT,-300.00',
      ].join('\n'),
    )
    const m = guessMapping(card)
    expect(m.invert).toBe(true)
    expect(readMapping(writeMapping(m, card), card)?.invert).toBe(true)
  })

  it('drops a remembered sign question on a split file, where it means nothing', () => {
    const stored = { ...guessMapping(file), invert: true, columns: 4 }
    expect(readMapping(JSON.stringify(stored), file)?.invert).toBe(false)
  })

  it('refuses a split mapping with no money-in column', () => {
    const broken = { ...guessMapping(file), columns: 4, layout: 'split' as const, moneyIn: -1 }
    expect(readMapping(JSON.stringify(broken), file)).toBeUndefined()
  })
})

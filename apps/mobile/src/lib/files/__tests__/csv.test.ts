import { delimiterFor, parseDelimited } from '@/lib/files/csv'

describe('delimiterFor', () => {
  it('uses tabs for .tsv and commas otherwise', () => {
    expect(delimiterFor('tsv')).toBe('\t')
    expect(delimiterFor('csv')).toBe(',')
    expect(delimiterFor('')).toBe(',')
  })
})

describe('parseDelimited', () => {
  it('parses a plain grid', () => {
    const table = parseDelimited('a,b,c\n1,2,3\n4,5,6')
    expect(table.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6']
    ])
    expect(table.columns).toBe(3)
    expect(table.totalRows).toBe(3)
    expect(table.truncated).toBe(false)
  })

  it('honors quoted fields, embedded delimiters, newlines and escaped quotes', () => {
    const table = parseDelimited('name,note\n"Doe, Jane","said ""hi""\nagain"')
    expect(table.rows[1]).toEqual(['Doe, Jane', 'said "hi"\nagain'])
  })

  it('pads short rows so the grid stays rectangular', () => {
    const table = parseDelimited('a,b,c\n1\n2,3')
    expect(table.columns).toBe(3)
    expect(table.rows[1]).toEqual(['1', '', ''])
    expect(table.rows[2]).toEqual(['2', '3', ''])
  })

  it('handles CRLF line endings and a missing trailing newline', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(parseDelimited('a,b\n1,2').totalRows).toBe(2)
  })

  it('parses tabs when told to', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t').rows[1]).toEqual(['1', '2'])
  })

  it('caps materialized rows but reports the true total', () => {
    const text = Array.from({ length: 50 }, (_, i) => `${i},x`).join('\n')
    const table = parseDelimited(text, ',', 10)
    expect(table.rows).toHaveLength(10)
    expect(table.totalRows).toBe(50)
    expect(table.truncated).toBe(true)
  })

  it('never throws on malformed or empty input', () => {
    expect(() => parseDelimited('')).not.toThrow()
    expect(parseDelimited('').rows).toEqual([])
    // Unterminated quote: keep what was parsed rather than failing the card.
    expect(parseDelimited('a,"unterminated\nb,c').rows.length).toBeGreaterThan(0)
  })
})

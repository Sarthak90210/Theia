import { describe, expect, it } from 'vitest'
import { parseQuery } from '../src/search/query.ts'

/** Dates are read in local wall-clock time, as Date.UTC values. Today is Saturday 21 November 2026. */
const now = new Date(2026, 10, 21, 15, 30)
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d)
const parse = (q: string) => parseQuery(q, now)

describe('reading dates and kinds out of a query', () => {
  it('takes a month after "last" as the most recent one gone by', () => {
    expect(parse('goa beach last december')).toEqual({
      text: 'goa beach', filter: { range: { from: day(2025, 12, 1), to: day(2026, 1, 1) } }, labels: ['December 2025'],
    })
    expect(parse('last march').filter.range).toEqual({ from: day(2026, 3, 1), to: day(2026, 4, 1) })
    expect(parse('this november').filter.range).toEqual({ from: day(2026, 11, 1), to: day(2026, 12, 1) })
  })

  it('reads months with and without a year or day', () => {
    expect(parse('december 2024').filter.range).toEqual({ from: day(2024, 12, 1), to: day(2025, 1, 1) })
    expect(parse('25 dec 2024').filter.range).toEqual({ from: day(2024, 12, 25), to: day(2024, 12, 26) })
    expect(parse('diwali november 12, 2023')).toMatchObject({ text: 'diwali', filter: { range: { from: day(2023, 11, 12), to: day(2023, 11, 13) } } })
    expect(parse('snow in december')).toEqual({ text: 'snow', filter: { month: 11 }, labels: ['December, any year'] })
    expect(parse('25th december').filter).toEqual({ month: 11, day: 25 })
  })

  it('reads relative dates', () => {
    expect(parse('today').filter.range).toEqual({ from: day(2026, 11, 21), to: day(2026, 11, 22) })
    expect(parse('yesterday').filter.range).toEqual({ from: day(2026, 11, 20), to: day(2026, 11, 21) })
    expect(parse('last week').filter.range).toEqual({ from: day(2026, 11, 9), to: day(2026, 11, 16) })
    expect(parse('this weekend').filter.range).toEqual({ from: day(2026, 11, 21), to: day(2026, 11, 23) })
    expect(parse('last month').filter.range).toEqual({ from: day(2026, 10, 1), to: day(2026, 11, 1) })
    expect(parse('last year').filter.range).toEqual({ from: day(2025, 1, 1), to: day(2026, 1, 1) })
    expect(parse('past 3 months').filter.range).toEqual({ from: day(2026, 8, 21), to: day(2026, 11, 22) })
    expect(parse('2 years ago').filter.range).toEqual({ from: day(2024, 1, 1), to: day(2025, 1, 1) })
    expect(parse('a month ago').filter.range).toEqual({ from: day(2026, 10, 1), to: day(2026, 11, 1) })
  })

  it('reads years, and open ranges', () => {
    expect(parse('photos from 2024')).toEqual({ text: '', filter: { range: { from: day(2024, 1, 1), to: day(2025, 1, 1) } }, labels: ['2024'] })
    expect(parse('since march 2025').filter.range).toEqual({ from: day(2025, 3, 1), to: Infinity })
    expect(parse('before 2020').filter.range).toEqual({ from: -Infinity, to: day(2020, 1, 1) })
  })

  it('reads Hindi', () => {
    expect(parse('मंदिर पिछले साल')).toMatchObject({ text: 'मंदिर', filter: { range: { from: day(2025, 1, 1), to: day(2026, 1, 1) } } })
    expect(parse('पिछले दिसंबर').filter.range).toEqual({ from: day(2025, 12, 1), to: day(2026, 1, 1) })
    expect(parse('2 साल पहले').filter.range).toEqual({ from: day(2024, 1, 1), to: day(2025, 1, 1) })
  })

  it('reads videos and favourites as filters', () => {
    expect(parse('videos from last year')).toMatchObject({ text: '', filter: { kinds: ['video'], range: { from: day(2025, 1, 1) } } })
    expect(parse('favourite sunsets')).toEqual({ text: 'sunsets', filter: { favourite: true }, labels: ['Favourites'] })
  })

  it('leaves alone what is not a date', () => {
    expect(parse('beach')).toEqual({ text: 'beach', filter: {}, labels: [] })
    expect(parse('may i have this dance')).toEqual({ text: 'may i have this dance', filter: {}, labels: [] })
    expect(parse('in may').filter).toEqual({ month: 4 })
    expect(parse('aadhaar 4821 7735')).toEqual({ text: 'aadhaar 4821 7735', filter: {}, labels: [] })
    expect(parse('a december wedding').filter).toEqual({ month: 11 })
    expect(parse('constructor').filter).toEqual({})
    expect(parse('last constructor').text).toBe('last constructor')
  })
})

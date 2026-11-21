/**
 * Reads dates and media types out of a typed query before the rest is
 * searched by meaning and by text, so "goa beach last december" looks for
 * "goa beach" among photos taken in December last year, instead of hoping the
 * model understands calendars.
 *
 * Plain rules, English and Hindi. Dates are compared in the photo's own local
 * time (capture time plus its offset), so a photo taken at 11pm on 31 December
 * in Goa counts as December wherever the library is opened.
 *
 * No Node imports: the window uses this too, to say what it understood.
 */

/** Local wall-clock times as UTC milliseconds: Date.UTC(year, month, day). */
export interface DateRange {
  from: number
  /** Exclusive. */
  to: number
}

export interface SearchFilter {
  range?: DateRange
  /** 0 to 11, in any year ("photos from december"). */
  month?: number
  /** 1 to 31, with month, in any year ("25 december"). */
  day?: number
  kinds?: string[]
  favourite?: boolean
  /** Named people who must all be in the photo (found by the vault, not by this parser). */
  people?: number[]
}

export interface ParsedQuery {
  /** What is left to search by meaning and by text. Empty when only filters were typed. */
  text: string
  filter: SearchFilter
  /** What was understood, for the window: "December 2025", "Videos". */
  labels: string[]
}

const MONTHS: Record<string, number> = {}
;[
  ['january', 'jan', 'जनवरी'],
  ['february', 'feb', 'फरवरी', 'फ़रवरी'],
  ['march', 'mar', 'मार्च'],
  ['april', 'apr', 'अप्रैल', 'अप्रेल'],
  ['may', 'मई'],
  ['june', 'jun', 'जून'],
  ['july', 'jul', 'जुलाई'],
  ['august', 'aug', 'अगस्त'],
  ['september', 'sep', 'sept', 'सितंबर', 'सितम्बर'],
  ['october', 'oct', 'अक्टूबर', 'अक्तूबर'],
  ['november', 'nov', 'नवंबर', 'नवम्बर'],
  ['december', 'dec', 'दिसंबर', 'दिसम्बर'],
].forEach((names, i) => names.forEach((n) => (MONTHS[n] = i)))

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

type Unit = 'day' | 'week' | 'month' | 'year' | 'weekend'
const UNITS: Record<string, Unit> = {
  day: 'day', days: 'day', दिन: 'day',
  week: 'week', weeks: 'week', हफ्ते: 'week', हफ़्ते: 'week', हफ्ता: 'week', हफ़्ता: 'week', सप्ताह: 'week',
  month: 'month', months: 'month', महीने: 'month', महीना: 'month', माह: 'month',
  year: 'year', years: 'year', साल: 'year', वर्ष: 'year', बरस: 'year',
  weekend: 'weekend',
}

const LAST = new Set(['last', 'previous', 'पिछले', 'पिछला', 'पिछली', 'गत'])
const THIS = new Set(['this', 'इस', 'यह'])
const PAST = new Set(['past', 'last'])
const AGO = new Set(['ago', 'पहले'])
const SINCE = new Set(['since', 'after'])
const BEFORE = new Set(['before', 'until'])
/** Dropped when they lead into a date: "goa in december". */
const LEADS = new Set(['in', 'on', 'from', 'during', 'of', 'taken', 'around', 'में'])
const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
}
/** Words that only say "show me photos". A query of nothing else is a filter alone. */
const FILLER = new Set(['photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'image', 'images', 'show', 'me', 'my', 'all',
  'the', 'from', 'in', 'of', 'taken', 'फोटो', 'फ़ोटो', 'तस्वीरें', 'तस्वीर', 'की', 'के', 'का'])

const DAY = 86_400_000

/** Own keys only: "constructor" is not a month. */
function own(table: object, key: string | undefined): key is string {
  return key !== undefined && Object.hasOwn(table, key)
}

interface Token {
  word: string
  used: boolean
}

export function parseQuery(input: string, now = new Date()): ParsedQuery {
  const tokens: Token[] = (input.toLowerCase().normalize('NFC').match(/[\p{L}\p{M}\p{N}'-]+/gu) ?? [])
    .map((w) => ({ word: w.replace(/^'+|'+$/g, ''), used: false }))
    .filter((t) => t.word)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const filter: SearchFilter = {}
  const labels: string[] = []

  const word = (i: number) => tokens[i]?.word
  const num = (i: number): number | null => {
    const w = word(i)
    if (w === undefined) return null
    if (own(NUMBERS, w)) return NUMBERS[w]!
    const m = /^(\d{1,4})(st|nd|rd|th)?$/.exec(w)
    return m ? Number(m[1]) : null
  }
  const isYear = (n: number | null) => n !== null && n >= 1970 && n <= now.getFullYear() + 1
  const take = (from: number, to: number) => {
    for (let k = from; k < to; k++) tokens[k]!.used = true
    // "in december", "from last year": the lead-in goes with the date.
    if (from > 0 && LEADS.has(word(from - 1)!)) tokens[from - 1]!.used = true
  }

  /** A date expression starting at i: its range or month, and how many words it took. */
  const dateAt = (i: number): { len: number; range?: DateRange; month?: number; day?: number; label: string } | null => {
    const w = word(i)
    if (w === undefined) return null
    if (w === 'today' || w === 'आज') return { len: 1, range: { from: today, to: today + DAY }, label: 'Today' }
    if (w === 'yesterday' || w === 'कल') return { len: 1, range: { from: today - DAY, to: today }, label: 'Yesterday' }

    // "last week", "this year", "पिछले साल"
    if ((LAST.has(w) || THIS.has(w)) && own(UNITS, word(i + 1))) {
      const unit = UNITS[word(i + 1)!]!
      const back = LAST.has(w) ? 1 : 0
      return { len: 2, range: unitRange(unit, today, back), label: `${back ? 'Last' : 'This'} ${unit}` }
    }
    // "past 3 months", "last 2 weeks": up to today
    const n1 = num(i + 1)
    if (PAST.has(w) && n1 !== null && !isYear(n1) && own(UNITS, word(i + 2))) {
      const unit = UNITS[word(i + 2)!]!
      if (unit !== 'weekend') {
        return { len: 3, range: { from: shift(unit, today, -n1), to: today + DAY }, label: `Past ${n1} ${unit}${n1 === 1 ? '' : 's'}` }
      }
    }
    // "3 months ago", "2 साल पहले"
    const n0 = num(i)
    if (n0 !== null && !isYear(n0) && own(UNITS, word(i + 1)) && AGO.has(word(i + 2)!)) {
      const unit = UNITS[word(i + 1)!]!
      if (unit !== 'weekend') {
        return { len: 3, range: unitRange(unit, today, n0), label: `${n0} ${unit}${n0 === 1 ? '' : 's'} ago` }
      }
    }

    // "last december", "this march", "पिछले दिसंबर"
    if ((LAST.has(w) || THIS.has(w)) && own(MONTHS, word(i + 1))) {
      const month = MONTHS[word(i + 1)!]!
      const y = now.getFullYear()
      const year = LAST.has(w) ? (month < now.getMonth() ? y : y - 1) : y
      return { len: 2, range: monthRange(year, month), label: `${MONTH_NAMES[month]} ${year}` }
    }

    // "25 december 2024", "december 25, 2024", "dec 2024", "december"
    let day: number | null = null
    let j = i
    if (n0 !== null && /^\d/.test(w) && n0 >= 1 && n0 <= 31 && own(MONTHS, word(i + 1))) {
      day = n0
      j = i + 1
    }
    if (own(MONTHS, word(j))) {
      const month = MONTHS[word(j)!]!
      let len = j - i + 1
      const after = num(j + 1)
      if (day === null && after !== null && /^\d/.test(word(j + 1)!) && after >= 1 && after <= 31 && !isYear(after)) {
        day = after
        len++
      }
      const year = num(i + len)
      // "may" is also a verb: alone it only counts after a lead-in or with a number.
      if (word(j) === 'may' && day === null && !isYear(year) && !(i > 0 && LEADS.has(word(i - 1)!))) return null
      if (isYear(year)) {
        len++
        if (day !== null) {
          const from = Date.UTC(year!, month, day)
          return { len, range: { from, to: from + DAY }, label: `${day} ${MONTH_NAMES[month]} ${year}` }
        }
        return { len, range: monthRange(year!, month), label: `${MONTH_NAMES[month]} ${year}` }
      }
      return day !== null
        ? { len, month, day, label: `${day} ${MONTH_NAMES[month]}, any year` }
        : { len, month, label: `${MONTH_NAMES[month]}, any year` }
    }

    // "2024"
    if (isYear(n0) && /^\d{4}$/.test(w)) {
      return { len: 1, range: { from: Date.UTC(n0!, 0, 1), to: Date.UTC(n0! + 1, 0, 1) }, label: String(n0) }
    }
    return null
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.used) continue
    const w = word(i)!
    const open = SINCE.has(w) ? 'since' : BEFORE.has(w) ? 'before' : null
    const d = dateAt(open ? i + 1 : i)
    if (!d) {
      if (w === 'video' || w === 'videos' || w === 'वीडियो') {
        filter.kinds = ['video']
        labels.push('Videos')
        take(i, i + 1)
      } else if (/^favou?rites?$/.test(w) || w === 'pasandida' || w === 'पसंदीदा') {
        filter.favourite = true
        labels.push('Favourites')
        take(i, i + 1)
      }
      continue
    }
    const start = i
    const end = (open ? i + 1 : i) + d.len
    if (d.range) {
      const r = open === 'since' ? { from: d.range.from, to: Infinity } : open === 'before' ? { from: -Infinity, to: d.range.from } : d.range
      filter.range = filter.range ? { from: Math.max(filter.range.from, r.from), to: Math.min(filter.range.to, r.to) } : r
      labels.push(open ? `${open === 'since' ? 'Since' : 'Before'} ${d.label}` : d.label)
    } else if (!open) {
      filter.month = d.month
      if (d.day !== undefined) filter.day = d.day
      labels.push(d.label)
    } else {
      continue
    }
    take(start, end)
    i = end - 1
  }

  const left = tokens.filter((t) => !t.used).map((t) => t.word)
  const text = left.every((w) => FILLER.has(w)) ? '' : left.join(' ')
  return { text, filter, labels }
}

export function hasFilter(f: SearchFilter): boolean {
  return !!f.range || f.month !== undefined || !!f.kinds?.length || !!f.favourite || !!f.people?.length
}

function monthRange(year: number, month: number): DateRange {
  return { from: Date.UTC(year, month, 1), to: Date.UTC(year, month + 1, 1) }
}

/** The calendar unit `back` units before the one holding today. Weeks start on Monday. */
function unitRange(unit: Unit, today: number, back: number): DateRange {
  const d = new Date(today)
  if (unit === 'day') return { from: today - back * DAY, to: today - back * DAY + DAY }
  if (unit === 'week' || unit === 'weekend') {
    const monday = today - ((d.getUTCDay() + 6) % 7) * DAY - back * 7 * DAY
    return unit === 'week' ? { from: monday, to: monday + 7 * DAY } : { from: monday + 5 * DAY, to: monday + 7 * DAY }
  }
  if (unit === 'month') return monthRange(d.getUTCFullYear(), d.getUTCMonth() - back)
  return { from: Date.UTC(d.getUTCFullYear() - back, 0, 1), to: Date.UTC(d.getUTCFullYear() - back + 1, 0, 1) }
}

function shift(unit: Exclude<Unit, 'weekend'>, today: number, n: number): number {
  const d = new Date(today)
  if (unit === 'day') return today + n * DAY
  if (unit === 'week') return today + n * 7 * DAY
  if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate())
  return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate())
}

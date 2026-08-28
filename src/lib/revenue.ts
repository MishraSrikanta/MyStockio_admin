/**
 * Money: what came in, what went back out, and what the taxman is owed out of it.
 *
 * Every figure the dashboard and the GST report show is computed here — pure functions, no React
 * and no network, so the arithmetic can be asserted instead of hoped for. That matters more here
 * than anywhere else in the app: a wrong number on this screen is a wrong number on a tax return.
 *
 * ══ THE THREE DECISIONS BEHIND EVERY FIGURE ══════════════════════════════════════
 *
 * **1. Prices are GST-inclusive.** ₹3,000 for a year means the customer paid ₹3,000 in total, of
 * which ₹457.63 is the tax. The alternative reading — ₹3,000 plus ₹540 tax — would overstate
 * revenue by 18% and understate the liability, so it is stated once here and used everywhere. If
 * the price list is ever quoted exclusive of tax, flip `GST_INCLUSIVE` and every figure follows.
 *
 * **2. A refund is a negative line in the same ledger, not a deletion.** Money that came in and
 * went back out both happened, and both belong in the record: `gross` counts what was collected,
 * `refunds` what was returned, and `net` is what the business actually kept. Deleting the original
 * payment instead would silently rewrite history and quietly reduce the GST already declared.
 *
 * **3. "Profit" is only shown when there is a cost to subtract.** Revenue minus nothing is not
 * profit, and a dashboard that labels it so is lying in the most flattering direction. Set
 * `MONTHLY_COSTS` and the figure appears; leave it at zero and the screen says the cost side is
 * unknown rather than showing net revenue under a better name.
 */

import { GST_INCLUSIVE, GST_RATE, MONTHLY_COSTS } from './config'

/**
 * One line in the money ledger, as the admin API returns it.
 *
 * `type` is optional because a backend that has never heard of refunds simply omits it, and every
 * such row is a payment. That default is load-bearing: reading a missing `type` as anything else
 * would turn an ordinary payment history into a refund history.
 */
export interface Payment {
  id: string
  accountId: string
  /** Always positive, refunds included. The direction lives in `type`, not in the sign. */
  amount: number
  plan?: string
  method?: string
  reference?: string
  note?: string
  /** ISO timestamp. */
  at: string
  recordedBy?: string
  type?: 'payment' | 'refund'
}

export function isRefund(line: Payment): boolean {
  return line.type === 'refund'
}

/* ────────────────────────────────────────────── reading what arrived ── */

/** The field names a backend might use for "when this happened". Checked in this order. */
const WHEN_FIELDS = ['at', 'createdAt', 'paidAt', 'date', 'timestamp', 'created_at'] as const

/**
 * Turns a row from the payments route into the shape every figure here is computed from.
 *
 * ══ WHY THIS EXISTS ══════════════════════════════════════════════════════════════
 *
 * The live backend sends **`createdAt`**; this app read **`at`**. One field name apart, and the
 * result was not a visible error but a **silent zero**: `new Date(undefined)` is an invalid date,
 * every row fell outside every period, and a dashboard built on ₹17,000 of real payments displayed
 * ₹0 while cheerfully claiming the ledger was empty.
 *
 * That is the worst shape a bug can take on a money screen — no error, no empty state, just a
 * confident wrong number — so the fix is not "rename the field" but "stop trusting one spelling".
 * Anything that reaches the app goes through here first, and the rest of this file can then assume
 * one clean shape.
 *
 * Tolerated on purpose: `createdAt` / `paidAt` / `date` / `timestamp` for the date, `_id` for the
 * id, a numeric **string** for the amount (JSON from a decimal column often arrives quoted), and a
 * Mongo `{ $numberDecimal }` wrapper.
 *
 * **A row with no readable date is kept, not dropped.** It cannot sit in a month, but money that
 * exists must not vanish because its timestamp was unreadable — `undatedCount` lets a screen say so
 * out loud instead.
 */
export function normalisePayment(raw: unknown): Payment | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>

  const id = String(row.id ?? row._id ?? '')
  const accountId = String(
    row.accountId ??
      row.account ??
      (typeof row.account === 'object' && row.account ? (row.account as Record<string, unknown>)._id : '') ??
      '',
  )

  const amount = readAmount(row.amount)
  if (!Number.isFinite(amount)) return null

  return {
    id: id || `${accountId}-${String(row.createdAt ?? row.at ?? '')}`,
    accountId,
    amount,
    plan: row.plan === undefined || row.plan === null ? undefined : String(row.plan),
    method: row.method === undefined || row.method === null ? undefined : String(row.method),
    reference: row.reference === undefined || row.reference === null ? undefined : String(row.reference),
    note: row.note === undefined || row.note === null ? undefined : String(row.note),
    at: readWhen(row),
    recordedBy:
      row.recordedByEmail !== undefined && row.recordedByEmail !== null && row.recordedByEmail !== ''
        ? String(row.recordedByEmail)
        : row.recordedBy === undefined || row.recordedBy === null
          ? undefined
          : String(row.recordedBy),
    /* Anything that is not exactly 'refund' is a payment — including a row with no type at all. */
    type: String(row.type ?? 'payment') === 'refund' ? 'refund' : 'payment',
  }
}

/** The first field that parses as a date, as an ISO string. `''` when there is none. */
function readWhen(row: Record<string, unknown>): string {
  for (const field of WHEN_FIELDS) {
    const value = row[field]
    if (value === undefined || value === null || value === '') continue
    const parsed = new Date(value as string | number)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return ''
}

/** A number, a numeric string, or a `{ $numberDecimal }` wrapper. `NaN` when it is none of those. */
function readAmount(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  if (value && typeof value === 'object') {
    const wrapped = (value as Record<string, unknown>).$numberDecimal
    if (typeof wrapped === 'string' || typeof wrapped === 'number') return Number(wrapped)
  }
  return Number.NaN
}

/**
 * How many lines carry no readable date.
 *
 * They are in `totals()` — the money is real — but no monthly bucket or period can hold them, so
 * every period-filtered figure is short by their value. A screen showing those figures has to say
 * so; silently disagreeing with itself is how a number stops being trusted.
 */
export function undatedCount(lines: Payment[]): number {
  return lines.filter((line) => !line.at).length
}

/**
 * The amount as it affects the books: negative for a refund.
 *
 * A single place for the sign, because summing a ledger while remembering to branch on the type at
 * each call site is precisely how a refund ends up added to revenue.
 */
export function signed(line: Payment): number {
  return isRefund(line) ? -Math.abs(line.amount) : Math.abs(line.amount)
}

export interface GstSplit {
  /** The value of the goods, before tax. */
  taxable: number
  /** The tax itself, at `GST_RATE`. */
  gst: number
  /** What changed hands. */
  total: number
}

/**
 * Splits an amount into value and tax.
 *
 * Rounded to whole paise (two decimals), and **the parts are made to add back up to the total** —
 * `taxable` is derived, then `gst` is the remainder rather than a second independent rounding. Two
 * separately-rounded halves disagree with their own total by a paisa often enough to be noticed,
 * and a report whose columns do not add up is a report nobody trusts.
 */
export function splitGst(total: number, rate = GST_RATE, inclusive = GST_INCLUSIVE): GstSplit {
  const gross = Math.abs(total)
  if (gross === 0) return { taxable: 0, gst: 0, total: 0 }

  if (inclusive) {
    const taxable = round2(gross / (1 + rate))
    return { taxable, gst: round2(gross - taxable), total: round2(gross) }
  }

  const gst = round2(gross * rate)
  return { taxable: round2(gross), gst, total: round2(gross + gst) }
}

/** Two decimal places, away from zero, without the float dust `toFixed` leaves behind. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export interface Totals {
  /** Collected, before refunds. */
  gross: number
  /** Returned. A positive number — it is subtracted, not added. */
  refunds: number
  /** Kept: `gross - refunds`. Every tax figure is derived from this. */
  net: number
  /** The value half of `net`. */
  taxable: number
  /** The tax half of `net` — what is owed on what was kept. */
  gst: number
  /** How many payments, and how many of those were refunds. */
  count: number
  refundCount: number
}

/**
 * Adds up a set of ledger lines.
 *
 * **The tax is computed on `net`, not on `gross`.** Tax is owed on money kept; a refunded sale
 * takes its GST back out with it. Splitting the gross and then subtracting refunds separately
 * would leave the liability overstated by the tax on every refund.
 */
export function totals(lines: Payment[]): Totals {
  let gross = 0
  let refunds = 0
  let refundCount = 0

  for (const line of lines) {
    const amount = Math.abs(line.amount)
    if (isRefund(line)) {
      refunds += amount
      refundCount += 1
    } else {
      gross += amount
    }
  }

  const net = round2(gross - refunds)
  const split = splitGst(net)

  return {
    gross: round2(gross),
    refunds: round2(refunds),
    net,
    /* A net of zero splits to zero; a negative net (more refunded than taken) keeps its sign. */
    taxable: net < 0 ? -split.taxable : split.taxable,
    gst: net < 0 ? -split.gst : split.gst,
    count: lines.length,
    refundCount,
  }
}

/* ──────────────────────────────────────────────────────────────── periods ── */

export interface Period {
  /** Inclusive. */
  from: Date
  /** Inclusive — the last millisecond of the day, so "to the 31st" includes the 31st. */
  to: Date
  label: string
}

/**
 * The Indian financial year containing a date: 1 April to 31 March.
 *
 * Not the calendar year, because that is not the year a GST return is filed against. A payment
 * taken in February 2027 belongs to FY 2026–27, and getting that boundary wrong moves revenue
 * between two returns.
 */
export function financialYear(when: Date): Period {
  const year = when.getMonth() >= 3 ? when.getFullYear() : when.getFullYear() - 1
  return {
    from: new Date(year, 3, 1, 0, 0, 0, 0),
    to: new Date(year + 1, 2, 31, 23, 59, 59, 999),
    label: `FY ${year}–${String(year + 1).slice(2)}`,
  }
}

/** The last `months` whole months, ending today. */
export function lastMonths(months: number, now = new Date()): Period {
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1, 0, 0, 0, 0)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  return { from, to, label: `Last ${months} months` }
}

/** The calendar month containing a date. */
export function monthOf(when: Date): Period {
  return {
    from: new Date(when.getFullYear(), when.getMonth(), 1, 0, 0, 0, 0),
    to: new Date(when.getFullYear(), when.getMonth() + 1, 0, 23, 59, 59, 999),
    label: monthLabel(monthKey(when)),
  }
}

/** Everything, for when the question is lifetime revenue. */
export function allTime(lines: Payment[]): Period {
  const times = lines.map((line) => new Date(line.at).getTime()).filter((t) => Number.isFinite(t))
  const from = times.length ? new Date(Math.min(...times)) : new Date()
  const to = times.length ? new Date(Math.max(...times)) : new Date()
  return { from, to, label: 'All time' }
}

export function within(line: Payment, period: Period): boolean {
  const at = new Date(line.at).getTime()
  if (!Number.isFinite(at)) return false
  return at >= period.from.getTime() && at <= period.to.getTime()
}

export function inPeriod(lines: Payment[], period: Period): Payment[] {
  return lines.filter((line) => within(line, period))
}

/* ─────────────────────────────────────────────────────────────── grouping ── */

/** `2026-08`. Sortable as a string, which is the only reason it is this shape. */
export function monthKey(when: Date): string {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Aug 26` — short, because it goes under a column on a chart. */
export function monthLabel(key: string): string {
  const [year, month] = key.split('-')
  const index = Number(month) - 1
  if (!MONTH_NAMES[index]) return key
  return `${MONTH_NAMES[index]} ${year.slice(2)}`
}

export interface MonthBucket {
  key: string
  label: string
  gross: number
  refunds: number
  net: number
  gst: number
  count: number
}

/**
 * One bucket per month across the period, **including the months with nothing in them**.
 *
 * The empty ones are the point. A chart drawn only from months that had payments squeezes the gaps
 * shut and turns a quiet July into a month that never existed, which reads as steady trade.
 */
export function byMonth(lines: Payment[], period: Period, now = new Date()): MonthBucket[] {
  const buckets = new Map<string, Payment[]>()

  const cursor = new Date(period.from.getFullYear(), period.from.getMonth(), 1)
  /*
   * Never past the current month. A financial year runs to next March, and printing eight future
   * months of dashes on a GST summary pads it out with rows that are not zero — they are *not yet*,
   * which is a different claim and reads as a business that has stopped trading.
   */
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const periodEnd = new Date(period.to.getFullYear(), period.to.getMonth(), 1)
  const last = periodEnd < thisMonth ? periodEnd : thisMonth
  while (cursor <= last) {
    buckets.set(monthKey(cursor), [])
    cursor.setMonth(cursor.getMonth() + 1)
  }

  for (const line of inPeriod(lines, period)) {
    const key = monthKey(new Date(line.at))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(line)
  }

  return [...buckets.entries()].map(([key, group]) => {
    const sum = totals(group)
    return {
      key,
      label: monthLabel(key),
      gross: sum.gross,
      refunds: sum.refunds,
      net: sum.net,
      gst: sum.gst,
      count: group.length,
    }
  })
}

export interface Slice {
  key: string
  label: string
  /** Net of refunds, so a fully refunded plan does not still show as revenue. */
  net: number
  count: number
  /** Share of the total, 0–1. Zero when the total is zero, never NaN. */
  share: number
}

/** Groups by a field, largest first, netting refunds off the group they belong to. */
export function groupBy(
  lines: Payment[],
  field: (line: Payment) => string,
  label: (key: string) => string = (key) => key,
): Slice[] {
  const groups = new Map<string, Payment[]>()
  for (const line of lines) {
    const key = field(line) || 'unknown'
    const group = groups.get(key)
    if (group) group.push(line)
    else groups.set(key, [line])
  }

  const slices = [...groups.entries()].map(([key, group]) => ({
    key,
    label: label(key),
    net: totals(group).net,
    count: group.length,
  }))

  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.net), 0)
  return slices
    .map((slice) => ({ ...slice, share: total > 0 ? Math.max(0, slice.net) / total : 0 }))
    .sort((a, b) => b.net - a.net)
}

/* ───────────────────────────────────────────────────────────────── profit ── */

export interface Profit {
  net: number
  /** Running costs for the period, from `MONTHLY_COSTS`. */
  costs: number
  /** `net - costs`, which is a loss when negative. */
  profit: number
  /** `profit / net`, or `null` when there is no revenue to take a share of. */
  margin: number | null
  /** False when `MONTHLY_COSTS` is zero — the caller must say "unknown", not "all profit". */
  known: boolean
}

/**
 * Profit for a period, given the running costs configured for a month.
 *
 * `known` is the important field. With no cost figure set, `profit` equals `net`, and showing that
 * as profit would claim a business with no expenses. The dashboard reads this flag and says the
 * cost side is not configured instead.
 */
export function profitFor(net: number, months: number, monthlyCosts = MONTHLY_COSTS): Profit {
  const costs = round2(Math.max(0, monthlyCosts) * Math.max(0, months))
  const profit = round2(net - costs)
  return {
    net,
    costs,
    profit,
    margin: net > 0 ? profit / net : null,
    known: monthlyCosts > 0,
  }
}

/** Whole months a period spans, at least one — used to scale the monthly cost figure. */
export function monthsIn(period: Period): number {
  const years = period.to.getFullYear() - period.from.getFullYear()
  return Math.max(1, years * 12 + (period.to.getMonth() - period.from.getMonth()) + 1)
}

/* ─────────────────────────────────────────────────────────────────── csv ── */

/**
 * The ledger as a spreadsheet, one row per line plus a totals row.
 *
 * Exists because a PDF cannot be re-added by an accountant. Every field is quoted and internal
 * quotes are doubled — a shop name with a comma in it must not shift every later column, and one
 * with a quote in it must not end the field early.
 */
export function toCsv(lines: Payment[], nameFor: (accountId: string) => string): string {
  const header = [
    'Date',
    'Account',
    'Type',
    'Plan',
    'Method',
    'Reference',
    'Taxable',
    `GST ${(GST_RATE * 100).toFixed(0)}%`,
    'Total',
    'Note',
  ]

  const rows = [...lines]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((line) => {
      const split = splitGst(Math.abs(line.amount))
      const sign = isRefund(line) ? -1 : 1
      return [
        line.at.slice(0, 10),
        nameFor(line.accountId),
        isRefund(line) ? 'Refund' : 'Payment',
        line.plan ?? '',
        line.method ?? '',
        line.reference ?? '',
        (sign * split.taxable).toFixed(2),
        (sign * split.gst).toFixed(2),
        (sign * split.total).toFixed(2),
        line.note ?? '',
      ]
    })

  const sum = totals(lines)
  const footer = ['', 'TOTAL (net of refunds)', '', '', '', '', sum.taxable.toFixed(2), sum.gst.toFixed(2), sum.net.toFixed(2), '']

  return [header, ...rows, footer].map((row) => row.map(quote).join(',')).join('\r\n')
}

function quote(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`
}

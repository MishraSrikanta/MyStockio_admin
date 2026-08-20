/**
 * The money arithmetic.
 *
 * Every figure on the dashboard and in the GST report comes from `lib/revenue.ts`, and these are
 * the numbers that end up on a tax return. Three things get the most attention, because each is a
 * wrong number rather than a wrong pixel:
 *
 *   · **The GST split must add back up to the total.** Two independently-rounded halves disagree
 *     with their own total by a paisa often enough that somebody notices, and a report whose
 *     columns do not add up is a report nobody trusts again.
 *   · **A refund must subtract, and it must take its tax with it.** Tax is owed on money kept. A
 *     refund that reduces revenue but not the liability quietly overstates what is owed.
 *   · **A quiet month must still be a month.** Charting only the months that had payments closes
 *     the gaps and draws a flat July as steady trade.
 */

import {
  allTime,
  byMonth,
  financialYear,
  groupBy,
  inPeriod,
  isRefund,
  lastMonths,
  monthLabel,
  monthsIn,
  type Payment,
  profitFor,
  round2,
  signed,
  splitGst,
  toCsv,
  totals,
} from '../../src/lib/revenue'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A ledger line, with only the fields a test cares about spelled out. */
const line = (over: Partial<Payment> & { amount: number; at: string }): Payment => ({
  id: Math.abs(over.amount).toString(36) + over.at,
  accountId: 'acc-1',
  plan: '1year',
  method: 'upi',
  type: 'payment',
  ...over,
})

/* ══════════════════════════════════════════════════════ the GST split ══ */

console.log('splitting tax out of a price')

const three = splitGst(3000)
check('₹3,000 splits to value + tax', three.taxable === 2542.37 && three.gst === 457.63, `${three.taxable} + ${three.gst}`)
check('...and the halves add back to the total', round2(three.taxable + three.gst) === 3000, String(round2(three.taxable + three.gst)))

/* The inclusive/exclusive reading is the difference between ₹457.63 and ₹540 on the same sale. */
const exclusive = splitGst(3000, 0.18, false)
check('read exclusive, the tax is added on top', exclusive.gst === 540 && exclusive.total === 3540, `${exclusive.gst} / ${exclusive.total}`)
check('...and inclusive is the smaller figure', three.gst < exclusive.gst, `${three.gst} < ${exclusive.gst}`)

check('zero splits to zero, not NaN', splitGst(0).gst === 0 && splitGst(0).taxable === 0)

/*
 * The parts must reconcile at every price, not just the round ones. An awkward amount is exactly
 * where a naive `toFixed` on both halves drifts a paisa apart from the total.
 */
let reconciles = true
let worst = ''
for (const amount of [1, 7, 99, 100, 999, 1234.56, 2999.99, 3000, 5000, 12000, 87654.32]) {
  const split = splitGst(amount)
  if (round2(split.taxable + split.gst) !== round2(amount)) {
    reconciles = false
    worst = `${amount} → ${split.taxable} + ${split.gst}`
  }
}
check('the halves reconcile at every price tried', reconciles, worst)

/* ══════════════════════════════════════════════ refunds go the other way ══ */

console.log('\nrefunds')

const refund = line({ amount: 3000, at: '2026-05-10T00:00:00.000Z', type: 'refund' })
check('a refund is recognised', isRefund(refund))
check('...and signs negative', signed(refund) === -3000, String(signed(refund)))
check('a payment signs positive', signed(line({ amount: 3000, at: '2026-05-01T00:00:00.000Z' })) === 3000)

/*
 * A missing `type` is a payment. A backend that has never heard of refunds omits the field, and
 * reading that as anything else turns an ordinary history into a refund history.
 */
const untyped = { id: 'x', accountId: 'acc-1', amount: 3000, at: '2026-05-01T00:00:00.000Z' } as Payment
check('a line with no type is a payment', !isRefund(untyped) && signed(untyped) === 3000)

/* A refund recorded with a negative amount must not double-negate into revenue. */
const sloppy = line({ amount: -3000, at: '2026-05-10T00:00:00.000Z', type: 'refund' })
check('a negative amount on a refund still subtracts', signed(sloppy) === -3000, String(signed(sloppy)))

const mixed = totals([
  line({ amount: 3000, at: '2026-04-02T00:00:00.000Z' }),
  line({ amount: 5000, at: '2026-04-09T00:00:00.000Z', plan: '2year' }),
  line({ amount: 3000, at: '2026-04-20T00:00:00.000Z', type: 'refund' }),
])
check('gross counts what was collected', mixed.gross === 8000, String(mixed.gross))
check('refunds are counted apart', mixed.refunds === 3000, String(mixed.refunds))
check('net is what was kept', mixed.net === 5000, String(mixed.net))
check('the refund is counted', mixed.refundCount === 1 && mixed.count === 3)

/*
 * The whole reason tax is computed on net: ₹5,000 kept owes ₹762.71, not the ₹1,220.34 that ₹8,000
 * collected would owe. The difference is the tax on the refunded sale, and it is not owed.
 */
check('tax is charged on net, not gross', mixed.gst === splitGst(5000).gst, `${mixed.gst} vs ${splitGst(8000).gst} on gross`)
check('...and taxable matches net too', round2(mixed.taxable + mixed.gst) === 5000, String(round2(mixed.taxable + mixed.gst)))

/* Refunding more than was taken in a period is unusual but must not produce a positive liability. */
const negative = totals([
  line({ amount: 1000, at: '2026-04-02T00:00:00.000Z' }),
  line({ amount: 3000, at: '2026-04-20T00:00:00.000Z', type: 'refund' }),
])
check('a net loss stays negative', negative.net === -2000, String(negative.net))
check('...and so does the tax on it', negative.gst < 0 && negative.taxable < 0, `${negative.taxable} / ${negative.gst}`)

check('an empty ledger is all zeroes', totals([]).net === 0 && totals([]).gst === 0)

/* ══════════════════════════════════════════════════ months and periods ══ */

console.log('\nperiods')

/*
 * The Indian financial year runs April to March. A payment in February belongs to the year that
 * began the previous April, and getting that wrong moves revenue between two returns.
 */
const feb = financialYear(new Date(2027, 1, 15))
check('February 2027 falls in FY 2026–27', feb.label === 'FY 2026–27', feb.label)
check('...starting 1 April 2026', feb.from.getFullYear() === 2026 && feb.from.getMonth() === 3 && feb.from.getDate() === 1)
check('...and ending 31 March 2027', feb.to.getFullYear() === 2027 && feb.to.getMonth() === 2 && feb.to.getDate() === 31)

const apr = financialYear(new Date(2026, 3, 1))
check('1 April starts the new year, not ends the old', apr.label === 'FY 2026–27', apr.label)
const mar = financialYear(new Date(2026, 2, 31))
check('31 March is still the old year', mar.label === 'FY 2025–26', mar.label)

/* The last day of the period must be included — "to the 31st" means through the 31st. */
const year = financialYear(new Date(2026, 5, 1))
const lastMoment = line({ amount: 100, at: new Date(2027, 2, 31, 23, 30).toISOString() })
check('the final day of a period is inside it', inPeriod([lastMoment], year).length === 1)
const justAfter = line({ amount: 100, at: new Date(2027, 3, 1, 0, 30).toISOString() })
check('...and the next morning is outside it', inPeriod([justAfter], year).length === 0)

check('a rolling window spans the months asked for', monthsIn(lastMonths(12, new Date(2026, 7, 20))) === 12, String(monthsIn(lastMonths(12, new Date(2026, 7, 20)))))
check('a financial year is twelve months', monthsIn(financialYear(new Date(2026, 7, 1))) === 12)

check('an empty ledger still yields a period', allTime([]).from instanceof Date)

/* ══════════════════════════════════════════════════ the monthly buckets ══ */

console.log('\nmonthly buckets')

const window3 = lastMonths(3, new Date(2026, 7, 20)) /* Jun, Jul, Aug 2026 */
const sparse = byMonth(
  [
    line({ amount: 3000, at: new Date(2026, 5, 10).toISOString() }),
    line({ amount: 5000, at: new Date(2026, 7, 2).toISOString() }),
    line({ amount: 1000, at: new Date(2026, 7, 9).toISOString(), type: 'refund' }),
  ],
  window3,
)

check('one bucket per month in the window', sparse.length === 3, sparse.map((b) => b.label).join(' '))
check('a month with no payments is still a bucket', sparse[1].net === 0 && sparse[1].count === 0, sparse[1].label)
check('...and it is not dropped from the middle', sparse.map((b) => b.key).join(',') === '2026-06,2026-07,2026-08', sparse.map((b) => b.key).join(','))
check('a refund nets off its own month', sparse[2].gross === 5000 && sparse[2].refunds === 1000 && sparse[2].net === 4000, `${sparse[2].gross}/${sparse[2].refunds}`)
check('the buckets are in date order', sparse[0].key < sparse[1].key && sparse[1].key < sparse[2].key)

/* A payment outside the window must not be folded into the nearest bucket. */
const outside = byMonth([line({ amount: 9999, at: new Date(2026, 0, 5).toISOString() })], window3)
check('a payment outside the window is excluded', outside.every((b) => b.net === 0))

/*
 * A period running into the future stops at the current month. Eight rows of dashes on a GST summary
 * are not zeroes, they are 'not yet' — a different claim, and one that reads as a dead business.
 */
const yearAhead = byMonth([], { from: new Date(2026, 3, 1), to: new Date(2027, 2, 31), label: 'FY' }, new Date(2026, 7, 20))
check('a period is not charted past the current month', yearAhead.length === 5, yearAhead.map((b) => b.label).join(' '))
check('...ending on the current month', yearAhead[yearAhead.length - 1].key === '2026-08', yearAhead[yearAhead.length - 1].key)

/* A period wholly in the past keeps every one of its months. */
const past = byMonth([], { from: new Date(2025, 0, 1), to: new Date(2025, 2, 31), label: 'Q1' }, new Date(2026, 7, 20))
check('a past period keeps all its months', past.length === 3, past.map((b) => b.label).join(' '))

check('a month label is short and readable', monthLabel('2026-08') === 'Aug 26', monthLabel('2026-08'))
check('a nonsense key does not crash the axis', monthLabel('rubbish') === 'rubbish')

/* ═════════════════════════════════════════════════════════════ grouping ══ */

console.log('\ngrouping')

const slices = groupBy(
  [
    line({ amount: 3000, at: '2026-04-01T00:00:00.000Z', plan: '1year' }),
    line({ amount: 3000, at: '2026-04-02T00:00:00.000Z', plan: '1year' }),
    line({ amount: 12000, at: '2026-04-03T00:00:00.000Z', plan: 'lifetime' }),
    line({ amount: 3000, at: '2026-04-04T00:00:00.000Z', plan: '1year', type: 'refund' }),
  ],
  (l) => l.plan ?? '',
)

check('the largest group comes first', slices[0].key === 'lifetime', slices.map((s) => s.key).join(','))
check('a refund nets off its own group', slices[1].net === 3000, String(slices[1].net))
check('shares add to one', round2(slices.reduce((sum, s) => sum + s.share, 0)) === 1, String(round2(slices.reduce((sum, s) => sum + s.share, 0))))
check('a missing field groups as unknown', groupBy([line({ amount: 100, at: '2026-04-01T00:00:00.000Z', method: undefined })], (l) => l.method ?? '')[0].key === 'unknown')
check('an all-refund group cannot produce NaN shares', groupBy([line({ amount: 100, at: '2026-04-01T00:00:00.000Z', type: 'refund' })], (l) => l.plan ?? '')[0].share === 0)

/* ═══════════════════════════════════════════════════════════════ profit ══ */

console.log('\nprofit, only when it is knowable')

const unknown = profitFor(50000, 12, 0)
check('with no costs configured, profit is not claimed', unknown.known === false)
check('...and the figure equals net, for the caller to label honestly', unknown.profit === 50000)

const known = profitFor(50000, 12, 1000)
check('costs scale by the months in the period', known.costs === 12000, String(known.costs))
check('profit is net less costs', known.profit === 38000, String(known.profit))
check('margin is a share of revenue', known.margin !== null && round2(known.margin) === 0.76, String(known.margin))

const loss = profitFor(5000, 12, 1000)
check('costs above revenue are a loss', loss.profit === -7000, String(loss.profit))
check('no revenue means no margin, not a divide by zero', profitFor(0, 12, 1000).margin === null)

/* ══════════════════════════════════════════════════════════════════ csv ══ */

console.log('\nthe spreadsheet export')

const csv = toCsv(
  [
    line({ amount: 3000, at: '2026-04-02T10:00:00.000Z', reference: 'UPI/123' }),
    line({ amount: 1000, at: '2026-04-20T10:00:00.000Z', type: 'refund' }),
  ],
  () => 'Sharma "Kirana", Cuttack',
)
const rows = csv.split('\r\n')

check('a header, the lines, and a total', rows.length === 4, `${rows.length} rows`)
check('the oldest line comes first', rows[1].includes('2026-04-02'), rows[1].slice(0, 14))
check('a refund is marked as one', rows[2].includes('Refund'))
check('...and carries negative money', rows[2].includes('-1000.00'), rows[2])
check('the total is net of refunds', rows[3].includes('2000.00'), rows[3])
/* A comma in a shop name must not shift every later column; a quote must not end the field. */
check('a comma in a name does not break the columns', rows[1].split('","').length === 10, String(rows[1].split('","').length))
check('a quote in a name is doubled, not escaped away', rows[1].includes('Sharma ""Kirana""'))

console.log()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

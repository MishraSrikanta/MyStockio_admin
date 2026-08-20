/**
 * The money screen: what came in, what went back out, what is owed, and what it is trending to.
 *
 * ── What this deliberately does not do ─────────────────────────────────────────
 * It does not invent a cost side. "Profit" needs expenses, and this app has never been told any, so
 * with `MONTHLY_COSTS` at zero the profit tile says the cost side is not configured instead of
 * showing net revenue under a more flattering name. Set the figure in `lib/config.ts` and the tile
 * starts answering the question properly.
 *
 * The other restraint worth knowing: **"loss" is split into the two different things it can mean.**
 * Refunds are money that came in and went back out — a fact, in the ledger. Lapsed licences are
 * money that did *not* come in, which is an estimate of what expiring accounts were worth. Adding
 * those together would produce one confident number standing on one measurement and one guess, so
 * they stay apart and the estimate says it is one.
 */

import { useMemo, useState } from 'react'
import { GST_RATE, MONTHLY_COSTS, PLAN_PRICE } from '@/lib/config'
import {
  allTime,
  byMonth,
  financialYear,
  groupBy,
  inPeriod,
  lastMonths,
  monthsIn,
  type Payment,
  type Period,
  profitFor,
  totals,
} from '@/lib/revenue'
import { type AdminAccount, isLifetime, planLabel, subscriptionState } from '@/lib/subscription'
import { ChartCard, Columns, money, RankedBars, SERIES, StackedBar, STATUS, TrendLine } from './charts'
import { Button } from './ui'

type RangeId = '12m' | 'fy' | 'all'

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank: 'Bank transfer',
  card: 'Card',
  other: 'Other',
  unknown: 'Not recorded',
}

export function Dashboard({
  payments,
  accounts,
  loading,
  onOpenReport,
  onAddPayment,
}: {
  payments: Payment[]
  accounts: AdminAccount[]
  loading: boolean
  onOpenReport: () => void
  onAddPayment: () => void
}) {
  const [range, setRange] = useState<RangeId>('12m')

  const period: Period = useMemo(() => {
    if (range === 'fy') return financialYear(new Date())
    if (range === 'all') return allTime(payments)
    return lastMonths(12)
  }, [range, payments])

  const lines = useMemo(() => inPeriod(payments, period), [payments, period])
  const sum = useMemo(() => totals(lines), [lines])
  const months = useMemo(() => byMonth(lines, period), [lines, period])
  const profit = useMemo(() => profitFor(sum.net, monthsIn(period), MONTHLY_COSTS), [sum.net, period])

  /* Running total across the same buckets — the trend the monthly columns cannot show. */
  const cumulative = useMemo(() => {
    let running = 0
    return months.map((bucket) => {
      running += bucket.net
      return { label: bucket.label, value: running }
    })
  }, [months])

  const byPlan = useMemo(() => groupBy(lines, (line) => line.plan ?? '', planLabel), [lines])
  const byMethod = useMemo(
    () => groupBy(lines, (line) => line.method ?? '', (key) => METHOD_LABEL[key] ?? key),
    [lines],
  )

  /* The base, by state. Not money — this is who is on the books, which is what next month rests on. */
  const mix = useMemo(() => {
    const counts = { lifetime: 0, active: 0, expiring: 0, expired: 0, unknown: 0 }
    for (const account of accounts) counts[subscriptionState(account)] += 1
    return [
      { label: 'Active', value: counts.active, color: STATUS.active },
      { label: 'Expiring', value: counts.expiring, color: STATUS.expiring },
      { label: 'Expired', value: counts.expired, color: STATUS.expired },
      { label: 'Lifetime', value: counts.lifetime, color: STATUS.lifetime },
      { label: 'Unknown', value: counts.unknown, color: STATUS.unknown },
    ]
  }, [accounts])

  /**
   * What the expired accounts were worth at their plan's price.
   *
   * An **estimate**, and labelled as one wherever it is shown: it prices each lapsed licence at
   * today's rate for the plan it was on, which is not necessarily what that shop paid. It answers
   * "roughly how much is walking out of the door", and the honest version of that answer is a
   * rounded one.
   */
  const lapsed = useMemo(() => {
    let value = 0
    let count = 0
    for (const account of accounts) {
      if (subscriptionState(account) !== 'expired' || isLifetime(account)) continue
      count += 1
      value += PLAN_PRICE[account.subscription?.plan ?? '1year'] ?? PLAN_PRICE['1year']
    }
    return { value, count }
  }, [accounts])

  const monthTable = {
    columns: ['Month', 'Collected', 'Refunded', 'Net', `GST ${(GST_RATE * 100).toFixed(0)}%`],
    rows: months.map((bucket) => [
      bucket.label,
      money(bucket.gross),
      bucket.refunds ? money(bucket.refunds) : '—',
      money(bucket.net),
      money(bucket.gst),
    ]),
  }

  return (
    <div className="space-y-3">
      {/* ── the filter row, above the charts ───────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
          {(
            [
              { id: '12m' as const, label: 'Last 12 months' },
              { id: 'fy' as const, label: financialYear(new Date()).label },
              { id: 'all' as const, label: 'All time' },
            ]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setRange(option.id)}
              aria-pressed={range === option.id}
              className={`rounded-xl border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                range === option.id
                  ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
                  : 'border-white/10 text-slate-300 hover:border-white/20 hover:text-slate-100'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onAddPayment}>
            Add payment
          </Button>
          <Button onClick={onOpenReport}>GST report</Button>
        </div>
      </div>

      {/* ── the hero, and the tiles that qualify it ────────────────────────── */}
      <section className="card p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[12.5px] font-semibold text-slate-400">Net revenue · {period.label}</p>
            {/* Exactly one hero number on the screen: the figure everything else explains. */}
            <p className="mt-1 text-[44px] font-bold leading-none tracking-tight text-slate-50 tabular-nums">
              {money(sum.net)}
            </p>
            <p className="mt-1.5 text-[12.5px] text-slate-400">
              {sum.count} {sum.count === 1 ? 'entry' : 'entries'}
              {sum.refundCount > 0 && ` · ${sum.refundCount} refunded`}
              {loading && ' · loading…'}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Figure label="Collected" value={money(sum.gross)} />
            <Figure label="Refunded" value={sum.refunds ? `−${money(sum.refunds)}` : '—'} tone={sum.refunds ? 'danger' : 'muted'} />
            <Figure label="Taxable value" value={money(sum.taxable)} />
            <Figure label={`GST ${(GST_RATE * 100).toFixed(0)}% payable`} value={money(sum.gst)} tone="warning" />
          </dl>
        </div>
      </section>

      {/* ── profit and leakage ────────────────────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="card p-4">
          <h3 className="text-[14px] font-bold text-slate-100">Profit</h3>
          {profit.known ? (
            <>
              <p className={`mt-2 text-[26px] font-bold leading-none tabular-nums ${profit.profit >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                {money(profit.profit)}
              </p>
              <p className="mt-1.5 text-[12.5px] text-slate-400">
                {money(sum.net)} kept less {money(profit.costs)} of running costs
                {profit.margin !== null && ` · ${(profit.margin * 100).toFixed(0)}% margin`}
              </p>
              {profit.profit < 0 && (
                <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-200">
                  A loss for this period: costs exceeded what was kept.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="mt-2 text-[26px] font-bold leading-none text-slate-500">—</p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">
                Not knowable yet. Profit is revenue minus costs, and no costs are configured — set{' '}
                <code className="text-slate-300">MONTHLY_COSTS</code> in <code className="text-slate-300">src/lib/config.ts</code>{' '}
                and this becomes a real figure rather than a restatement of net revenue.
              </p>
            </>
          )}
        </section>

        <section className="card p-4">
          <h3 className="text-[14px] font-bold text-slate-100">Refunded</h3>
          <p className="mt-2 text-[26px] font-bold leading-none tabular-nums text-slate-100">{money(sum.refunds)}</p>
          <p className="mt-1.5 text-[12.5px] text-slate-400">
            {sum.refundCount === 0
              ? 'Nothing returned in this period.'
              : `${sum.refundCount} ${sum.refundCount === 1 ? 'refund' : 'refunds'} · ${
                  sum.gross > 0 ? ((sum.refunds / sum.gross) * 100).toFixed(1) : '0'
                }% of what was collected`}
          </p>
        </section>

        <section className="card p-4">
          <h3 className="text-[14px] font-bold text-slate-100">Lapsed licences</h3>
          <p className="mt-2 text-[26px] font-bold leading-none tabular-nums text-amber-300">≈{money(lapsed.value)}</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-400">
            {lapsed.count === 0
              ? 'Nothing expired and unrenewed.'
              : `${lapsed.count} expired ${lapsed.count === 1 ? 'account' : 'accounts'}, priced at today's rate for their plan. An estimate of revenue not collected — not a booked loss.`}
          </p>
        </section>
      </div>

      {/* ── the charts ────────────────────────────────────────────────────── */}
      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCard
          title="Money by month"
          subtitle="Net of refunds, against the refunds themselves — one scale, so the proportion is honest."
          legend={[
            { label: 'Net kept', color: SERIES[0] },
            { label: 'Refunded', color: SERIES[4] },
          ]}
          table={monthTable}
        >
          <Columns data={months.map((bucket) => ({ label: bucket.label, value: bucket.net, second: bucket.refunds }))} />
        </ChartCard>

        <ChartCard
          title="Cumulative revenue"
          subtitle={`What had been kept by each month across ${period.label.toLowerCase()}.`}
          table={{
            columns: ['Month', 'Kept so far'],
            rows: cumulative.map((point) => [point.label, money(point.value)]),
          }}
        >
          <TrendLine data={cumulative} />
        </ChartCard>

        <ChartCard
          title="Revenue by plan"
          subtitle="Net of refunds, so a returned sale does not still count."
          table={{
            columns: ['Plan', 'Net', 'Entries', 'Share'],
            rows: byPlan.map((slice) => [slice.label, money(slice.net), String(slice.count), `${(slice.share * 100).toFixed(0)}%`]),
          }}
        >
          <RankedBars data={byPlan} />
        </ChartCard>

        <ChartCard
          title="How they paid"
          subtitle="Useful for reconciling against a bank statement."
          table={{
            columns: ['Method', 'Net', 'Entries', 'Share'],
            rows: byMethod.map((slice) => [slice.label, money(slice.net), String(slice.count), `${(slice.share * 100).toFixed(0)}%`]),
          }}
        >
          <RankedBars data={byMethod} colors={[SERIES[2], SERIES[0], SERIES[3], SERIES[1], SERIES[4]]} />
        </ChartCard>

        <ChartCard
          title="The customer base"
          subtitle="Every account by state — what next month's revenue rests on. Not filtered by period."
          table={{
            columns: ['State', 'Accounts'],
            rows: mix.map((part) => [part.label, String(part.value)]),
          }}
        >
          <StackedBar data={mix} />
        </ChartCard>

        <ChartCard
          title="Entries per month"
          subtitle="How many payments and refunds were recorded, regardless of size."
          table={{
            columns: ['Month', 'Entries'],
            rows: months.map((bucket) => [bucket.label, String(bucket.count)]),
          }}
        >
          {/* Counts, not money — so the axis and tooltip are told to write plain numbers. */}
          <Columns
            data={months.map((bucket) => ({ label: bucket.label, value: bucket.count }))}
            colors={[SERIES[2], SERIES[4]]}
            height={180}
            format={(value) => String(Math.round(value))}
            names={['Entries', '']}
          />
        </ChartCard>
      </div>
    </div>
  )
}

function Figure({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'muted' | 'warning' | 'danger' }) {
  const colour =
    tone === 'warning' ? 'text-amber-300' : tone === 'danger' ? 'text-rose-300' : tone === 'muted' ? 'text-slate-500' : 'text-slate-100'
  return (
    <div>
      <dt className="text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-[17px] font-bold tabular-nums ${colour}`}>{value}</dd>
    </div>
  )
}

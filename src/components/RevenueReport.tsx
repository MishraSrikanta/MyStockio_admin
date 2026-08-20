/**
 * The revenue report — the one thing in this console that leaves the building.
 *
 * ── Why this is a print view rather than a generated PDF ───────────────────────
 * The browser already has a PDF writer, and it is a better one than a bundled library: it embeds
 * fonts, it handles page breaks, it gets Indian digit grouping right, and it costs nothing to
 * download. So this renders a document, `@media print` strips the console around it, and **Save as
 * PDF** in the print dialog produces the file. A charting-sized dependency to redraw a table into a
 * canvas would be a worse PDF, three hundred kilobytes heavier.
 *
 * There is a **CSV** button beside it for the same reason in reverse: a PDF cannot be re-added by an
 * accountant, and a spreadsheet is what gets asked for when a figure is queried.
 *
 * ── What the document claims, and what it does not ─────────────────────────────
 * It is a **summary of money recorded in this console**, and it says so on its face. It is not a tax
 * invoice — those are issued per sale, numbered in sequence, and carry the customer's GSTIN — and it
 * does not pretend to be one, because a document that looks like a filing and is not one is the
 * expensive kind of wrong. `GSTIN` prints as a visible gap until it is set in `config.ts`, rather
 * than being quietly omitted.
 */

import { useMemo, useState } from 'react'
import { BUSINESS, GST_INCLUSIVE, GST_RATE } from '@/lib/config'
import {
  allTime,
  byMonth,
  financialYear,
  groupBy,
  inPeriod,
  isRefund,
  lastMonths,
  type Payment,
  type Period,
  splitGst,
  toCsv,
  totals,
} from '@/lib/revenue'
import { type AdminAccount, formatDate, planLabel } from '@/lib/subscription'
import { money } from './charts'
import { Button, Modal } from './ui'

type RangeId = 'fy' | 'prevFy' | '12m' | 'all'

export function RevenueReport({
  payments,
  accounts,
  onClose,
}: {
  payments: Payment[]
  accounts: AdminAccount[]
  onClose: () => void
}) {
  const [range, setRange] = useState<RangeId>('fy')
  const [detail, setDetail] = useState(false)

  const period: Period = useMemo(() => {
    const now = new Date()
    if (range === 'prevFy') return financialYear(new Date(now.getFullYear() - 1, now.getMonth(), 1))
    if (range === '12m') return lastMonths(12, now)
    if (range === 'all') return allTime(payments)
    return financialYear(now)
  }, [range, payments])

  const lines = useMemo(() => inPeriod(payments, period), [payments, period])
  const sum = useMemo(() => totals(lines), [lines])
  const months = useMemo(() => byMonth(lines, period), [lines, period])
  const byPlan = useMemo(() => groupBy(lines, (line) => line.plan ?? '', planLabel), [lines])

  const nameFor = useMemo(() => {
    const index = new Map(accounts.map((account) => [account.id, account.shopName || account.name || account.email]))
    return (id: string) => index.get(id) ?? id
  }, [accounts])

  const download = () => {
    const csv = toCsv(lines, nameFor)
    /*
     * A UTF-8 BOM, so Excel opens ₹ and shop names in Odia as themselves rather than as mojibake.
     * Without it Excel guesses the system codepage and guesses wrong.
     */
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `mystockio-revenue-${period.label.replace(/\s+/g, '-').toLowerCase()}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const rateLabel = `${(GST_RATE * 100).toFixed(0)}%`

  return (
    <Modal open printRoot title="Revenue report" onClose={onClose} wide>
      {/* ── the controls, which do not print ──────────────────────────────── */}
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
          {[
            { id: 'fy' as const, label: financialYear(new Date()).label },
            { id: 'prevFy' as const, label: financialYear(new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1)).label },
            { id: '12m' as const, label: 'Last 12 months' },
            { id: 'all' as const, label: 'All time' },
          ].map((option) => (
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
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12.5px] text-slate-400">
            <input
              type="checkbox"
              checked={detail}
              onChange={(event) => setDetail(event.target.checked)}
              className="h-3.5 w-3.5 accent-sky-500"
            />
            Every entry
          </label>
          <Button onClick={download}>CSV</Button>
          <Button variant="primary" onClick={() => window.print()}>
            Save as PDF
          </Button>
        </div>
      </div>

      {!BUSINESS.gstin && (
        <p className="no-print mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-relaxed text-amber-200">
          No GSTIN is set. The report prints a visible gap where it belongs — fill in{' '}
          <code>BUSINESS.gstin</code> in <code>src/lib/config.ts</code> before sending this to anyone.
        </p>
      )}

      {/* ── the document ─────────────────────────────────────────────────── */}
      <article className="printable rounded-2xl bg-white p-6 text-slate-900">
        <header className="border-b-2 border-slate-900 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-[20px] font-bold leading-tight">{BUSINESS.name}</h1>
              {BUSINESS.address && <p className="text-[12px] text-slate-600">{BUSINESS.address}</p>}
              <p className="text-[12px] text-slate-600">
                GSTIN: {BUSINESS.gstin || <span className="font-semibold text-rose-600">— not set —</span>}
                {BUSINESS.state && ` · ${BUSINESS.state}`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[14px] font-bold">Revenue &amp; GST summary</p>
              <p className="text-[12px] text-slate-600">{period.label}</p>
              <p className="text-[12px] text-slate-600">
                {formatDate(period.from.toISOString())} – {formatDate(period.to.toISOString())}
              </p>
            </div>
          </div>
        </header>

        {/* The three figures the whole document exists to state. */}
        <section className="mt-4 grid grid-cols-3 gap-3">
          <Cell label="Taxable value" value={money(sum.taxable)} />
          <Cell label={`GST @ ${rateLabel}`} value={money(sum.gst)} strong />
          <Cell label="Total kept" value={money(sum.net)} />
        </section>

        <p className="mt-3 text-[11.5px] leading-relaxed text-slate-600">
          Prices are treated as <strong>{GST_INCLUSIVE ? 'inclusive of' : 'exclusive of'} GST</strong> at {rateLabel}.
          {' '}Tax is computed on the amount kept, so a refunded sale takes its GST back out with it.
          {sum.refunds > 0 && ` ${money(sum.gross)} was collected and ${money(sum.refunds)} refunded.`}
        </p>

        {/* ── month by month ─────────────────────────────────────────────── */}
        <h2 className="mt-5 text-[13px] font-bold uppercase tracking-wider text-slate-700">Month by month</h2>
        <table className="mt-2 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="py-1.5 pr-2 font-semibold">Month</th>
              <th className="py-1.5 px-2 text-right font-semibold">Collected</th>
              <th className="py-1.5 px-2 text-right font-semibold">Refunded</th>
              <th className="py-1.5 px-2 text-right font-semibold">Taxable</th>
              <th className="py-1.5 px-2 text-right font-semibold">GST {rateLabel}</th>
              <th className="py-1.5 pl-2 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody>
            {months.map((bucket) => {
              const split = splitGst(Math.abs(bucket.net))
              const sign = bucket.net < 0 ? -1 : 1
              return (
                <tr key={bucket.key} className="border-b border-slate-200">
                  <td className="py-1.5 pr-2">{bucket.label}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{bucket.gross ? money(bucket.gross) : '—'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{bucket.refunds ? `−${money(bucket.refunds)}` : '—'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{bucket.net ? money(sign * split.taxable) : '—'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{bucket.net ? money(sign * split.gst) : '—'}</td>
                  <td className="py-1.5 pl-2 text-right font-semibold tabular-nums">{bucket.net ? money(bucket.net) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-900 font-bold">
              <td className="py-2 pr-2">Total</td>
              <td className="py-2 px-2 text-right tabular-nums">{money(sum.gross)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{sum.refunds ? `−${money(sum.refunds)}` : '—'}</td>
              <td className="py-2 px-2 text-right tabular-nums">{money(sum.taxable)}</td>
              <td className="py-2 px-2 text-right tabular-nums">{money(sum.gst)}</td>
              <td className="py-2 pl-2 text-right tabular-nums">{money(sum.net)}</td>
            </tr>
          </tfoot>
        </table>

        {/* ── by plan ────────────────────────────────────────────────────── */}
        <h2 className="mt-5 text-[13px] font-bold uppercase tracking-wider text-slate-700">By plan</h2>
        <table className="mt-2 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="py-1.5 pr-2 font-semibold">Plan</th>
              <th className="py-1.5 px-2 text-right font-semibold">Entries</th>
              <th className="py-1.5 px-2 text-right font-semibold">Share</th>
              <th className="py-1.5 pl-2 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody>
            {byPlan.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-slate-500">
                  Nothing recorded in this period.
                </td>
              </tr>
            )}
            {byPlan.map((slice) => (
              <tr key={slice.key} className="border-b border-slate-200">
                <td className="py-1.5 pr-2">{slice.label}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{slice.count}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{(slice.share * 100).toFixed(0)}%</td>
                <td className="py-1.5 pl-2 text-right font-semibold tabular-nums">{money(slice.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ── every entry, when asked for ────────────────────────────────── */}
        {detail && (
          <>
            <h2 className="mt-5 text-[13px] font-bold uppercase tracking-wider text-slate-700">Every entry</h2>
            <table className="mt-2 w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-slate-300 text-left">
                  <th className="py-1.5 pr-2 font-semibold">Date</th>
                  <th className="py-1.5 px-2 font-semibold">Account</th>
                  <th className="py-1.5 px-2 font-semibold">Plan</th>
                  <th className="py-1.5 px-2 font-semibold">Method</th>
                  <th className="py-1.5 px-2 font-semibold">Reference</th>
                  <th className="py-1.5 px-2 text-right font-semibold">Taxable</th>
                  <th className="py-1.5 px-2 text-right font-semibold">GST</th>
                  <th className="py-1.5 pl-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {[...lines]
                  .sort((a, b) => a.at.localeCompare(b.at))
                  .map((line) => {
                    const split = splitGst(Math.abs(line.amount))
                    const sign = isRefund(line) ? -1 : 1
                    return (
                      <tr key={line.id} className="border-b border-slate-200">
                        <td className="py-1 pr-2 whitespace-nowrap">{formatDate(line.at)}</td>
                        <td className="py-1 px-2">
                          {nameFor(line.accountId)}
                          {isRefund(line) && <strong className="ml-1 text-rose-600">refund</strong>}
                        </td>
                        <td className="py-1 px-2">{planLabel(line.plan ?? '')}</td>
                        <td className="py-1 px-2">{line.method ?? '—'}</td>
                        <td className="py-1 px-2">{line.reference || '—'}</td>
                        <td className="py-1 px-2 text-right tabular-nums">{money(sign * split.taxable)}</td>
                        <td className="py-1 px-2 text-right tabular-nums">{money(sign * split.gst)}</td>
                        <td className="py-1 pl-2 text-right font-semibold tabular-nums">{money(sign * split.total)}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </>
        )}

        <footer className="mt-6 border-t border-slate-300 pt-3 text-[10.5px] leading-relaxed text-slate-600">
          <p>
            <strong>This is a summary of payments recorded in the MyStockio admin console, not a tax
            invoice.</strong>{' '}
            Tax invoices are issued per sale with their own serial numbers and the customer&apos;s GSTIN.
            Figures are net of refunds and rounded to two decimals; the parts add to the totals shown.
          </p>
          <p className="mt-1">
            Generated {formatDate(new Date().toISOString())} · {sum.count} {sum.count === 1 ? 'entry' : 'entries'}
            {sum.refundCount > 0 && ` including ${sum.refundCount} refunded`}
          </p>
        </footer>
      </article>
    </Modal>
  )
}

function Cell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${strong ? 'border-slate-900 bg-slate-100' : 'border-slate-300'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 text-[19px] font-bold tabular-nums">{value}</p>
    </div>
  )
}

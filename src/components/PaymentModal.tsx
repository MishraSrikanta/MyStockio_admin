/**
 * Recording money, from anywhere — a payment or a refund, against any account.
 *
 * ── Why this exists when the account drawer can already take a payment ─────────
 * Because of the order the work actually happens in. The drawer's form starts from a customer: find
 * the shop, open it, then record what they paid. That is right when somebody has been chased and has
 * paid. It is the wrong way round at the end of the day with six UPI notifications to enter, where
 * the money is the starting point and the account is a detail of it — and it is no way at all to
 * record a refund, which the drawer cannot do.
 *
 * So this is the money-first entry point: type the amount, pick who it was, done. The drawer's form
 * stays exactly as it was, because for its one job it is quicker.
 *
 * ── The refund switch ──────────────────────────────────────────────────────────
 * The same form, one toggle, and it changes three things: the direction of the money, the wording of
 * everything that mentions it, and the disappearance of the "licence will run to" line — because a
 * refund does not shorten the term (see `recordRefund`). Making it a toggle rather than a separate
 * screen keeps one code path for the amount, the account picker and the validation; making it loudly
 * red is what stops it being flipped by accident.
 */

import { useMemo, useState } from 'react'
import { ApiError, recordPayment, recordRefund } from '@/lib/api'
import { DEFAULT_PLAN, PLAN_PRICE, PLANS } from '@/lib/config'
import { formatAmount } from '@/lib/outreach'
import { splitGst } from '@/lib/revenue'
import { GST_RATE } from '@/lib/config'
import {
  type AdminAccount,
  describeTimeLeft,
  expiryAfterRenewal,
  formatDate,
  isPlanId,
  planLabel,
} from '@/lib/subscription'
import { money } from './charts'
import { Button, Input, Modal, Notice } from './ui'

const METHODS = [
  { value: 'upi', label: 'UPI' },
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
] as const

export function PaymentModal({
  accounts,
  preselected,
  onClose,
  onRecorded,
}: {
  accounts: AdminAccount[]
  /** The account to start on, when opened from a row rather than the header. */
  preselected?: AdminAccount | null
  onClose: () => void
  /** Handed the updated account, so the table and the ledger both refresh. */
  onRecorded: (account: AdminAccount) => void
}) {
  const [refund, setRefund] = useState(false)
  const [query, setQuery] = useState('')
  const [accountId, setAccountId] = useState(preselected?.id ?? '')
  const [plan, setPlan] = useState<string>(preselected?.subscription?.plan ?? DEFAULT_PLAN)
  const [amount, setAmount] = useState<string>(String(PLAN_PRICE[preselected?.subscription?.plan ?? DEFAULT_PLAN] ?? ''))
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('upi')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const account = useMemo(() => accounts.find((a) => a.id === accountId) ?? null, [accounts, accountId])

  /*
   * The picker is a filtered list rather than a `<select>`: a hundred shops in a native dropdown is
   * a scroll, and the name is not always what you remember — the phone number or the email is.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const pool = accounts.filter((a) => a.role !== 'superadmin')
    if (!needle) return pool.slice(0, 8)
    return pool
      .filter((a) =>
        [a.shopName, a.name, a.email, a.phone].filter(Boolean).some((field) => String(field).toLowerCase().includes(needle)),
      )
      .slice(0, 8)
  }, [accounts, query])

  const value = Number(amount)
  const valid = Number.isFinite(value) && value > 0
  const split = valid ? splitGst(value) : null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setDone('')

    if (!account) {
      setError('Choose the account this belongs to.')
      return
    }
    if (!valid) {
      setError(refund ? 'Enter the amount that was actually returned.' : 'Enter the amount that was actually received.')
      return
    }

    setBusy(true)
    try {
      const record = refund ? recordRefund : recordPayment
      const updated = await record({
        accountId: account.id,
        amount: value,
        plan,
        method,
        reference: reference.trim(),
        note: note.trim(),
      })
      setDone(
        refund
          ? `₹${formatAmount(value)} refunded. The licence is unchanged — ${describeTimeLeft(updated).toLowerCase()}.`
          : `₹${formatAmount(value)} recorded. ${describeTimeLeft(updated)}.`,
      )
      setReference('')
      setNote('')
      onRecorded(updated)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /* Shown before the payment is taken, so the consequence is visible in advance. */
  const wouldExpire = !refund && account && isPlanId(plan) ? expiryAfterRenewal(account, plan) : null

  return (
    <Modal
      open
      onClose={onClose}
      title={refund ? 'Record a refund' : 'Record a payment'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            type="submit"
            form="payment-form"
            variant={refund ? 'danger' : 'primary'}
            loading={busy}
            disabled={!account || !valid}
          >
            {refund ? 'Record refund' : 'Record payment'}
          </Button>
        </>
      }
    >
      <form id="payment-form" onSubmit={submit} className="space-y-3.5">
        {/* ── direction ──────────────────────────────────────────────────── */}
        <div
          className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors ${
            refund ? 'border-rose-500/40 bg-rose-500/10' : 'border-white/10 bg-slate-950/30'
          }`}
        >
          <input
            id="is-refund"
            type="checkbox"
            checked={refund}
            onChange={(event) => {
              setRefund(event.target.checked)
              setDone('')
            }}
            className="mt-0.5 h-4 w-4 accent-rose-500"
          />
          <label htmlFor="is-refund" className="text-[13px] leading-relaxed">
            <span className={`font-semibold ${refund ? 'text-rose-200' : 'text-slate-200'}`}>This is a refund</span>
            <span className="block text-[12px] text-slate-400">
              Money going back out. It subtracts from revenue and takes its GST with it, and{' '}
              <strong className="font-semibold">the licence keeps running</strong> — shortening a term is a separate,
              deliberate amendment.
            </span>
          </label>
        </div>

        {/* ── who ────────────────────────────────────────────────────────── */}
        {account ? (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/30 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-semibold text-slate-100">
                {account.shopName || account.name || account.email}
              </p>
              <p className="truncate text-[12px] text-slate-400">
                {account.email}
                {account.subscription?.plan && ` · ${planLabel(account.subscription.plan)}`}
                {' · '}
                {describeTimeLeft(account)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setAccountId('')
                setQuery('')
              }}
              className="shrink-0 text-[12px] font-semibold text-sky-300 hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div>
            <Input
              label="Account"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Shop, name, email or phone"
              autoFocus
            />
            <ul className="mt-1.5 max-h-52 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40">
              {matches.length === 0 && (
                <li className="px-3 py-2.5 text-[12.5px] text-slate-500">No account matches that.</li>
              )}
              {matches.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setAccountId(option.id)
                      const theirPlan = option.subscription?.plan ?? DEFAULT_PLAN
                      setPlan(theirPlan)
                      /* Pre-filled from the price list, because it is right most of the time. */
                      setAmount(String(PLAN_PRICE[theirPlan] ?? ''))
                    }}
                    className="flex w-full items-baseline justify-between gap-3 border-b border-white/[0.06] px-3 py-2 text-left last:border-0 hover:bg-white/[0.04]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-slate-100">
                        {option.shopName || option.name || option.email}
                      </span>
                      <span className="block truncate text-[11.5px] text-slate-500">{option.email}</span>
                    </span>
                    <span className="shrink-0 text-[11.5px] text-slate-400">
                      {option.subscription?.plan ? planLabel(option.subscription.plan) : '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── how much ───────────────────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={refund ? 'Amount returned (₹)' : 'Amount received (₹)'}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="3000"
          />
          <div>
            <label className="label" htmlFor="payment-plan">
              Plan
            </label>
            <select
              id="payment-plan"
              className="field"
              value={plan}
              onChange={(event) => {
                setPlan(event.target.value)
                if (!refund) setAmount(String(PLAN_PRICE[event.target.value] ?? amount))
              }}
            >
              {PLANS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — ₹{formatAmount(PLAN_PRICE[option.value] ?? 0)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* The tax split, shown live: the figure that will land in the GST report. */}
        {split && (
          <p className="rounded-xl border border-white/10 bg-slate-950/30 px-3 py-2 text-[12.5px] text-slate-300">
            {refund ? 'Reverses' : 'Contains'}{' '}
            <strong className="font-semibold text-slate-100">{money(split.gst)}</strong> of GST at{' '}
            {(GST_RATE * 100).toFixed(0)}% on {money(split.taxable)} of value.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="payment-method">
              Method
            </label>
            <select
              id="payment-method"
              className="field"
              value={method}
              onChange={(event) => setMethod(event.target.value as (typeof METHODS)[number]['value'])}
            >
              {METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="UPI id, cheque no."
          />
        </div>

        <Input
          label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={refund ? 'Why it was returned' : 'Anything worth remembering'}
        />

        {wouldExpire && (
          <p className="text-[12.5px] text-slate-400">
            Taking this extends the licence to <strong className="font-semibold text-slate-200">{formatDate(wouldExpire)}</strong>.
          </p>
        )}

        {error && <Notice tone="danger">{error}</Notice>}
        {done && <Notice tone="success">{done}</Notice>}
      </form>
    </Modal>
  )
}

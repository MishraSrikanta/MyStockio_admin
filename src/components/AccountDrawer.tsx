import { useState } from 'react'
import { PLAN_PRICE, PLANS } from '@/lib/config'
import { ApiError, deleteAccount, recordPayment, updateAccount } from '@/lib/api'
import { formatAmount, normalisePhone, reminderMessage, toneFor, whatsappLink } from '@/lib/outreach'
import { childrenOf, isStaff, nameOf, ownerOf, ROLE_LABEL, roleOf } from '@/lib/roles'
import {
  SOFTWARE_LABEL,
  SOFTWARE_NOTE,
  SOFTWARE_TYPES,
  SoftwareType,
  softwareLabelOf,
  softwareOf,
} from '@/lib/software'
import {
  type AdminAccount,
  describeTimeLeft,
  expiryAfterRenewal,
  formatDate,
  isLifetime,
  isPlanId,
  planLabel,
} from '@/lib/subscription'
import { Badge, Button, Input, Modal, Notice } from './ui'

/**
 * Everything that can be done to one account: amend it, take money for it, chase it, remove it.
 *
 * One dialog rather than four screens, because in practice these happen together — a shop rings
 * up, the number on file is wrong, they pay, and they want a receipt. Splitting that across four
 * navigations is how the phone number never gets corrected.
 */
export function AccountDrawer({
  account,
  accounts,
  onClose,
  onChanged,
}: {
  account: AdminAccount
  /** Everything loaded, so this shop's staff — or this login's owner — can be shown. */
  accounts: AdminAccount[]
  onClose: () => void
  onChanged: (account: AdminAccount | null) => void
}) {
  /* Who this is, and the family around them. Read once here rather than in four places below. */
  const role = roleOf(account)
  const staffMember = isStaff(account)
  const owner = staffMember ? ownerOf(account, accounts) : null
  const staff = staffMember ? [] : childrenOf(accounts, account.id)

  const [form, setForm] = useState({
    shopName: account.shopName ?? '',
    name: account.name ?? '',
    email: account.email ?? '',
    phone: account.phone ?? '',
    password: '',
  })
  const [plan, setPlan] = useState<string>(account.subscription?.plan ?? '1year')
  /* Seeded from what they are on now, so the radios show the truth before anything is touched. */
  const [software, setSoftware] = useState<SoftwareType>(softwareOf(account))
  const [amount, setAmount] = useState<string>(String(PLAN_PRICE[plan] ?? ''))
  const [method, setMethod] = useState<'cash' | 'upi' | 'bank' | 'card' | 'other'>('upi')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'pay' | 'delete'>('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [confirmDelete, setConfirmDelete] = useState('')

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
    setDone('')
  }

  const fail = (caught: unknown) => setError(caught instanceof ApiError ? caught.message : (caught as Error).message)

  const save = async () => {
    setError('')
    setDone('')
    if (!form.email.trim()) {
      setError('An account needs an email — it is what they log in with.')
      return
    }
    setBusy('save')
    try {
      /* Only what changed, and the password only when one was typed. */
      const updated = await updateAccount(account.id, {
        shopName: form.shopName.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        ...(form.password ? { password: form.password } : {}),
        /*
         * Sent for an owner only, and only when it changed. Staff have no edition of their own — the
         * server refuses one — and re-sending an unchanged value would make every save look like an
         * edition change in whatever audit trail the backend keeps.
         */
        ...(!staffMember && software !== softwareOf(account) ? { softwareType: software } : {}),
      })
      setForm((current) => ({ ...current, password: '' }))
      setDone(form.password ? 'Saved. The new password works immediately.' : 'Saved.')
      onChanged(updated)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy('')
    }
  }

  const pay = async () => {
    setError('')
    setDone('')
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the amount that was actually received.')
      return
    }
    setBusy('pay')
    try {
      /*
       * One call. Money received and time granted are the same event, so the server does both —
       * two requests would let a network failure between them leave a shop that has paid and not
       * been credited.
       */
      const updated = await recordPayment({
        accountId: account.id,
        amount: value,
        plan,
        method,
        reference: reference.trim(),
      })
      setReference('')
      setDone(`₹${formatAmount(value)} recorded. ${describeTimeLeft(updated)}.`)
      onChanged(updated)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy('')
    }
  }

  const remove = async () => {
    setError('')
    setBusy('delete')
    try {
      await deleteAccount(account.id)
      onChanged(null)
      onClose()
    } catch (caught) {
      fail(caught)
      setBusy('')
    }
  }

  /* What the licence would run to if this payment is taken — shown before it is. */
  const wouldExpire = isPlanId(plan) ? expiryAfterRenewal(account, plan) : null
  const tone = toneFor(account)
  const message = reminderMessage(account, tone)
  const chase = whatsappLink(account, message)
  const receiptLink = whatsappLink(account, reminderMessage(account, 'receipt', { amount: Number(amount) || undefined }))
  const reachable = normalisePhone(form.phone) !== ''

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate">{account.shopName || account.name || account.email}</span>
          {isLifetime(account) ? (
            <Badge tone="violet">Lifetime</Badge>
          ) : (
            <Badge tone={tone === 'expired' ? 'danger' : 'warning'}>{describeTimeLeft(account)}</Badge>
          )}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy === 'save'} onClick={() => void save()}>
            Save details
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Notice tone="danger" onDismiss={() => setError('')}>{error}</Notice>}
        {done && <Notice tone="success" onDismiss={() => setDone('')}>{done}</Notice>}

        {/* ── the subscription as it stands ─────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Plan', planLabel(account.subscription?.plan)],
            ['Time left', describeTimeLeft(account)],
            ['Expires', isLifetime(account) ? 'Never' : formatDate(account.subscription?.expiresAt) || '—'],
            [
              'Last payment',
              account.lastPaymentAt
                ? `₹${formatAmount(account.lastPaymentAmount ?? 0)} · ${formatDate(account.lastPaymentAt)}`
                : 'None recorded',
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/40 px-2.5 py-2">
              <p className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
              <p className="mt-0.5 truncate text-[13px] font-semibold text-slate-100">{value}</p>
            </div>
          ))}
        </div>

        {/* ── who this login is, and who it belongs to ────────────────────── */}
        <section className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400">
              {staffMember ? 'Their role' : 'Staff logins'}
            </h3>
            <Badge tone={staffMember ? 'info' : 'neutral'}>{ROLE_LABEL[role]}</Badge>
          </div>

          {staffMember ? (
            /*
             * A staff login. The licence tiles above are their **owner's**, so it is said here in
             * words — a screen that shows a cashier an expiry with no explanation invites somebody
             * to renew a cashier, which the server refuses and which nobody should be asked to try.
             */
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-300">
              {owner ? (
                <>
                  Works for <strong className="font-semibold text-slate-100">{nameOf(owner)}</strong>{' '}
                  <span className="text-slate-500">({owner.email})</span> and signs in on that shop’s licence. Payments and renewals belong to the owner, not to this login.
                </>
              ) : (
                <span className="text-rose-300">
                  This login has no owner on record{account.ownerEmail ? ` (${account.ownerEmail} was given)` : ''}.
                  It can still sign in, but it is attached to no shop and no licence — set an owner, or
                  delete it.
                </span>
              )}
            </p>
          ) : staff.length === 0 ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-400">
              No staff logins yet. Cashiers, product managers and the rest are created from the
              accounts table — <em>add staff</em> on this shop’s row — and they ride on this licence
              rather than buying their own.
            </p>
          ) : (
            <>
              <ul className="mt-2 divide-y divide-white/[0.06]">
                {staff.map((member) => (
                  <li key={member.id} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-slate-100">{member.name || member.email}</span>
                      <span className="block truncate text-[11.5px] text-slate-500">{member.email}</span>
                    </span>
                    <Badge tone="info">{ROLE_LABEL[roleOf(member)]}</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-500">
                All {staff.length} on this shop’s licence. Deleting this account is refused while they
                exist — they would be left able to sign in and attached to nothing.
              </p>
            </>
          )}
        </section>

        {/* ── which software they are on ─────────────────────────────────── */}
        <section className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400">Software</h3>
            <Badge tone={softwareOf(account) === SoftwareType.Mini ? 'warning' : 'info'}>
              {softwareLabelOf(account)}
            </Badge>
          </div>

          {staffMember ? (
            /*
             * A staff login has no edition of its own — it reads the owner's, live. Shown here rather
             * than hidden, because "which software is this login on" is a fair question; offered as a
             * control it would be a switch that changes nothing, or worse, one that puts the counter
             * on a different edition from the shop.
             */
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-400">
              From {owner ? <strong className="font-semibold text-slate-200">{nameOf(owner)}</strong> : 'their owner'}
              , like the licence. To move this login to another edition, change it on the owner and every
              login under them follows.
            </p>
          ) : (
            <>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {SOFTWARE_TYPES.map((option) => (
                  <label
                    key={option}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition-colors ${
                      software === option ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name="drawer-software"
                      value={option}
                      checked={software === option}
                      onChange={() => {
                        setSoftware(option)
                        setDone('')
                      }}
                      className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold text-slate-100">{SOFTWARE_LABEL[option]}</span>
                      <span className="block text-[11.5px] text-slate-400">{SOFTWARE_NOTE[option]}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
                {staff.length > 0
                  ? `Changing this moves all ${staff.length} staff login${staff.length === 1 ? '' : 's'} with it — they read this shop’s edition rather than storing their own.`
                  : 'Saved with Save details. An account created before this field existed reads as MyStockio until it is set.'}
              </p>
            </>
          )}
        </section>

        {/* ── details ───────────────────────────────────────────────────── */}
        <section>
          <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-slate-400">Details</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Shop name" value={form.shopName} onChange={set('shopName')} />
            <Input label={staffMember ? 'Their name' : 'Owner name'} value={form.name} onChange={set('name')} />
            <Input
              label="Email (their user id)"
              value={form.email}
              onChange={set('email')}
              hint="This is what they sign in with."
            />
            <Input
              label="Phone"
              value={form.phone}
              onChange={set('phone')}
              hint={reachable ? 'WhatsApp reminders can reach this.' : 'Not a number WhatsApp can use.'}
            />
            <Input
              label="New password"
              type="text"
              value={form.password}
              onChange={set('password')}
              placeholder="Leave blank to keep the current one"
              hint="Typed in the clear on purpose — you have to read it back to them."
              className="sm:col-span-2"
            />
          </div>
        </section>

        {/* ── payment ───────────────────────────────────────────────────── */}
        {/*
          Owners only. Staff hold no licence, so the server refuses a payment against one — offering
          the form anyway would be offering an action that cannot succeed.
        */}
        {!staffMember && (
        <section className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
          <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-emerald-300">
            Record a payment
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="label">Paying for</span>
              <select
                className="field"
                value={plan}
                onChange={(event) => {
                  setPlan(event.target.value)
                  setAmount(String(PLAN_PRICE[event.target.value] ?? ''))
                }}
              >
                {PLANS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Amount received"
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <label className="block">
              <span className="label">How</span>
              <select className="field" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
                <option value="upi">UPI</option>
                <option value="cash">Cash</option>
                <option value="bank">Bank transfer</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </label>
            <Input
              label="Reference (optional)"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="UPI ref, cheque no…"
              className="sm:col-span-2"
            />
          </div>

          <p className="mt-2 text-[12.5px] text-slate-400">
            {plan === 'lifetime'
              ? 'This makes the licence lifetime — it will never expire.'
              : `Takes the licence to ${formatDate(wouldExpire) || '—'}.`}{' '}
            {!isLifetime(account) && (account.subscription?.expiresAt ?? '') !== '' && (
              <span className="text-slate-500">
                Time already paid for is kept — a renewal adds to the current date rather than
                replacing it.
              </span>
            )}
          </p>

          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button variant="success" loading={busy === 'pay'} onClick={() => void pay()}>
              Record payment
            </Button>
            {receiptLink && (
              <a href={receiptLink} target="_blank" rel="noreferrer">
                <Button variant="outline" type="button">
                  Send receipt on WhatsApp
                </Button>
              </a>
            )}
          </div>
        </section>
        )}

        {/* Chasing is an owner thing as well: a cashier is never rung about a renewal. */}
        {!staffMember && (
        <section>
          <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-slate-400">
            Renewal reminder
          </h3>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 text-[12.5px] leading-relaxed text-slate-300">
            {message}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {chase ? (
              <a href={chase} target="_blank" rel="noreferrer">
                <Button variant="primary" type="button">
                  Open WhatsApp
                </Button>
              </a>
            ) : (
              <Badge tone="danger">No usable phone number</Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(message).then(() => setDone('Message copied.'))}
            >
              Copy text
            </Button>
          </div>
        </section>
        )}

        {/* ── deletion ──────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-3">
          <h3 className="text-[12px] font-bold uppercase tracking-wider text-rose-300">Delete this account</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
            Permanent. They will not be able to sign in, and their payment history goes with it.
            Their Excel file is on their own computer and is not touched.
          </p>
          {staff.length > 0 && (
            <p className="mt-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-200">
              The server will refuse this while {staff.length} staff login{staff.length === 1 ? '' : 's'} belong to
              this shop. Move or delete them first — deleting them along with the owner would take away
              logins nobody asked about.
            </p>
          )}
          {/*
            Typing the name, not an "are you sure" — a confirm dialog is dismissed by reflex, and
            this is the one irreversible action on the screen.
          */}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Input
              label={`Type "${account.shopName || account.email}" to confirm`}
              value={confirmDelete}
              onChange={(event) => setConfirmDelete(event.target.value)}
              className="min-w-[14rem]"
            />
            <Button
              variant="danger"
              loading={busy === 'delete'}
              disabled={confirmDelete.trim() !== (account.shopName || account.email)}
              onClick={() => void remove()}
            >
              Delete for good
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  )
}

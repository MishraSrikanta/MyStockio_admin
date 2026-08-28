import { useMemo, useState } from 'react'
import { DEFAULT_PLAN, PLANS } from '@/lib/config'
import { SIGNUP_ACCESS_KEY } from '@/lib/access'
import { ApiError, createAccount } from '@/lib/api'
import {
  checkRoleChoice,
  nameOf,
  needsOwner,
  owners as ownersOf,
  Role,
  ROLE_LABEL,
  ROLE_NOTE,
  ROLES,
  shopNameFor,
} from '@/lib/roles'
import {
  checkSoftwareChoice,
  SOFTWARE_LABEL,
  SOFTWARE_NOTE,
  SOFTWARE_TYPES,
  softwareLabelOf,
  type SoftwareType,
} from '@/lib/software'
import type { AdminAccount } from '@/lib/subscription'
import { Button, Input, Modal, Notice } from './ui'

/**
 * Creating a login — an owner, or somebody who works for one.
 *
 * This goes through the **ordinary signup route** the shop app uses — genuinely the same endpoint,
 * which is why it works against the real backend today with nothing added. Two consequences worth
 * knowing while using it:
 *
 *   · The server issues the subscription from `plan` and computes the dates itself. An expiry
 *     cannot be typed here by design, so a lifetime licence is granted by choosing Lifetime rather
 *     than by entering a date far in the future.
 *   · Registration may be gated by an invite code. MyStockio's own signup form sends one, so the
 *     field is here too — leave it blank if the backend does not ask for it.
 *
 * ── The role, and what it changes on this form ─────────────────────────────────
 * **Role is the first question**, because it decides what the rest of the form even asks:
 *
 *   · **Owner** — the customer. Gets a plan, gets a licence, gets chased for renewal, and has no
 *     owner above them, so the owner field is not shown at all. Not disabled, not greyed out:
 *     *absent*, because a field that can never apply is noise.
 *   · **Anyone else** — staff. Belongs to an owner, so the owner's email becomes required. The plan
 *     picker disappears instead: staff ride on their owner's licence, and offering to sell a cashier
 *     their own subscription is offering to double-charge a shop.
 *
 * The owner is picked from the accounts already loaded, with a typed email as the fallback for one
 * that is not in the list. The email is what gets sent either way — the server resolves it and is
 * the authority on whether it exists and is really an owner. Posting an id from a list this screen
 * happens to be holding would attach somebody to the wrong shop the moment the list went stale.
 */
export function CreateAccountModal({
  onClose,
  onCreated,
  accounts,
  staffFor = null,
}: {
  onClose: () => void
  onCreated: (account: AdminAccount) => void
  /** Everything already loaded, so an owner can be picked rather than remembered. */
  accounts: AdminAccount[]
  /**
   * Opened from an owner's row: start as staff, already pointed at them.
   *
   * The role still defaults to the first non-owner one and stays changeable — the row said *who*,
   * not *what*, and guessing that a new login is a cashier because the button was near a cashier
   * would be guessing.
   */
  staffFor?: AdminAccount | null
}) {
  const [form, setForm] = useState({
    shopName: staffFor?.shopName ?? '',
    name: '',
    email: '',
    phone: '',
    password: '',
    ownerEmail: staffFor?.email ?? '',
    /*
     * Pre-filled rather than asked for. Whoever is on this screen has already passed the console
     * login, so making them retype a key that is a compile-time constant adds a step and no
     * protection. Left editable in case the backend's value changes before this file does.
     */
    developerCode: SIGNUP_ACCESS_KEY,
  })
  const [role, setRole] = useState<Role>(staffFor ? Role.Cashier : Role.Owner)
  const [plan, setPlan] = useState<string>(DEFAULT_PLAN)
  /*
   * **Deliberately empty to start.** A plan has a sensible default; an edition does not — which
   * product a shop bought is a commercial fact, and pre-selecting one means the form quietly answers
   * a question nobody asked. So it starts unset and the form refuses to submit until it is chosen.
   */
  const [software, setSoftware] = useState<SoftwareType | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  /**
   * Whether the shop name has been typed in by hand.
   *
   * The one thing an auto-filled field must never do is overwrite something a person entered. So
   * the moment the field is edited it stops following the owner, and picking a different owner
   * afterwards leaves what was typed alone.
   */
  const [shopNameEdited, setShopNameEdited] = useState(false)

  const staff = needsOwner(role)
  /** The owner currently named, so the form can say what this login will inherit. */
  const pickedOwner = useMemo(
    () =>
      accounts.find(
        (account) => account.email.trim().toLowerCase() === form.ownerEmail.trim().toLowerCase(),
      ) ?? null,
    [accounts, form.ownerEmail],
  )
  /** Only owners can be picked as an owner — two levels, so staff are not offered. */
  const pickableOwners = useMemo(() => ownersOf(accounts), [accounts])

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
    if (key === 'shopName') setShopNameEdited(true)
    if (fieldErrors[key]) setFieldErrors((current) => ({ ...current, [key]: '' }))
  }

  /**
   * Points the form at an owner, and brings the shop name with it.
   *
   * A staff login is somebody who works in that shop — same shop name, and the licence is the
   * owner's whether this form says so or not. Making somebody retype the shop name they can see two
   * fields above is busywork, and the version they retype is the one that ends up spelled
   * differently.
   *
   * Copied rather than locked: a second branch under one owner is a real thing, so the field stays
   * editable. And copied only while untouched — see `shopNameEdited`.
   */
  const chooseOwner = (email: string) => {
    const owner = accounts.find((account) => account.email.trim().toLowerCase() === email.trim().toLowerCase()) ?? null
    setForm((current) => ({
      ...current,
      ownerEmail: email,
      /* The rule lives in `roles.ts`, where the tests can hold it to account. */
      shopName: shopNameFor({ owner, current: current.shopName, edited: shopNameEdited }),
    }))
    setFieldErrors((current) => ({ ...current, ownerEmail: '' }))
  }

  /**
   * The same checks MyStockio's signup form ran, kept per-field rather than as one message.
   *
   * A single "please check the details" on a six-field form makes somebody re-read all six. The
   * server validates again and answers with its own per-field detail; this is only so the obvious
   * omissions do not need a round trip.
   */
  const validate = () => {
    const errors: Record<string, string> = {}
    if (!form.name.trim()) errors.name = staff ? 'Enter their name.' : 'Enter the owner’s name.'
    if (!form.email.trim()) errors.email = 'An email is required — it is their user id.'
    if (!form.password) errors.password = 'Set a password you can read back to them.'
    if (!form.developerCode.trim()) errors.developerCode = 'The backend expects an invite code.'

    /*
     * Mandatory for an owner only. Staff take the owner's edition, so asking would be asking
     * somebody to answer for a second time on behalf of a shop that has already answered.
     */
    if (!staff) {
      const wrong = checkSoftwareChoice(software)
      if (wrong) errors.softwareType = wrong
    }

    /* The role rule, from the same function the tests assert against. */
    const problem = checkRoleChoice({ role, ownerEmail: form.ownerEmail }, accounts)
    if (problem) errors[problem.field] = problem.message

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')

    if (!validate()) return

    setBusy(true)
    try {
      const account = await createAccount({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone,
        shopName: form.shopName,
        /* A plan and an edition for an owner only — staff are on their owner's. */
        ...(staff ? {} : { plan, softwareType: software }),
        shopRole: role,
        ...(staff ? { ownerEmail: form.ownerEmail.trim() } : {}),
        developerCode: form.developerCode.trim() || undefined,
      })
      onCreated(account)
      onClose()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={staff ? `New ${ROLE_LABEL[role].toLowerCase()} login` : 'New customer account'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={(event) => void submit(event)}>
            {staff ? `Create ${ROLE_LABEL[role].toLowerCase()}` : 'Create account'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        {error && <Notice tone="danger" onDismiss={() => setError('')}>{error}</Notice>}

        {/* ── the role, first, because it decides what the rest of the form asks ── */}
        <fieldset>
          <legend className="label">Role</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {ROLES.map((option) => (
              <label
                key={option}
                className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition-colors ${
                  role === option ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'
                }`}
              >
                <input
                  type="radio"
                  name="shopRole"
                  value={option}
                  checked={role === option}
                  onChange={() => {
                    setRole(option)
                    /* Clearing both: neither error can still be true of the new choice. */
                    setFieldErrors((current) => ({ ...current, ownerEmail: '', role: '' }))
                  }}
                  className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-slate-100">{ROLE_LABEL[option]}</span>
                  <span className="block text-[11.5px] leading-snug text-slate-400">{ROLE_NOTE[option]}</span>
                </span>
              </label>
            ))}
          </div>
          {fieldErrors.role && <p className="mt-1 text-[12px] text-rose-300">{fieldErrors.role}</p>}
        </fieldset>

        {/*
          Shown only for staff. An owner has nobody above them, so the field is absent rather than
          disabled — a control that can never apply is noise, and a greyed-out one still gets read.
        */}
        {staff && (
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/[0.07] p-3">
            {pickableOwners.length > 0 && (
              <select
                id="owner-picker"
                aria-label="Choose an owner"
                className="field mb-2"
                value={pickableOwners.some((o) => o.email === form.ownerEmail) ? form.ownerEmail : ''}
                onChange={(event) => chooseOwner(event.target.value)}
              >
                <option value="">Choose an owner…</option>
                {pickableOwners.map((owner) => (
                  <option key={owner.id} value={owner.email}>
                    {nameOf(owner)} — {owner.email}
                  </option>
                ))}
              </select>
            )}
            <Input
              label="Owner’s email"
              value={form.ownerEmail}
              /* Through `chooseOwner`, so a typed address fills the shop name just as the picker does. */
              onChange={(event) => chooseOwner(event.target.value)}
              placeholder="owner@shop.com"
              error={fieldErrors.ownerEmail}
              hint={
                pickableOwners.length > 0
                  ? 'Picked above, or typed here if they are not in the list yet.'
                  : 'No owners are loaded yet — type the email of the owner this login belongs to.'
              }
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-400">
              This login takes the owner’s <strong className="font-semibold text-slate-300">software,
              shop name, plan and expiry</strong>. All four stay the owner’s — read live, so an upgrade or
              a renewal moves this login with it, and it is never chased or counted as a second customer.
              {pickedOwner && (
                <>
                  {' '}Currently <strong className="font-semibold text-slate-300">{softwareLabelOf(pickedOwner)}</strong>.
                </>
              )}
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={staff ? 'Shop name (optional)' : 'Shop name'}
            value={form.shopName}
            onChange={set('shopName')}
            placeholder="Balaji Traders"
            hint={
              staff && !shopNameEdited && form.shopName
                ? 'Copied from the owner. Change it if this login sits in a different branch.'
                : staff
                  ? 'Left blank, the owner’s is used.'
                  : undefined
            }
          />
          <Input
            label={staff ? 'Their name' : 'Owner name'}
            value={form.name}
            onChange={set('name')}
            placeholder={staff ? 'Rekha Devi' : 'Ramesh Kumar'}
            error={fieldErrors.name}
          />
          <Input
            label="Email (their user id)"
            type="email"
            value={form.email}
            onChange={set('email')}
            hint="What they will sign into MyStockio with."
            error={fieldErrors.email}
          />
          <Input label="Phone" value={form.phone} onChange={set('phone')} placeholder="9876543210" hint="Used for WhatsApp reminders." />
          <Input
            label="Password"
            type="text"
            value={form.password}
            onChange={set('password')}
            hint="Shown in the clear — you have to read it out to them."
            error={fieldErrors.password}
            className="sm:col-span-2"
          />
        </div>

        {/*
          ── which product ────────────────────────────────────────────────────
          Owners only, and **required**: which edition a shop bought is a commercial fact this app
          cannot infer, and a wrong guess surfaces months later as a support call about a feature
          they never had. Nothing is pre-selected for the same reason.

          Staff are not asked at all — they use whatever the shop uses, so the answer is the owner's
          and asking again would invite two different answers for one shop.
        */}
        {!staff && (
          <fieldset>
            <legend className="label">
              Software <span className="font-normal text-rose-300">· required</span>
            </legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {SOFTWARE_TYPES.map((option) => (
                <label
                  key={option}
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition-colors ${
                    software === option
                      ? 'border-sky-500 bg-sky-500/10'
                      : fieldErrors.softwareType
                        ? 'border-rose-500/60 hover:border-rose-400'
                        : 'border-slate-700 hover:border-slate-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="softwareType"
                    value={option}
                    checked={software === option}
                    onChange={() => {
                      setSoftware(option)
                      setFieldErrors((current) => ({ ...current, softwareType: '' }))
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
            {fieldErrors.softwareType && (
              <p className="mt-1 text-[12px] font-medium text-rose-400">{fieldErrors.softwareType}</p>
            )}
          </fieldset>
        )}

        {/* Owners only. Staff are on the owner's licence — see the note in the owner block above. */}
        {!staff && (
        <fieldset>
          <legend className="label">Subscription</legend>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {PLANS.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition-colors ${
                  plan === option.value ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'
                }`}
              >
                <input
                  type="radio"
                  name="plan"
                  value={option.value}
                  checked={plan === option.value}
                  onChange={() => setPlan(option.value)}
                  className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-slate-100">{option.label}</span>
                  <span className="block text-[11.5px] text-slate-400">{option.note}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] text-slate-500">
            The server sets the dates from the plan — an expiry cannot be entered by hand, which is
            what stops the two from ever disagreeing.
          </p>
        </fieldset>
        )}

        <Input
          label="Invite code (sent as developerCode)"
          value={form.developerCode}
          onChange={set('developerCode')}
          error={fieldErrors.developerCode}
          hint="Pre-filled from the shared constant. The server checks it."
        />
      </form>
    </Modal>
  )
}

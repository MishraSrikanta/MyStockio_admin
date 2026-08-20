import { useState } from 'react'
import { DEFAULT_PLAN, PLANS } from '@/lib/config'
import { SIGNUP_ACCESS_KEY } from '@/lib/access'
import { ApiError, createAccount } from '@/lib/api'
import type { AdminAccount } from '@/lib/subscription'
import { Button, Input, Modal, Notice } from './ui'

/**
 * Creating a customer account.
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
 */
export function CreateAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (account: AdminAccount) => void
}) {
  const [form, setForm] = useState({
    shopName: '',
    name: '',
    email: '',
    phone: '',
    password: '',
    /*
     * Pre-filled rather than asked for. Whoever is on this screen has already passed the console
     * login, so making them retype a key that is a compile-time constant adds a step and no
     * protection. Left editable in case the backend's value changes before this file does.
     */
    developerCode: SIGNUP_ACCESS_KEY,
  })
  const [plan, setPlan] = useState<string>(DEFAULT_PLAN)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
    if (fieldErrors[key]) setFieldErrors((current) => ({ ...current, [key]: '' }))
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
    if (!form.name.trim()) errors.name = 'Enter the owner’s name.'
    if (!form.email.trim()) errors.email = 'An email is required — it is their user id.'
    if (!form.password) errors.password = 'Set a password you can read back to them.'
    if (!form.developerCode.trim()) errors.developerCode = 'The backend expects an invite code.'
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
        plan,
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
      title="New customer account"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={(event) => void submit(event)}>
            Create account
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        {error && <Notice tone="danger" onDismiss={() => setError('')}>{error}</Notice>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Shop name" value={form.shopName} onChange={set('shopName')} placeholder="Balaji Traders" />
          <Input label="Owner name" value={form.name} onChange={set('name')} placeholder="Ramesh Kumar" error={fieldErrors.name} />
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

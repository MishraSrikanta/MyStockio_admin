/**
 * The console for MyTransport and MyClinic: customers, their logins, and what
 * each is paying for.
 *
 * ── Why this is a separate screen from the MyStockio one ───────────────────────
 * The accounts table next door is built on a shop with a subscription, an expiry,
 * a chase list and a payments ledger. None of that exists on this backend: a
 * customer here is a haulage company on a plan, or a practice whose branches each
 * hold a licence. Reusing that table would mean five columns permanently reading
 * "—" and a renewal reminder that could never be sent.
 *
 * So the shape follows the data. One row per customer, expandable to its logins,
 * with the entitlement each product actually models shown beside it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '@/lib/api'
import {
  type Billing,
  type Branch,
  type BranchDetails,
  createBranch,
  createPlatformAccount,
  createTenant,
  deletePlatformAccount,
  fetchBilling,
  listBranches,
  fetchBranch,
  updateBranch,
  deleteBranch,
  fetchCatalogue,
  isPlatformOwner,
  listPlatformAccounts,
  listTenants,
  type PlatformAccount,
  type ProductCatalogue,
  type Tenant,
  tenantIdOf,
  updatePlatformAccount,
  updateTenant,
} from '@/lib/platformApi'
import type { Product } from '@/lib/products'
import { Badge, Button, Input, Modal, Notice } from './ui'

/** A job title as a person reads it: `clinic_admin` → `Clinic admin`. */
function roleLabel(role: string): string {
  const spaced = role.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function PlatformConsole({ product }: { product: Product }) {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [accounts, setAccounts] = useState<PlatformAccount[]>([])
  const [catalogue, setCatalogue] = useState<ProductCatalogue | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const [creatingTenant, setCreatingTenant] = useState(false)
  const [addingTo, setAddingTo] = useState<Tenant | null>(null)
  const [editing, setEditing] = useState<PlatformAccount | null>(null)
  const [billingFor, setBillingFor] = useState<Tenant | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      /*
       * Three requests, and the catalogue is allowed to fail on its own. Roles
       * are needed to draw a form, not to read the list — losing the whole screen
       * because one of them 404'd would be the wrong trade.
       */
      const [nextTenants, nextAccounts] = await Promise.all([
        listTenants(product),
        listPlatformAccounts(product),
      ])
      setTenants(nextTenants)
      setAccounts(nextAccounts)
      fetchCatalogue(product)
        .then(setCatalogue)
        .catch(() => setCatalogue(null))
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      setTenants([])
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }, [product])

  /* Re-runs when the product changes, which is the whole point of the switcher. */
  useEffect(() => {
    void refresh()
  }, [refresh])

  /* Logins indexed by customer once, rather than scanned per row. */
  const byTenant = useMemo(() => {
    const map = new Map<string, PlatformAccount[]>()
    for (const account of accounts) {
      const id = tenantIdOf(account)
      if (!id) continue
      const list = map.get(id)
      if (list) list.push(account)
      else map.set(id, [account])
    }
    for (const list of map.values()) {
      /* The owner first, then everybody else by name — a family reads top down. */
      list.sort((a, b) => Number(isPlatformOwner(b)) - Number(isPlatformOwner(a)) || a.name.localeCompare(b.name))
    }
    return map
  }, [accounts])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return tenants
    return tenants.filter((tenant) => {
      if ([tenant.name, tenant.contactName, tenant.email, tenant.phone, tenant.city].some((field) =>
        String(field ?? '').toLowerCase().includes(needle),
      )) {
        return true
      }
      /* A search finds a customer by one of its logins too — somebody looking up
       * a person's email does not know which company they belong to. */
      return (byTenant.get(tenant.id) ?? []).some((account) =>
        [account.name, account.email].some((field) => String(field ?? '').toLowerCase().includes(needle)),
      )
    })
  }, [tenants, query, byTenant])

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const totalLogins = accounts.length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${product.tenantsLabel.toLowerCase()}, people, email…`}
            className="sm:w-80"
          />
          <span className="text-[12.5px] text-slate-500">
            {shown.length} {shown.length === 1 ? product.tenantLabel.toLowerCase() : product.tenantsLabel.toLowerCase()}
            {' · '}
            {totalLogins} login{totalLogins === 1 ? '' : 's'}
            {loading && ' · loading…'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
          <Button variant="primary" onClick={() => setCreatingTenant(true)}>
            New {product.tenantLabel.toLowerCase()}
          </Button>
        </div>
      </div>

      {error && (
        <Notice tone="danger" onDismiss={() => setError('')}>
          {error}
        </Notice>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="th">{product.tenantLabel}</th>
              <th className="th">Contact</th>
              <th className="th">Email</th>
              <th className="th">Phone</th>
              <th className="th">{product.module === 'clinic' ? 'Licences' : 'Plan'}</th>
              <th className="th">Logins</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td className="td text-center text-slate-500" colSpan={6}>
                  {loading
                    ? 'Loading…'
                    : error
                      ? 'Nothing could be loaded.'
                      : tenants.length === 0
                        ? `No ${product.tenantsLabel.toLowerCase()} yet.`
                        : 'Nothing matches that.'}
                </td>
              </tr>
            ) : (
              shown.flatMap((tenant) => {
                const logins = byTenant.get(tenant.id) ?? []
                const expanded = open.has(tenant.id)

                return [
                  <tr key={tenant.id} className="group hover:bg-slate-800/40">
                    <td className="td">
                      <div className="flex items-start gap-1.5">
                        {logins.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggle(tenant.id)}
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Show'} logins for ${tenant.name}`}
                            className="-ml-1 mt-px w-5 shrink-0 text-[15px] leading-none text-slate-400 hover:text-slate-100"
                          >
                            {expanded ? '▾' : '▸'}
                          </button>
                        ) : (
                          <span className="w-4 shrink-0" aria-hidden />
                        )}
                        <span className="min-w-0">
                          <span className="block font-semibold text-slate-100">{tenant.name}</span>
                          <span className="mt-0.5 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setAddingTo(tenant)}
                              className="text-[11.5px] text-slate-500 opacity-0 transition-opacity hover:text-sky-300 hover:underline focus:opacity-100 group-hover:opacity-100"
                            >
                              + add {product.staffLabel.toLowerCase()}
                            </button>
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="td">{tenant.contactName || <span className="text-slate-600">—</span>}</td>
                    <td className="td num truncate">{tenant.email || <span className="text-slate-600">—</span>}</td>
                    <td className="td num">{tenant.phone || <span className="text-slate-600">—</span>}</td>
                    <td className="td">
                      <button
                        type="button"
                        onClick={() => setBillingFor(tenant)}
                        className="text-left text-sky-300 hover:underline"
                      >
                        {product.module === 'clinic' ? 'View licences' : roleLabel(tenant.plan ?? 'trial')}
                      </button>
                    </td>
                    <td className="td num">
                      {logins.length === 0 ? (
                        <span className="text-rose-300" title="Nobody can sign in to this customer">
                          none
                        </span>
                      ) : (
                        <button type="button" onClick={() => toggle(tenant.id)} className="hover:underline">
                          {logins.length}
                        </button>
                      )}
                    </td>
                  </tr>,
                  ...(expanded
                    ? logins.map((account) => (
                        <tr key={account.id} className="bg-slate-900/40 hover:bg-slate-800/40">
                          <td className="td">
                            <div className="ml-1.5 border-l-2 border-white/10 pl-4">
                              <button
                                type="button"
                                onClick={() => setEditing(account)}
                                className="text-left font-medium text-slate-200 hover:text-sky-300 hover:underline"
                              >
                                {account.name}
                              </button>
                              {account.loginId && (
                                <span className="block text-[11.5px] text-slate-500">{account.loginId}</span>
                              )}
                            </div>
                          </td>
                          <td className="td">
                            <Badge tone={isPlatformOwner(account) ? 'neutral' : 'info'}>
                              {roleLabel(account.role)}
                            </Badge>
                          </td>
                          <td className="td num truncate">{account.email}</td>
                          <td className="td num">{account.phone || <span className="text-slate-600">—</span>}</td>
                          {/*
                            Was a permission count, which told nobody anything
                            useful: "9 permissions" does not say which, and the
                            answer is fixed by the role anyway. What an operator
                            actually needs to see at a glance on MyClinic is how
                            far this login reaches — every clinic, or which ones.
                          */}
                          <td className="td text-[12px] text-slate-500">
                            {product.module === 'clinic' ? (
                              isPlatformOwner(account) ? (
                                <span className="text-slate-400">All clinics</span>
                              ) : (
                                `${account.clinicIds?.length ?? 0} clinic${
                                  (account.clinicIds?.length ?? 0) === 1 ? '' : 's'
                                }`
                              )
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                          <td className="td">
                            {account.isActive ? (
                              <span className="text-slate-600">—</span>
                            ) : (
                              <Badge tone="danger">Suspended</Badge>
                            )}
                          </td>
                        </tr>
                      ))
                    : []),
                ]
              })
            )}
          </tbody>
        </table>
      </div>

      {creatingTenant && (
        <TenantForm
          catalogue={catalogue}
          product={product}
          onClose={() => setCreatingTenant(false)}
          onDone={() => {
            setCreatingTenant(false)
            void refresh()
          }}
        />
      )}
      {addingTo && (
        <AccountForm
          product={product}
          tenant={addingTo}
          catalogue={catalogue}
          onClose={() => setAddingTo(null)}
          onDone={() => {
            setAddingTo(null)
            void refresh()
          }}
        />
      )}
      {editing && (
        <AccountForm
          product={product}
          account={editing}
          catalogue={catalogue}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            void refresh()
          }}
        />
      )}
      {billingFor && (
        <BillingDialog
          product={product}
          tenant={billingFor}
          onClose={() => setBillingFor(null)}
          onDone={() => {
            setBillingFor(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

/* ──────────────────────────────────────────── a clinic's details ── */

/** The empty branch. Every field optional — see `BranchDetails`. */
const BLANK_BRANCH: Required<BranchDetails> = {
  name: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  state: '',
  timezone: '',
  bookingEnabled: true,
}

/**
 * A clinic's own details — the same fields whether it is being opened or fixed.
 *
 * One component for both, because the fields are identical and two copies drift:
 * the day somebody adds a pincode to the create form and forgets the edit form
 * is the day a branch gains a field it can never correct.
 *
 * Blank means "inherit from the practice" on a new branch, and "leave alone" on
 * an existing one. That difference is stated in the hint rather than left for
 * the operator to discover.
 */
function BranchFields({
  value,
  onChange,
  creating,
}: {
  value: Required<BranchDetails>
  onChange: (next: Required<BranchDetails>) => void
  creating: boolean
}) {
  const set =
    (key: keyof BranchDetails) => (event: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, [key]: event.target.value })

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Input
        label="Clinic name"
        value={value.name}
        onChange={set('name')}
        placeholder="Saheed Nagar branch"
        className="sm:col-span-2"
      />
      <Input
        label="Phone"
        value={value.phone}
        onChange={set('phone')}
        placeholder={creating ? "the practice's" : ''}
      />
      <Input
        label="Email"
        type="email"
        value={value.email}
        onChange={set('email')}
        placeholder={creating ? "the practice's" : ''}
      />
      <Input
        label="Address"
        value={value.address}
        onChange={set('address')}
        className="sm:col-span-2"
      />
      <Input label="City" value={value.city} onChange={set('city')} />
      <Input label="State" value={value.state} onChange={set('state')} />
      <Input
        label="Timezone"
        value={value.timezone}
        onChange={set('timezone')}
        placeholder="Asia/Kolkata"
        hint="Appointment times are read in it."
      />
      <label className="flex items-start gap-2 self-end rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2.5">
        <input
          type="checkbox"
          checked={value.bookingEnabled}
          onChange={(event) => onChange({ ...value, bookingEnabled: event.target.checked })}
          className="mt-0.5 h-4 w-4 accent-sky-500"
        />
        <span className="text-[13px] leading-relaxed">
          <span className="font-semibold text-slate-200">Bookable online</span>
          <span className="block text-[12px] text-slate-400">
            Patients can book this clinic from the public page.
          </span>
        </span>
      </label>
      <p className="text-[12px] leading-relaxed text-slate-500 sm:col-span-2">
        {creating
          ? 'Anything left blank is taken from the practice. Fill these in when a branch differs — a second clinic that inherits the first one’s address shows that address on its public booking page.'
          : 'Only what you change is sent. The clinic’s code and its public web address are fixed — every login ID and printed link depends on them.'}
      </p>
    </div>
  )
}

/**
 * Correcting one clinic's details, inline in the licence dialog.
 *
 * Collapsed until asked for, and it only fetches when opened. The dialog can
 * list a dozen branches, and pre-loading every one of them would fire a dozen
 * requests to draw a panel nobody may touch.
 */
function BranchEditor({
  product,
  clinicId,
  fallbackName,
  canDelete,
  onSaved,
}: {
  product: Product
  clinicId: string
  fallbackName: string
  canDelete: boolean
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Required<BranchDetails> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /*
   * Set when the server refuses a delete only because of live bookings, which
   * is the one refusal `force` can clear. The other two — the last clinic, and
   * a login that could open nothing else — are not offered a way past, because
   * both leave something broken rather than merely empty.
   */
  const [forceable, setForceable] = useState(false)

  const remove = async (force: boolean) => {
    setBusy(true)
    setError('')
    try {
      await deleteBranch(product, clinicId, { force })
      onSaved()
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : (caught as Error).message
      setError(message)
      setForceable(/live booking/i.test(message))
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open || form) return
    let live = true
    setError('')
    fetchBranch(product, clinicId)
      .then((branch) => {
        if (!live) return
        setForm({
          name: branch.name ?? fallbackName,
          phone: branch.phone ?? '',
          email: branch.email ?? '',
          address: branch.address ?? '',
          city: branch.city ?? '',
          state: branch.state ?? '',
          timezone: branch.timezone ?? '',
          bookingEnabled: branch.bookingEnabled !== false,
        })
      })
      .catch((caught) => {
        if (!live) return
        setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
        /* Still openable: the name is known from the list, so a failed fetch
           leaves an editable form rather than a dead panel. */
        setForm({ ...BLANK_BRANCH, name: fallbackName })
      })
    return () => {
      live = false
    }
  }, [open, form, product, clinicId, fallbackName])

  const save = async () => {
    if (!form) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      /* Sent whole, blanks included — on a PATCH an empty box is somebody
         clearing a field, not somebody declining to fill one in. */
      await updateBranch(product, clinicId, form)
      setSaved(true)
      onSaved()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-2 border-t border-white/10 pt-2">
        <Button variant="ghost" type="button" onClick={() => setOpen(true)}>
          Edit clinic details
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-2 border-t border-white/10 pt-3">
      {error && (
        <div className="mb-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {saved && (
        <div className="mb-2">
          <Notice tone="success">Saved.</Notice>
        </div>
      )}
      {form === null ? (
        <p className="text-[12.5px] text-slate-500">Loading…</p>
      ) : (
        <>
          <BranchFields
            value={form}
            onChange={(next) => {
              setForm(next)
              setSaved(false)
            }}
            creating={false}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" type="button" loading={busy} onClick={() => void save()}>
              Save clinic
            </Button>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>

          {canDelete && (
            <div className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-3">
              <h4 className="text-[12px] font-bold uppercase tracking-wider text-rose-300">
                Delete this clinic
              </h4>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
                Permanent, and it takes the clinic's licence and every slot published against it.
                Its code and public web address are released and cannot be reclaimed. Staff who can
                open other clinics simply lose this one; the server refuses if anybody would be
                left with nothing.
              </p>
              {confirmDelete ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    type="button"
                    loading={busy}
                    onClick={() => void remove(false)}
                  >
                    Yes, delete {fallbackName}
                  </Button>
                  {/* Only after the server has said bookings are the blocker,
                      and it has already said how many. */}
                  {forceable && (
                    <Button
                      variant="danger"
                      type="button"
                      loading={busy}
                      onClick={() => void remove(true)}
                    >
                      Delete anyway, cancelling those bookings
                    </Button>
                  )}
                  <Button variant="ghost" type="button" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  type="button"
                  className="mt-2"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete clinic
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────── a new customer ── */

function TenantForm({
  product,
  catalogue,
  onClose,
  onDone,
}: {
  product: Product
  catalogue: ProductCatalogue | null
  onClose: () => void
  onDone: () => void
}) {
  const clinic = product.module === 'clinic'
  const plans = catalogue?.plans ?? []

  const [form, setForm] = useState({
    businessName: '',
    name: '',
    email: '',
    password: '',
    phone: '',
    city: '',
    state: '',
    /* transport */
    plan: '',
    /* clinic — the licence date applies to every clinic created here */
    expiresAt: '',
  })
  /*
   * The clinics to open with the practice. One row to begin with, because a
   * practice with none cannot be booked into — and any number after that.
   */
  const [rows, setRows] = useState<Required<BranchDetails>[]>([{ ...BLANK_BRANCH }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /* The clinic API key comes back once and never again, so it is shown rather
   * than closed over — see the note in the dialog. */
  const [issued, setIssued] = useState<{
    apiKey?: string
    loginId?: string
    apiKeys?: { clinicName: string; code: string; apiKey: string }[]
  } | null>(null)

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const created = await createTenant(product, {
        name: form.name.trim(),
        businessName: form.businessName.trim(),
        email: form.email.trim(),
        password: form.password,
        phone: form.phone.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        /*
         * Only the chosen module's own fields. Posting both sets would write one
         * and have the other silently ignored, which reads at the far end as the
         * console losing data it plainly asked for.
         */
        ...(clinic
          ? {
              /*
               * Named rows only, and blanks stripped from each.
               *
               * On this endpoint an absent field means "inherit from the
               * practice" and `""` means "deliberately empty", so posting every
               * box whether filled or not would give the head office a blank
               * address instead of the practice's.
               */
              clinics: rows
                .filter((row) => row.name.trim())
                .map((row) => {
                  const out: BranchDetails & { name: string } = { name: row.name.trim() }
                  if (row.phone.trim()) out.phone = row.phone.trim()
                  if (row.email.trim()) out.email = row.email.trim()
                  if (row.address.trim()) out.address = row.address.trim()
                  if (row.city.trim()) out.city = row.city.trim()
                  if (row.state.trim()) out.state = row.state.trim()
                  if (row.timezone.trim()) out.timezone = row.timezone.trim()
                  out.bookingEnabled = row.bookingEnabled
                  return out
                }),
              /* Blank means a licence that does not lapse, which is `null` —
                 not an empty string the server would read as an invalid date. */
              expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
            }
          : { ...(form.plan ? { plan: form.plan } : {}) }),
      })
      if (created.apiKey) {
        setIssued({ apiKey: created.apiKey, loginId: created.loginId, apiKeys: created.apiKeys })
        return
      }
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (issued) {
    /* One key per clinic — they are separate credentials for separate
       installations, and a practice created with four clinics gets four. */
    const keys =
      issued.apiKeys && issued.apiKeys.length > 0
        ? issued.apiKeys
        : [{ clinicName: 'Clinic', code: '', apiKey: issued.apiKey ?? '' }]

    return (
      <Modal
        open
        title={keys.length === 1 ? 'Created — copy the key now' : `Created — copy all ${keys.length} keys now`}
        onClose={onDone}
      >
        <div className="space-y-3">
          <Notice tone="warning">
            {keys.length === 1 ? 'This key is' : 'These keys are'}{' '}
            <strong className="font-bold">shown once</strong>. Nothing on that API will return{' '}
            {keys.length === 1 ? 'it' : 'them'} again — a lost key has to be rotated, which stops
            that clinic's app syncing until somebody pastes the new one in.
          </Notice>
          {issued.loginId && (
            <div>
              <p className="label">Owner login ID</p>
              <p className="field font-mono text-[13px]">{issued.loginId}</p>
            </div>
          )}
          {keys.map((key, index) => (
            <div key={index}>
              <p className="label">
                {key.clinicName}
                {key.code && <span className="ml-1 text-slate-500">· {key.code}</span>}
              </p>
              <p className="field break-all font-mono text-[12.5px]">{key.apiKey}</p>
            </div>
          ))}
          <Button
            variant="primary"
            onClick={() =>
              void navigator.clipboard?.writeText(
                /* All of them, labelled — copying four keys one at a time from
                   a dialog that closes on the first click is how the fourth
                   gets lost. */
                keys.map((k) => `${k.clinicName}${k.code ? ` (${k.code})` : ''}: ${k.apiKey}`).join('\n'),
              )
            }
          >
            Copy {keys.length === 1 ? 'key' : `all ${keys.length} keys`}
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      title={`New ${product.tenantLabel.toLowerCase()} · ${product.label}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            form="tenant-form"
            type="submit"
            loading={busy}
            disabled={!form.businessName || !form.name || !form.email || !form.password}
          >
            Create
          </Button>
        </>
      }
    >
      <form id="tenant-form" onSubmit={submit} className="space-y-3">
        {error && <Notice tone="danger">{error}</Notice>}
        <p className="text-[12.5px] leading-relaxed text-slate-400">
          Creates the {product.tenantLabel.toLowerCase()} and its owner login together — one is
          useless without the other, so the server rolls both back if either fails.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={product.module === 'clinic' ? 'Practice name' : 'Company name'}
            value={form.businessName}
            onChange={set('businessName')}
            placeholder={product.module === 'clinic' ? 'Sunshine Diagnostics' : 'Balaji Transport'}
          />
          <Input label="Owner name" value={form.name} onChange={set('name')} placeholder="Ramesh Kumar" />
          <Input
            label="Email (their user id)"
            type="email"
            value={form.email}
            onChange={set('email')}
            hint="What the owner signs in with."
          />
          <Input label="Phone" value={form.phone} onChange={set('phone')} placeholder="9876543210" />
          <Input
            label="Password"
            type="text"
            value={form.password}
            onChange={set('password')}
            hint="Shown in the clear — you have to read it out to them."
          />
          <Input label="City" value={form.city} onChange={set('city')} />
          <Input label="State" value={form.state} onChange={set('state')} placeholder="Odisha" />
        </div>

        {/*
          ── what only this product asks for ──────────────────────────────────

          Split out rather than mixed into the grid above, because the two lists
          have nothing in common: a haulage company buys a tier, and a practice
          opens a branch that holds a licence. Showing both and disabling half
          would suggest the other half exists somewhere.
        */}
        {!clinic && (
          <div className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-300">
              Subscription
            </h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
              What they bought. The limits on users, vehicles and trips follow from it, and it can
              be changed later from the customer's own row.
            </p>
            <select
              className="field mt-2"
              value={form.plan}
              onChange={(event) => setForm((current) => ({ ...current, plan: event.target.value }))}
            >
              <option value="">Trial (the server default)</option>
              {plans.map((option) => (
                <option key={option} value={option}>
                  {roleLabel(option)}
                </option>
              ))}
            </select>
          </div>
        )}

        {clinic && (
          <div className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-300">
                Clinics ({rows.length})
              </h3>
              <Input
                label="Licence expires"
                type="date"
                value={form.expiresAt}
                onChange={set('expiresAt')}
                hint="Applies to every clinic here. Blank never lapses."
              />
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
              A practice needs at least one clinic to be bookable. Add all of them here rather than
              one at a time — each gets its own address, its own public page and its own API key.
            </p>

            <div className="mt-3 space-y-3">
              {rows.map((row, index) => (
                <div
                  key={index}
                  className="rounded-xl border border-white/10 bg-slate-900/30 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-slate-300">
                      {index === 0 ? 'Head office' : `Clinic ${index + 1}`}
                    </span>
                    {/* The first is not removable: something has to be created,
                        and a form that can reach zero then fails on submit. */}
                    {rows.length > 1 && (
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                  <BranchFields
                    value={row}
                    onChange={(next) =>
                      setRows((current) => current.map((r, i) => (i === index ? next : r)))
                    }
                    creating
                  />
                </div>
              ))}
            </div>

            <Button
              variant="outline"
              type="button"
              className="mt-3"
              onClick={() => setRows((current) => [...current, { ...BLANK_BRANCH }])}
            >
              + Add another clinic
            </Button>
          </div>
        )}
      </form>
    </Modal>
  )
}

/* ────────────────────────────────────── a login, new or existing ── */

function AccountForm({
  product,
  tenant,
  account,
  catalogue,
  onClose,
  onDone,
}: {
  product: Product
  tenant?: Tenant
  account?: PlatformAccount
  catalogue: ProductCatalogue | null
  onClose: () => void
  onDone: () => void
}) {
  const editingExisting = !!account
  const owner = account ? isPlatformOwner(account) : false
  const staffRoles = catalogue?.staffRoles ?? []
  /*
   * MyClinic's access control is a scope, not a permission list: which branches
   * this login may open. An owner is outside it entirely — see below.
   */
  const scoped = product.module === 'clinic' && !owner

  const [form, setForm] = useState({
    name: account?.name ?? '',
    email: account?.email ?? '',
    phone: account?.phone ?? '',
    password: '',
    role: account?.role ?? staffRoles[0] ?? '',
    isActive: account ? account.isActive : true,
  })
  const [busy, setBusy] = useState<'' | 'save' | 'delete'>('')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  /* ── which branches this login may open (MyClinic only) ── */
  const tenantId = tenant?.id ?? (account ? tenantIdOf(account) : '')
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [branchError, setBranchError] = useState('')
  const [chosen, setChosen] = useState<string[]>(account?.clinicIds ?? [])
  const [newBranch, setNewBranch] = useState<Required<BranchDetails>>(BLANK_BRANCH)
  const [showAddBranch, setShowAddBranch] = useState(false)
  const [addingBranch, setAddingBranch] = useState(false)
  const [issuedKey, setIssuedKey] = useState<{ name: string; apiKey: string } | null>(null)

  useEffect(() => {
    if (!scoped || !tenantId) return
    let live = true
    setBranchError('')
    listBranches(product, tenantId)
      .then((list) => {
        if (!live) return
        setBranches(list)
        /*
         * A NEW login defaults to every branch the practice has. The server
         * would do the same with no list at all, and matching it here means the
         * ticks show what is about to happen rather than the form looking like
         * nothing was chosen.
         */
        if (!account) setChosen(list.map((b) => b.id))
      })
      .catch((caught) => {
        if (!live) return
        setBranches([])
        setBranchError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      })
    return () => {
      live = false
    }
  }, [scoped, tenantId, product, account])

  const toggleBranch = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((b) => b !== id) : [...current, id],
    )

  const addBranch = async () => {
    const name = newBranch.name.trim()
    if (!name || !tenantId) return
    setBranchError('')
    setAddingBranch(true)
    try {
      /*
       * Blanks are dropped rather than sent as empty strings. On this endpoint
       * an absent field means "inherit from the practice" and `""` means
       * "deliberately empty", so posting the whole form would give a branch a
       * blank phone number instead of the practice's.
       */
      const details: BranchDetails & { name: string } = { name }
      if (newBranch.phone.trim()) details.phone = newBranch.phone.trim()
      if (newBranch.email.trim()) details.email = newBranch.email.trim()
      if (newBranch.address.trim()) details.address = newBranch.address.trim()
      if (newBranch.city.trim()) details.city = newBranch.city.trim()
      if (newBranch.state.trim()) details.state = newBranch.state.trim()
      if (newBranch.timezone.trim()) details.timezone = newBranch.timezone.trim()
      details.bookingEnabled = newBranch.bookingEnabled

      const { branch, apiKey } = await createBranch(product, tenantId, details)
      setBranches((current) => [...(current ?? []), branch])
      /* Ticked straight away: somebody adding a branch from inside this form is
         adding it *for this person*, and making them tick it again is a step
         that exists only because the code did not think of it. */
      setChosen((current) => [...current, branch.id])
      setNewBranch(BLANK_BRANCH)
      setShowAddBranch(false)
      setIssuedKey({ name: branch.name, apiKey })
    } catch (caught) {
      setBranchError(caught instanceof ApiError ? caught.message : (caught as Error).message)
    } finally {
      setAddingBranch(false)
    }
  }

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }))

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy('save')
    try {
      if (account) {
        await updatePlatformAccount(product, account.id, {
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          /* An owner's role is refused by the server, so it is not offered here. */
          ...(owner ? {} : { role: form.role }),
          isActive: form.isActive,
          ...(form.password ? { password: form.password } : {}),
          /* Never for an owner: an empty list is what gives them every branch,
             and naming today's would cut them out of tomorrow's. */
          ...(scoped ? { clinicIds: chosen } : {}),
        })
      } else if (tenant) {
        await createPlatformAccount(product, {
          tenantId: tenant.id,
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          phone: form.phone.trim(),
          role: form.role,
          ...(scoped ? { clinicIds: chosen } : {}),
        })
      }
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      setBusy('')
    }
  }

  const remove = async () => {
    if (!account) return
    setError('')
    setBusy('delete')
    try {
      await deletePlatformAccount(product, account.id)
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      setBusy('')
    }
  }

  return (
    <Modal
      open
      title={
        editingExisting
          ? `${account?.name} · ${roleLabel(account?.role ?? '')}`
          : `New ${product.staffLabel.toLowerCase()} · ${tenant?.name}`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            form="account-form"
            type="submit"
            loading={busy === 'save'}
            disabled={
              !form.name ||
              !form.email ||
              (!editingExisting && !form.password) ||
              /* A clinic sub-login with no branch can sign in and open nothing.
                 The server refuses it; refusing it here says so before they type
                 a password they then have to type again. */
              (scoped && chosen.length === 0)
            }
          >
            {editingExisting ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="account-form" onSubmit={save} className="space-y-3">
        {error && <Notice tone="danger">{error}</Notice>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" value={form.name} onChange={set('name')} />
          <Input label="Email (their user id)" type="email" value={form.email} onChange={set('email')} />
          <Input label="Phone" value={form.phone} onChange={set('phone')} />
          <div>
            <label className="label" htmlFor="platform-role">
              Role
            </label>
            {owner ? (
              /*
               * An owner's role is not editable, and the field says why rather
               * than being greyed out with no explanation. Demoting the only
               * owner leaves the customer with nobody who can grant anything —
               * including nobody who can undo it.
               */
              <p className="field text-slate-400">Owner — cannot be changed</p>
            ) : (
              <select
                id="platform-role"
                className="field"
                value={form.role}
                onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
              >
                {staffRoles.length === 0 && <option value="">(roles unavailable)</option>}
                {staffRoles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <Input
            label={editingExisting ? 'New password' : 'Password'}
            type="text"
            value={form.password}
            onChange={set('password')}
            className="sm:col-span-2"
            placeholder={editingExisting ? 'Leave blank to keep the current one' : ''}
            hint={
              editingExisting
                ? 'Changing it signs this login out of every device immediately.'
                : 'Shown in the clear — you have to read it out to them.'
            }
          />
        </div>

        {/*
          ── MyClinic: which branches this login may open ──────────────────────

          The practice's owner is not in here on purpose. Their reach over every
          branch is expressed by an EMPTY scope, so a tick list for an owner
          would be a list that has to be revisited every time a branch opens —
          and would silently lock them out of the one nobody remembered to tick.
          So the owner gets a statement of fact, and everyone else gets a choice.
        */}
        {product.module === 'clinic' && (
          <div className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-300">
              Clinic access
            </h3>

            {owner ? (
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
                <span className="font-semibold text-slate-200">Every clinic in this practice</span>,
                including any opened later. An owner is not pinned to a branch list — that is what
                lets them read across all of them, and it is why there is nothing to tick here.
              </p>
            ) : (
              <>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
                  Tick the clinics this person may open. Anything else is invisible to them — not
                  refused with a warning, simply not there.
                </p>

                {branchError && (
                  <div className="mt-2">
                    <Notice tone="warning">{branchError}</Notice>
                  </div>
                )}

                {branches === null ? (
                  <p className="mt-2 text-[12.5px] text-slate-500">Loading clinics…</p>
                ) : branches.length === 0 ? (
                  <p className="mt-2 text-[12.5px] text-amber-300">
                    This practice has no clinics yet. Add one below — a login with no clinic can
                    sign in and reach nothing.
                  </p>
                ) : (
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {branches.map((branch) => (
                      <label
                        key={branch.id}
                        className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/40 px-2.5 py-2"
                      >
                        <input
                          type="checkbox"
                          checked={chosen.includes(branch.id)}
                          onChange={() => toggleBranch(branch.id)}
                          className="h-4 w-4 accent-sky-500"
                        />
                        <span className="min-w-0 text-[13px]">
                          <span className="block truncate font-semibold text-slate-200">
                            {branch.name}
                          </span>
                          <span className="block text-[11.5px] text-slate-500">{branch.code}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {branches !== null && chosen.length === 0 && (
                  <p className="mt-2 text-[12.5px] font-semibold text-rose-300">
                    Pick at least one clinic.
                  </p>
                )}

                {/* Opening a branch from here, because the moment somebody
                    discovers the branch is missing is the moment they are
                    filling this form in. */}
                <div className="mt-3 border-t border-white/10 pt-3">
                  {showAddBranch ? (
                    <>
                      <h4 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-slate-300">
                        New clinic
                      </h4>
                      <BranchFields value={newBranch} onChange={setNewBranch} creating />
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          type="button"
                          loading={addingBranch}
                          disabled={!newBranch.name.trim()}
                          onClick={() => void addBranch()}
                        >
                          Create clinic
                        </Button>
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => {
                            setShowAddBranch(false)
                            setNewBranch(BLANK_BRANCH)
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button variant="ghost" type="button" onClick={() => setShowAddBranch(true)}>
                      + Add a clinic
                    </Button>
                  )}
                </div>

                {/* Shown once and never again — the server keeps only a hash. */}
                {issuedKey && (
                  <div className="mt-2">
                    <Notice tone="warning">
                      <strong className="font-bold">{issuedKey.name} — API key</strong>
                      <span className="mt-1 block break-all font-mono text-[12px] text-slate-200">
                        {issuedKey.apiKey}
                      </span>
                      <span className="mt-1 block text-[12px]">
                        Copy it now. Only a hash is stored, so this cannot be shown again — a lost
                        key has to be rotated, not recovered.
                      </span>
                    </Notice>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {editingExisting && (
          <label className="flex items-start gap-2 rounded-xl border border-white/10 bg-slate-950/30 px-3 py-2.5">
            <input
              type="checkbox"
              checked={!form.isActive}
              onChange={(event) => setForm((current) => ({ ...current, isActive: !event.target.checked }))}
              className="mt-0.5 h-4 w-4 accent-rose-500"
            />
            <span className="text-[13px] leading-relaxed">
              <span className="font-semibold text-slate-200">Suspend this login</span>
              <span className="block text-[12px] text-slate-400">
                They stop being able to sign in, and every device they are already signed in on is
                signed out at once. The account and its history stay.
              </span>
            </span>
          </label>
        )}

        {editingExisting && (
          <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.05] p-3">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-rose-300">Delete</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-400">
              Permanent. {owner
                ? `The server refuses this while the ${product.tenantLabel.toLowerCase()} still has other logins, and it never deletes the ${product.tenantLabel.toLowerCase()} itself.`
                : 'Suspending instead keeps their name readable on whatever they have already done.'}
            </p>
            {confirmDelete ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="danger" loading={busy === 'delete'} onClick={() => void remove()}>
                  Yes, delete
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </Button>
              </div>
            ) : (
              <Button variant="ghost" className="mt-2" onClick={() => setConfirmDelete(true)}>
                Delete this login
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  )
}

/* ──────────────────────────────────────── what they are paying for ── */

/**
 * The entitlement, per product — and an honest note about what is missing.
 *
 * Neither of these products has a payments ledger: no amount, no method, no
 * receipt, nothing to total. What they have is the thing the software enforces —
 * a plan, or a licence with an expiry — so that is what this edits, and the
 * dialog says plainly that money is recorded elsewhere rather than implying a
 * revenue figure exists somewhere off screen.
 */
function BillingDialog({
  product,
  tenant,
  onClose,
  onDone,
}: {
  product: Product
  tenant: Tenant
  onClose: () => void
  onDone: () => void
}) {
  const [billing, setBilling] = useState<Billing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState(tenant.plan ?? '')

  const load = useCallback(() => {
    fetchBilling(product, tenant.id)
      .then((next) => {
        setBilling(next)
        if (next.kind === 'plan') setPlan(next.plan)
      })
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : String(caught)))
  }, [product, tenant.id])

  useEffect(() => {
    load()
  }, [load])

  const savePlan = async () => {
    setBusy(true)
    setError('')
    try {
      await updateTenant(product, tenant.id, { plan })
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      setBusy(false)
    }
  }

  const saveLicence = async (clinicId: string, patch: { status?: string; expiresAt?: string | null }) => {
    setBusy(true)
    setError('')
    try {
      await updateTenant(product, tenant.id, { clinicId, ...patch })
      onDone()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal open wide title={`${tenant.name} · what they are paying for`} onClose={onClose}>
      <div className="space-y-3">
        {error && <Notice tone="danger">{error}</Notice>}

        <Notice tone="info">
          <strong className="font-bold">{product.label} records entitlement, not payments.</strong>{' '}
          There is no amount, tax or receipt on this backend — the money screens belong to MyStockio,
          which has a ledger. What is below is what the software actually enforces.
        </Notice>

        {!billing && !error && <p className="text-[13px] text-slate-400">Loading…</p>}

        {billing?.kind === 'plan' && (
          <div className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
            <label className="label" htmlFor="tenant-plan">
              Plan
            </label>
            <select
              id="tenant-plan"
              className="field"
              value={plan}
              onChange={(event) => setPlan(event.target.value)}
            >
              {billing.plans.map((option) => (
                <option key={option} value={option}>
                  {roleLabel(option)}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">
              The user, vehicle and trip limits are read from this on every request, so a change takes
              effect on their next one.
            </p>
            <ul className="mt-2 grid grid-cols-3 gap-2">
              {Object.entries(billing.limits).map(([key, value]) => (
                <li key={key} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                  <p className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500">{key}</p>
                  <p className="mt-0.5 text-[14px] font-semibold text-slate-100">
                    {value === null ? 'Unlimited' : value}
                  </p>
                </li>
              ))}
            </ul>
            <Button variant="primary" className="mt-3" loading={busy} onClick={() => void savePlan()}>
              Save plan
            </Button>
          </div>
        )}

        {billing?.kind === 'licences' && (
          <div className="space-y-2">
            {billing.clinics.length === 0 && (
              <p className="text-[13px] text-slate-400">This practice has no branches yet.</p>
            )}
            {billing.clinics.map((clinic) => (
              <div key={clinic.clinicId} className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13.5px] font-semibold text-slate-100">{clinic.name}</p>
                    <p className="text-[11.5px] text-slate-500">
                      {clinic.code}
                      {clinic.loginId && ` · ${clinic.loginId}`}
                    </p>
                  </div>
                  <Badge
                    tone={
                      clinic.status === 'active' ? 'success' : clinic.status === 'suspended' ? 'danger' : 'warning'
                    }
                  >
                    {clinic.status ?? 'no licence'}
                  </Badge>
                </div>

                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`exp-${clinic.clinicId}`}>
                      Expires
                    </label>
                    <input
                      id={`exp-${clinic.clinicId}`}
                      type="date"
                      className="field"
                      defaultValue={clinic.expiresAt ? String(clinic.expiresAt).slice(0, 10) : ''}
                      onBlur={(event) =>
                        void saveLicence(clinic.clinicId, {
                          /* An empty field is "does not lapse" — a real state here,
                           * and the one public signup creates. */
                          expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null,
                        })
                      }
                    />
                    <p className="mt-1 text-[11.5px] text-slate-500">Blank means it never lapses.</p>
                  </div>
                  <div>
                    <label className="label" htmlFor={`st-${clinic.clinicId}`}>
                      Status
                    </label>
                    <select
                      id={`st-${clinic.clinicId}`}
                      className="field"
                      value={clinic.status ?? 'active'}
                      disabled={busy}
                      onChange={(event) => void saveLicence(clinic.clinicId, { status: event.target.value })}
                    >
                      {['active', 'suspended', 'expired'].map((status) => (
                        <option key={status} value={status}>
                          {roleLabel(status)}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11.5px] text-slate-500">
                      Suspending signs that branch's console out immediately.
                    </p>
                  </div>
                </div>

                {/*
                  ── the clinic's own details ────────────────────────────────

                  Here rather than on a screen of its own because this is the
                  only place a branch is already listed, and because the reason
                  somebody opens this dialog — checking a branch — is the same
                  moment they notice its address is the head office's.

                  Until this existed a clinic's details were whatever signup
                  copied off the practice, permanently. The second branch of any
                  practice had the first one's city on its public page and there
                  was no endpoint that could change it.
                */}
                <BranchEditor
                  product={product}
                  clinicId={clinic.clinicId}
                  fallbackName={clinic.name}
                  /* The last clinic cannot go — a practice with none cannot be
                     booked into. Hidden rather than shown-and-refused, so the
                     one case that will always fail is not offered. */
                  canDelete={billing.clinics.length > 1}
                  onSaved={() => void load()}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

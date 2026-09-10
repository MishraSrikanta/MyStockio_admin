/**
 * The client for MyTransport's and MyClinic's admin API.
 *
 * A separate file from `api.ts` on purpose. That one talks to MyStockio, which
 * has shops, subscriptions and a payments ledger and authorises with a bearer
 * token from an administrator account. This one talks to a backend that has
 * companies or practices, no ledger at all, and authorises with a shared secret.
 * Folding them together would mean one module full of branches, each hedging
 * about which server it is currently addressing.
 *
 * What they DO share is the error envelope — `{ error: { code, message, details } }`
 * — so `ApiError` is reused rather than reinvented, and a screen can catch one
 * type whichever product it is showing.
 */

import { PLATFORM_ADMIN_SECRET } from './config'
import { ApiError } from './api'
import type { Product } from './products'

const TIMEOUT_MS = 30_000

/** A customer: a haulage company, or a clinic practice. */
export interface Tenant {
  id: string
  module: 'transport' | 'clinic'
  /** The company or the practice — what a person calls the customer. */
  name: string
  /** The human behind it. A practice stores one; a company does not. */
  contactName: string
  email: string
  phone: string
  city: string
  isActive: boolean
  createdAt?: string
  /** How many logins it has. */
  accounts: number
  /** Transport only: the tier its user and vehicle limits are read from. */
  plan?: string
}

/** A login. Owner or sub-login, on either product. */
export interface PlatformAccount {
  id: string
  module: 'transport' | 'clinic'
  name: string
  email: string
  phone: string
  role: string
  permissions: string[]
  isActive: boolean
  lastLoginAt?: string | null
  createdAt?: string
  /* transport */
  companyId?: string | null
  driverId?: string | null
  /* clinic */
  ownerId?: string | null
  loginId?: string | null
  clinicId?: string | null
  clinicIds?: string[]
}

export interface ProductCatalogue {
  module: string
  roles: string[]
  /** Roles a sub-login may be given — every role except `owner`. */
  staffRoles: string[]
  permissions: string[]
  /**
   * Subscription tiers, for the create-customer form. Empty on MyClinic, whose
   * entitlement is a per-branch licence rather than a tier on the practice.
   *
   * Optional because an older backend does not send it, and a form that throws
   * on a missing array is a worse failure than one that hides a dropdown.
   */
  plans?: string[]
}

/** What a customer is paying for, in the only terms each product actually models. */
export type Billing =
  | { kind: 'plan'; plan: string; plans: string[]; limits: Record<string, number | null> }
  | {
      kind: 'licences'
      clinics: {
        clinicId: string
        name: string
        code: string
        loginId: string | null
        status: string | null
        /** Null is a licence that does not lapse — not a missing date. */
        expiresAt: string | null
        issuedAt: string | null
      }[]
    }

/**
 * One request to a product's admin API.
 *
 * The secret goes in `x-admin-secret`, which that backend explicitly allows
 * through CORS — checked, because a header missing from `allowedHeaders` is one
 * the browser drops silently and the failure arrives as an inexplicable 401.
 */
async function request<T>(
  product: Product,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!PLATFORM_ADMIN_SECRET) {
    /*
     * Answered here rather than by sending a request that cannot succeed. The
     * server's own answer would be a 401 about an invalid secret, which reads as
     * "the secret is wrong" when the truth is that none was configured.
     */
    throw new ApiError(
      'No admin secret is set for this product. Fill in PLATFORM_ADMIN_SECRET in src/lib/config.ts — it has to match ADMIN_SECRET on that backend.',
      'NO_ADMIN_SECRET',
      0,
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const url = `${product.baseUrl}/api/v1/admin${path}`

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'x-admin-secret': PLATFORM_ADMIN_SECRET,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      /*
       * HTML from a proxy or a dev server, which means the request never reached
       * the API. Said plainly, because "Unexpected token <" sends people to look
       * at their JSON rather than at their URL.
       */
      throw new ApiError(
        `That address answered with something that is not JSON. Check that ${product.baseUrl} is this product's API and not a web page.`,
        'BAD_RESPONSE',
        response.status,
      )
    }

    if (!response.ok) {
      const shape = parsed as { error?: { code?: string; message?: string } } | undefined
      const nested = shape?.error
      /*
       * A 404 here usually is not a missing record: that backend does not mount
       * its admin routes at all unless ADMIN_SECRET is set, so an unconfigured
       * deployment answers 404 for every one of them.
       */
      if (response.status === 404 && !nested?.message) {
        throw new ApiError(
          `This backend has no admin API mounted. It only exposes these routes when ADMIN_SECRET is set in its environment.`,
          'NO_ADMIN_API',
          404,
        )
      }
      throw new ApiError(
        nested?.message ?? `The server returned ${response.status}.`,
        nested?.code ?? 'SERVER_ERROR',
        response.status,
      )
    }

    return parsed as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if ((error as Error).name === 'AbortError') {
      throw new ApiError('The server took too long to answer.', 'TIMEOUT', 0)
    }
    throw new ApiError(`Cannot reach ${product.baseUrl}. Check that it is running.`, 'NETWORK', 0)
  } finally {
    clearTimeout(timer)
  }
}

/** The `module` every route on that backend takes, as a query string. */
function mod(product: Product): string {
  return `module=${product.module ?? 'transport'}`
}

export async function listTenants(product: Product): Promise<Tenant[]> {
  const body = await request<{ tenants?: Tenant[] }>(product, 'GET', `/tenants?${mod(product)}`)
  return body.tenants ?? []
}

export async function listPlatformAccounts(product: Product, tenantId?: string): Promise<PlatformAccount[]> {
  const query = `${mod(product)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`
  const body = await request<{ accounts?: PlatformAccount[] }>(product, 'GET', `/accounts?${query}`)
  return body.accounts ?? []
}

export async function fetchCatalogue(product: Product): Promise<ProductCatalogue | null> {
  const body = await request<{ modules?: ProductCatalogue[] }>(product, 'GET', '/catalogue')
  return body.modules?.find((entry) => entry.module === (product.module ?? 'transport')) ?? null
}

export async function fetchBilling(product: Product, tenantId: string): Promise<Billing> {
  const body = await request<{ billing: Billing }>(
    product,
    'GET',
    `/tenants/${encodeURIComponent(tenantId)}?${mod(product)}`,
  )
  return body.billing
}

/**
 * A new customer, in the fields the chosen product's `POST /tenants` accepts.
 *
 * The five at the top are shared — every customer of every product has an owner
 * who signs in. Everything below is per module, and sending a field the other
 * module does not know is not harmless: the transport branch has no `address`
 * and the clinic branch has no `plan`, so a form that posts both writes one and
 * silently drops the other. The form sends only its own module's fields, which
 * is why they are grouped and labelled here.
 */
export interface NewTenant {
  name: string
  businessName: string
  email: string
  password: string
  phone?: string

  /* ── both ── */
  city?: string
  state?: string

  /* ── transport ── */
  /** Subscription tier. Omitted, the server takes the schema default (`trial`). */
  plan?: string

  /* ── clinic ── */
  /**
   * The clinics to open with the practice, each with its own details.
   *
   * A practice with four branches is created in one call rather than created
   * with one and then topped up three times — which is what it took before, and
   * which gave the three later ones the head office's address.
   *
   * Omitted entirely, the server creates one named after the practice: a
   * practice with no clinic cannot be booked into and cannot sync.
   */
  clinics?: (BranchDetails & { name: string })[]
  /** Superseded by `clinics`. Still accepted, and means a list of one. */
  clinicName?: string
  address?: string
  /** IANA name. Defaults to `Asia/Kolkata` on the server. */
  timezone?: string
  /** Whether patients may book this branch online. Defaults to true. */
  bookingEnabled?: boolean
  /** The first branch's licence expiry. Null, or omitted, is a licence that does not lapse. */
  expiresAt?: string | null
}

/**
 * A new customer and their owner login, in one call.
 *
 * For a clinic this also mints the first branch, its licence and its API key —
 * and that key comes back **once**. Nothing on that API will return it again, so
 * a caller that drops it has to rotate rather than re-read.
 */
export async function createTenant(
  product: Product,
  input: NewTenant,
): Promise<{
  tenant: Tenant
  account: PlatformAccount
  /** The first clinic's key. Kept for callers written before there could be several. */
  apiKey?: string
  /** One per clinic created — separate credentials for separate installations. */
  apiKeys?: { clinicName: string; code: string; apiKey: string }[]
  loginId?: string
}> {
  return request(product, 'POST', '/tenants', { module: product.module ?? 'transport', ...input })
}

export interface TenantChange {
  name?: string
  email?: string
  phone?: string
  city?: string
  /** transport */
  plan?: string
  /** clinic — all three address one branch, named by `clinicId`. */
  clinicId?: string
  status?: string
  expiresAt?: string | null
  note?: string
}

export async function updateTenant(product: Product, id: string, patch: TenantChange): Promise<Tenant> {
  const body = await request<{ tenant: Tenant }>(product, 'PATCH', `/tenants/${encodeURIComponent(id)}`, {
    module: product.module ?? 'transport',
    ...patch,
  })
  return body.tenant
}

export interface NewPlatformAccount {
  tenantId: string
  name: string
  email: string
  password: string
  phone?: string
  role: string
  permissions?: string[]
  /** clinic — which branches this login may open. */
  clinicIds?: string[]
}

export async function createPlatformAccount(
  product: Product,
  input: NewPlatformAccount,
): Promise<PlatformAccount> {
  const body = await request<{ account: PlatformAccount }>(product, 'POST', '/accounts', {
    module: product.module ?? 'transport',
    ...input,
  })
  return body.account
}

export interface PlatformAccountChange {
  name?: string
  email?: string
  phone?: string
  role?: string
  permissions?: string[]
  isActive?: boolean
  /** Sent only when it is being changed. Changing it ends every live session. */
  password?: string
  /**
   * clinic — the branches this login may open, replacing whatever it had.
   *
   * Never sent for an owner. An owner's reach over every branch is expressed by
   * an **empty** list, so naming branches on one would pin them to today's set
   * and quietly cut them out of the next branch the practice opens.
   */
  clinicIds?: string[]
}

export async function updatePlatformAccount(
  product: Product,
  id: string,
  patch: PlatformAccountChange,
): Promise<PlatformAccount> {
  const body = await request<{ account: PlatformAccount }>(
    product,
    'PATCH',
    `/accounts/${encodeURIComponent(id)}`,
    patch,
  )
  return body.account
}

export async function deletePlatformAccount(product: Product, id: string): Promise<void> {
  await request<unknown>(product, 'DELETE', `/accounts/${encodeURIComponent(id)}`)
}

/* ────────────────────────────────────────────── clinic branches ── */

/** One branch of a practice. */
export interface Branch {
  id: string
  name: string
  /** Prefixes the branch's login ids and numbered documents — what staff quote. */
  code: string
}

/**
 * A branch's own details, as opposed to the practice's.
 *
 * These exist as a separate shape because the two used to be the same thing: a
 * clinic was created with the owner's phone, email, city and state copied into
 * it. Fine for a practice with one branch, wrong for a practice with two — and
 * uncorrectable, because nothing could edit a clinic. Every field here is
 * optional, and an omitted one means "leave it as it is" on an edit and
 * "inherit from the practice" on a create.
 */
export interface BranchDetails {
  name?: string
  phone?: string
  email?: string
  address?: string
  city?: string
  state?: string
  /** IANA name. Appointment times are read in it, so it is not cosmetic. */
  timezone?: string
  /** Whether patients may book this branch from the public page. */
  bookingEnabled?: boolean
}

/**
 * The branches a practice has, for the checkboxes on a clinic sub-login.
 *
 * Read off `GET /tenants/:id` rather than a listing endpoint of its own: that
 * response already carries every branch with its licence, so a second call would
 * fetch the same rows twice and could disagree with the first.
 *
 * An empty list is a real answer — a practice created without a branch — and the
 * form has to say so, because "pick at least one" with nothing to pick is the
 * kind of dead end somebody stares at for a while.
 */
export async function listBranches(product: Product, tenantId: string): Promise<Branch[]> {
  const billing = await fetchBilling(product, tenantId)
  if (billing.kind !== 'licences') return []
  return billing.clinics.map((clinic) => ({
    id: clinic.clinicId,
    name: clinic.name,
    code: clinic.code,
  }))
}

/**
 * Opens another branch under an existing practice.
 *
 * `ownerId` is what keeps it under that practice. Left off, the server creates a
 * whole new practice to hang it from — correct for provisioning a customer from
 * nothing, and quietly wrong here, where it would strand the branch in a second
 * practice the owner cannot see.
 *
 * The API key is returned once and never again, so it is handed back to the
 * caller to show rather than dropped.
 */
export async function createBranch(
  product: Product,
  tenantId: string,
  details: BranchDetails & { name: string },
): Promise<{ branch: Branch; apiKey: string }> {
  const body = await request<{ clinic: { id: string; name: string; code: string }; apiKey: string }>(
    product,
    'POST',
    '/clinics',
    { ...details, ownerId: tenantId },
  )
  return {
    branch: { id: body.clinic.id, name: body.clinic.name, code: body.clinic.code },
    apiKey: body.apiKey,
  }
}

/**
 * Corrects a branch's own details.
 *
 * Only the fields sent are changed, which is why every one of them is optional:
 * a form that renders four boxes must not blank out the six it does not know
 * about.
 *
 * The code, the slug and the practice it belongs to are not editable and are not
 * in `BranchDetails`. The code prefixes every login id and numbered document the
 * branch has issued, and the slug is the public booking address printed on its
 * cards — changing either breaks something already in the world, so the server
 * refuses both.
 */
export async function updateBranch(
  product: Product,
  branchId: string,
  details: BranchDetails,
): Promise<Branch> {
  const body = await request<{ clinic: { id: string; name: string; code: string } }>(
    product,
    'PATCH',
    `/clinics/${encodeURIComponent(branchId)}`,
    details,
  )
  return { id: body.clinic.id, name: body.clinic.name, code: body.clinic.code }
}

/**
 * Removes a clinic, its licence and its slots.
 *
 * The server refuses three cases outright, and the message says which: the
 * practice's last clinic, a clinic with live bookings, and a clinic that is the
 * only one some login can open. `force` clears the second — the clinic has
 * genuinely closed and those appointments are being cancelled deliberately —
 * and clears neither of the others, because both would leave something broken
 * rather than merely empty.
 */
export async function deleteBranch(
  product: Product,
  branchId: string,
  options: { force?: boolean } = {},
): Promise<{ name: string; removed: { slots: number; liveBookings: number; loginsUnpinned: number } }> {
  const query = options.force ? '?force=true' : ''
  return request(product, 'DELETE', `/clinics/${encodeURIComponent(branchId)}${query}`)
}

/** One branch with everything the edit form needs pre-filled. */
export async function fetchBranch(
  product: Product,
  branchId: string,
): Promise<Branch & BranchDetails> {
  const body = await request<{ clinic: Branch & BranchDetails }>(
    product,
    'GET',
    `/clinics/${encodeURIComponent(branchId)}`,
  )
  return body.clinic
}

/** An owner answers to nobody; everyone else is a sub-login under one. */
export function isPlatformOwner(account: PlatformAccount): boolean {
  return account.role === 'owner'
}

/** The tenant a login belongs to, whichever product it is on. */
export function tenantIdOf(account: PlatformAccount): string {
  return String(account.ownerId ?? account.companyId ?? '')
}

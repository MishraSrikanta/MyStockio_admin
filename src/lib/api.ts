/**
 * The console's HTTP client.
 *
 * Two surfaces, and it is worth knowing which is which when something 404s:
 *
 *   · **Auth** (`api/v1/auth/*`) is the live one, shared with MyStockio. Creating an account here
 *     is a genuine signup through the same route the shop app uses, so a new customer can log
 *     into MyStockio immediately afterwards.
 *   · **Admin** (`api/v1/admin/*`) has to be added — see ADMIN-API-CONTRACT.md. Until it is,
 *     `server-reference/admin-server.mjs` implements it so this app can be used and tested.
 *
 * A 404 on an admin route is therefore reported as "this backend has no admin API yet" rather
 * than as a generic failure, because that is a completely different thing to fix.
 */

import { ADMIN_API_KEY, ADMIN_STORAGE, APIEndpoint, getApiUrl } from './config'
import type { Payment } from './revenue'
import type { AdminAccount } from './subscription'

const TIMEOUT_MS = 30_000

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** True when the failure means the backend simply has no admin surface yet. */
export function isMissingAdminApi(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'NO_ADMIN_API' || error.status === 404)
}

/**
 * The bearer token from sign-in, for this tab only.
 *
 * sessionStorage, not localStorage: closing the tab ends it. A console holding every customer's
 * details should not stay authorised indefinitely on a shared machine.
 */
export const token = {
  get(): string {
    try {
      return sessionStorage.getItem(ADMIN_STORAGE.token) ?? ''
    } catch {
      return ''
    }
  },
  set(value: string) {
    try {
      sessionStorage.setItem(ADMIN_STORAGE.token, value)
    } catch {
      /* private browsing — the token lives in memory for this tab only */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(ADMIN_STORAGE.token)
    } catch {
      /* ignore */
    }
  },
}

/**
 * What authorises an admin request.
 *
 * The token from signing in, which is what the live backend requires — and the only thing it will
 * take, since its CORS reply allows `Authorization` and `Content-Type` and nothing else.
 *
 * `X-Admin-Key` is a fallback for the bundled reference server, omitted entirely when empty. With
 * neither, the admin routes answer 401 and that is reported as exactly what it is.
 */
function adminHeaders(): Record<string, string> {
  const bearer = token.get()
  if (bearer) return { Authorization: `Bearer ${bearer}` }
  return ADMIN_API_KEY ? { 'X-Admin-Key': ADMIN_API_KEY } : {}
}

/**
 * Pulls a readable sentence out of an error body.
 *
 * Tolerant of both shapes the backend uses — a nested `{ error: { message } }` and a flat
 * `{ message }` — because reading only one turns a real sentence into "[object Object]" on
 * screen. That exact bug shipped in MyStockio; it is not repeated here.
 */
function messageFrom(body: unknown, status: number): { message: string; code: string } {
  const fallback = { message: `The server returned ${status}.`, code: 'SERVER_ERROR' }
  if (typeof body === 'string' && body.trim()) return { message: body.trim(), code: fallback.code }
  if (!body || typeof body !== 'object') return fallback

  const shape = body as {
    error?: { code?: string; message?: string; details?: unknown } | string
    message?: string
    detail?: string
  }
  const nested = typeof shape.error === 'object' && shape.error !== null ? shape.error : null

  const message =
    nested?.message ??
    (typeof shape.error === 'string' ? shape.error : undefined) ??
    shape.message ??
    shape.detail ??
    fallback.message

  return { message, code: nested?.code || fallback.code }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  endpoint: APIEndpoint | string,
  body?: unknown,
  options: { auth?: boolean } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const url = getApiUrl(endpoint)

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.auth !== false) Object.assign(headers, adminHeaders())

  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }

    if (!response.ok) {
      const { message, code } = messageFrom(parsed, response.status)
      /*
       * A 404 on an admin path almost always means the route is not built yet, not that a record
       * is missing — the routes below are all collection-level or carry an id this app just read.
       */
      if (response.status === 404 && String(endpoint).includes('admin')) {
        throw new ApiError(
          'This backend does not expose the admin API yet. See ADMIN-API-CONTRACT.md, or run the reference server with `npm run api`.',
          'NO_ADMIN_API',
          404,
        )
      }
      throw new ApiError(message, code, response.status)
    }

    return parsed as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if ((error as Error).name === 'AbortError') {
      throw new ApiError('The server took too long to answer.', 'TIMEOUT', 0)
    }
    throw new ApiError(
      `Cannot reach the server at ${url}. Check that it is running.`,
      'NETWORK',
      0,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** What the login and signup routes answer with. */
interface AuthResponse {
  accessToken?: string
  token?: string
  account?: AdminAccount
}

/* ─────────────────────────────────────────────────────────── the session ── */

/**
 * Signs in. **The server decides**, and nothing in this app second-guesses it.
 *
 * There is no list of credentials in the bundle any more — no local comparison, no compiled-in
 * password, nothing to read out of the JavaScript. Whatever is typed goes to
 * `POST api/v1/admin/login`, and the answer is the answer: a token means an administrator, a 401
 * means those credentials are wrong, a 403 means the account is real but is not an administrator.
 *
 * That is a plain improvement on what was here before, in the way that matters most: a password
 * that only the server knows cannot be extracted from a page anyone can load.
 */
export async function signIn(email: string, password: string): Promise<AdminAccount | null> {
  const response = await request<AuthResponse>(
    'POST',
    APIEndpoint.ADMIN_LOGIN,
    { email: email.trim().toLowerCase(), password },
    { auth: false },
  )

  const bearer = response.accessToken ?? response.token ?? ''
  /*
   * A 200 with no token is not a success. Treated as one, the console would open and then 401 on
   * every request, which reads as a broken app rather than a backend returning the wrong shape.
   */
  if (!bearer) throw new ApiError('That sign-in returned no token.', 'NO_TOKEN', 0)

  token.set(bearer)
  return response.account ?? null
}

export function closeSession() {
  token.clear()
}

/* ─────────────────────────────────────────────────────────────── accounts ── */

interface AccountsResponse {
  accounts?: AdminAccount[]
  data?: AdminAccount[]
}

/** Every account. Tolerates both `{accounts}` and `{data}`, and a bare array. */
export async function listAccounts(): Promise<AdminAccount[]> {
  const body = await request<AccountsResponse | AdminAccount[]>('GET', APIEndpoint.ADMIN_ACCOUNTS)
  if (Array.isArray(body)) return body
  return body.accounts ?? body.data ?? []
}

export interface CreateAccountInput {
  name: string
  email: string
  password: string
  phone?: string
  shopName?: string
  plan?: string
  /** The invite gate MyStockio's own signup form sends. */
  developerCode?: string
  /**
   * What they do in the shop — a `Role` value. Absent means owner, so a caller that predates roles
   * keeps creating owners exactly as before.
   */
  shopRole?: string
  /**
   * The owner this login belongs to, **required for every role except owner**.
   *
   * An email rather than an id, because it is what a person knows and can check. The server resolves
   * it to an `ownerId` and is the authority on whether it exists and is really an owner — resolving
   * it here and posting an id would let a stale list attach somebody to the wrong shop.
   */
  ownerEmail?: string
}

/**
 * Creates a customer account through the **ordinary signup route**.
 *
 * Genuinely the same endpoint the shop app uses, which is what makes this work against the real
 * backend today with nothing added. The consequence worth knowing: the server sets the
 * subscription from `plan`, and it computes the dates itself — an expiry cannot be posted here,
 * by design, so a lifetime licence must be granted with `plan: 'lifetime'` rather than a date far
 * in the future.
 */
export async function createAccount(input: CreateAccountInput): Promise<AdminAccount> {
  const response = await request<AuthResponse>(
    'POST',
    APIEndpoint.REGISTER,
    {
      name: input.name,
      email: input.email,
      password: input.password,
      ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}),
      ...(input.shopName?.trim() ? { shopName: input.shopName.trim() } : {}),
      /*
       * `plan` is sent for an owner only. Staff ride on their owner's licence, so posting a plan
       * with one would ask the server to issue a second subscription for a login that must never
       * have one of its own — and the money screen would then count a cashier as a paying customer.
       */
      ...(input.shopRole && input.shopRole !== 'owner' ? {} : { plan: input.plan || '1year' }),
      ...(input.developerCode ? { developerCode: input.developerCode } : {}),
      ...(input.shopRole ? { shopRole: input.shopRole } : {}),
      ...(input.ownerEmail?.trim() ? { ownerEmail: input.ownerEmail.trim().toLowerCase() } : {}),
    },
    /*
     * Without the admin key. Registration is a public route that needs no privilege, and sending
     * the key to an endpoint that does not require it widens where it can leak for no gain.
     */
    { auth: false },
  )
  return response.account ?? ({ id: '', email: input.email } as AdminAccount)
}

export interface UpdateAccountInput {
  email?: string
  name?: string
  phone?: string
  shopName?: string
  /** Sent only when it is being changed. The server hashes it. */
  password?: string
  plan?: string
  /**
   * Change what somebody does. The server refuses the two changes that would break the shape:
   * promoting a staff member to owner while they still point at one, and demoting an owner who still
   * has staff of their own.
   */
  shopRole?: string
  /** Move a staff member to a different owner. */
  ownerEmail?: string
}

/** Amends one account. Only the fields present are changed. */
export async function updateAccount(id: string, patch: UpdateAccountInput): Promise<AdminAccount> {
  const body = await request<{ account?: AdminAccount }>(
    'PATCH',
    `${APIEndpoint.ADMIN_ACCOUNT}/${encodeURIComponent(id)}`,
    patch,
  )
  return body.account ?? ({ id, ...patch } as AdminAccount)
}

/** Removes an account for good. */
export async function deleteAccount(id: string): Promise<void> {
  await request<unknown>('DELETE', `${APIEndpoint.ADMIN_ACCOUNT}/${encodeURIComponent(id)}`)
}

/* ─────────────────────────────────────────────────────────────── payments ── */

export interface PaymentInput {
  accountId: string
  /** Always positive, refunds included. `type` carries the direction. */
  amount: number
  /** What was bought. The server extends the subscription from it — except on a refund. */
  plan: string
  method?: 'cash' | 'upi' | 'bank' | 'card' | 'other'
  reference?: string
  note?: string
  /** Omitted means `payment`, which is what a backend that predates refunds will assume. */
  type?: 'payment' | 'refund'
}

/**
 * Records a payment, which also renews the subscription.
 *
 * One call, not two, and that is deliberate: money received and time granted are the same event,
 * and splitting them across two requests means a network failure between them leaves a shop that
 * has paid and not been credited. The server decides the new expiry — see the contract — so the
 * two can never disagree.
 */
export async function recordPayment(input: PaymentInput): Promise<AdminAccount> {
  const body = await request<{ account?: AdminAccount }>('POST', APIEndpoint.ADMIN_PAYMENTS, {
    ...input,
    type: input.type ?? 'payment',
  })
  return body.account ?? ({ id: input.accountId } as AdminAccount)
}

/**
 * Records money going back out.
 *
 * The same endpoint and the same ledger as a payment, with `type: 'refund'` — one history, read in
 * date order, rather than a second table that has to be joined to make sense of a month.
 *
 * **It does not shorten the subscription**, by design. Refunding a licence and revoking it are
 * different decisions: a goodwill refund often leaves the shop running to the end of the term it
 * paid for. Cutting the term short is an amendment to the account, made deliberately and visibly.
 */
export async function recordRefund(input: PaymentInput): Promise<AdminAccount> {
  return recordPayment({ ...input, type: 'refund' })
}

interface PaymentsResponse {
  payments?: Payment[]
  data?: Payment[]
}

/**
 * The money ledger — every payment and refund, newest first.
 *
 * Pass an `accountId` for one shop's history; omit it for the whole book, which is what the
 * dashboard and the GST report are built from. Tolerates `{payments}`, `{data}` and a bare array,
 * for the same reason `listAccounts` does.
 */
export async function listPayments(accountId?: string): Promise<Payment[]> {
  const path = accountId
    ? `${APIEndpoint.ADMIN_PAYMENTS}?accountId=${encodeURIComponent(accountId)}`
    : APIEndpoint.ADMIN_PAYMENTS
  const body = await request<PaymentsResponse | Payment[]>('GET', path)
  const lines = Array.isArray(body) ? body : body.payments ?? body.data ?? []
  return [...lines].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Where the backend is, and every endpoint this console calls.
 *
 * Same arrangement as MyStockio's `src/api/config.ts`: the bases are compiled in, there is no
 * runtime setting and no UI for one, so a machine cannot be pointed at the wrong server by
 * accident. Change a constant and rebuild.
 */

/** Deployed backend. This is what a production build uses. */
// const PROD_BASE = 'http://localhost:5000/'
// /** Local backend, used by `vite dev`. */
// const DEV_BASE = 'http://localhost:5000/'


const PROD_BASE = "https://financegpt-backend-phm6.onrender.com/";
const DEV_BASE = "https://financegpt-backend-phm6.onrender.com/";

/**
 * Resolves the environment:
 *  - dev  → DEV_BASE
 *  - prod → PROD_BASE
 *
 * `vite dev` sets `import.meta.env.DEV`, and a build is prod. Override either with `VITE_API_ENV`,
 * which is the only reason this is a function rather than a constant — it lets one build be pointed
 * at a staging server without editing the source.
 */
export function getEnv(): 'dev' | 'prod' {
  const explicit = import.meta.env.VITE_API_ENV as string | undefined
  if (explicit === 'dev') return 'dev'
  if (explicit === 'prod') return 'prod'
  return import.meta.env.DEV ? 'dev' : 'prod'
}

/** Backend base URL, always with a trailing slash. */
export function apiBase(): string {
  const override = import.meta.env.VITE_API_BASE_URL as string | undefined
  if (override) return override.endsWith('/') ? override : `${override}/`
  const base = getEnv() === 'dev' ? DEV_BASE : PROD_BASE
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * Every endpoint, in two groups.
 *
 * **Shared with MyStockio** — the ordinary auth routes. Account creation genuinely goes through the
 * same `register` the shop app's signup used, which is what let this console create customers
 * before the admin API existed.
 *
 * **Admin** — the console's own surface. All of these require an administrator; a shop's own token
 * must be refused with 403, which is the only thing standing between one customer and every other
 * customer's details. Every failure is `{ error: { code, message, details } }`, and any unmatched
 * `/api/v1/admin/*` path is a 404 rather than a 401 — a typo that looks like a permissions problem
 * is an afternoon spent on the wrong question.
 */
export enum APIEndpoint {
  /* ── shared with MyStockio ───────────────────────────────────────────────── */
  /** Creating a customer. The server sets the subscription from `plan`. */
  REGISTER = 'api/v1/auth/register',
  /** A customer's own sign-in. Not used to authorise this console. */
  LOGIN = 'api/v1/auth/login',
  ME = 'api/v1/auth/me',

  /* ── admin ──────────────────────────────────────────────────────────────── */
  /**
   * POST · public · 200 `{ accessToken, account }`. Refuses a shop account with 403.
   *
   * Sent the email and password typed on the login screen. **This is the sign-in** — the console
   * holds no credentials of its own, so the server's answer decides whether it opens at all.
   */
  ADMIN_LOGIN = 'api/v1/admin/login',
  /**
   * GET · admin · 200 `{ accounts[], total }` — customers only, newest first, unpaged.
   *
   * Owners and staff both, with `shopRole` and `ownerId` on each, so one request builds the whole
   * tree. Optional `?ownerId=` for one owner's staff and `?shopRole=` for one kind of login.
   */
  ADMIN_ACCOUNTS = 'api/v1/admin/accounts',
  /**
   * One account. Append `/{id}`.
   *
   * · GET · 200 `{ account }`
   * · PATCH · 200 `{ account }` — email / name / phone / shopName / password / plan.
   *   400 on a blank email, 409 when it is taken, and `plan` re-issues the subscription from today
   *   rather than extending it (a correction, not a purchase).
   * · DELETE · 200 `{ deleted: true, id }` — drops the payments too. 403 on an administrator,
   *   404 the second time.
   */
  ADMIN_ACCOUNT = 'api/v1/admin/accounts',
  /**
   * Payments.
   *
   * · POST · 201 `{ account, payment }` — money and extension in one call, so a network failure
   *   between them cannot leave a shop that has paid and not been credited. 400 on an amount of
   *   zero or less or an unknown plan; 404 on an unknown account.
   * · GET `?accountId=` · 200 `{ payments[], total }` — newest first. Omit `accountId` for all.
   */
  ADMIN_PAYMENTS = 'api/v1/admin/payments',
}

export function getApiUrl(endpoint: APIEndpoint | string): string {
  return apiBase() + String(endpoint).replace(/^\/+/, '')
}

/**
 * Where the console's own session is kept. Deliberately not the keys the shop apps use.
 *
 * sessionStorage, not localStorage: closing the tab signs you out. A console holding every
 * customer's details should not stay signed in indefinitely on a shared machine.
 */
export const ADMIN_STORAGE = {
  /** The bearer token the admin API requires, from `api/v1/admin/login`. */
  token: 'mystockio.admin.token',
  /** Who is signed in, for the header — and for surviving a page refresh. */
  who: 'mystockio.admin.who',
} as const

/**
 * An optional shared key, sent as `X-Admin-Key` when there is no bearer token.
 *
 * **Empty is right for the real backend**, and not only out of caution: its CORS reply allows
 * `Authorization` and `Content-Type` and nothing else, so a browser refuses to send this header and
 * the request fails at the preflight rather than being authorised.
 *
 * It stays supported for the bundled reference server (`npm run api`), which accepts it — that is
 * what makes the console usable against a backend with no administrator seeded yet. Set it to that
 * server's `ADMIN_API_KEY`, normally `change-me-before-deploying`.
 *
 * **Nothing else in this app holds a credential.** Sign-in is the server's decision now; there is no
 * password compiled into the bundle to read out of it.
 */
export const ADMIN_API_KEY = ''

export const PLANS = [
  { value: '1year', label: '1 year', note: 'Renews annually' },
  { value: '2year', label: '2 years', note: 'Two years from today' },
  { value: 'lifetime', label: 'Lifetime', note: 'Never expires' },
] as const

export const DEFAULT_PLAN = '1year'

/** What a renewal costs, so a payment can be pre-filled rather than typed from memory. */
export const PLAN_PRICE: Record<string, number> = {
  '1year': 3000,
  '2year': 5000,
  lifetime: 12000,
}

/* ─────────────────────────────────────────────────────────────────── money ── */

/** GST, as a fraction. 18% is the rate for software licences (SAC 9973). */
export const GST_RATE = 0.18

/**
 * Whether `PLAN_PRICE` and the amounts recorded against payments already contain the GST.
 *
 * **`true` — the prices above are what the customer pays in total.** ₹3,000 is ₹2,542.37 of value
 * plus ₹457.63 of tax, not ₹3,000 plus ₹540. This is the single most consequential constant in the
 * app: read the wrong way it overstates revenue by 18% and understates what is owed, on a screen
 * whose numbers go onto a return. Change it only if the price list itself is quoted before tax.
 */
export const GST_INCLUSIVE = true

/**
 * Running costs for one month, in rupees — hosting, domains, the API bills, anything the licence
 * revenue has to cover.
 *
 * **Zero means "not configured", and the dashboard says so** rather than showing revenue as profit.
 * That is deliberate: profit is revenue minus costs, and with no costs entered the honest answer is
 * that the cost side is unknown, not that everything collected was kept. Put a real figure here and
 * the profit, margin and loss figures start meaning something.
 */
export const MONTHLY_COSTS = 0

/**
 * Whose name goes on the GST report.
 *
 * Printed at the top of the revenue report, which is the one thing here that leaves the building.
 * **`gstin` is left blank on purpose** — a made-up GST number on a document that looks like a tax
 * summary is worse than an obviously missing one, so the report prints a visible placeholder until
 * it is filled in.
 */
export const BUSINESS = {
  name: 'MyStockio',
  /** e.g. '21ABCDE1234F1Z5'. Blank until the real one is entered. */
  gstin: '',
  address: '',
  /** Place of supply, for the report header. */
  state: 'Odisha',
} as const

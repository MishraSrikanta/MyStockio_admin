/**
 * Reading a subscription: how long is left, and what to do about it.
 *
 * This is the arithmetic the whole console rests on. Every screen asks the same questions of an
 * account — is it live, when does it lapse, is it a lifetime one, should somebody be chased — so
 * the answers are computed here once rather than re-derived per view. Pure functions only, no
 * React and no network, so the edge cases can be asserted instead of hoped for.
 *
 * ── Two rules worth stating up front ────────────────────────────────────────────
 *
 * **A lifetime account has no expiry, and that is not the same as an expired one.** The server
 * sends `expiresAt: null` for lifetime. Treating a missing date as "expired" would show every
 * lifetime customer in the chase-up list, which is the fastest way to lose one.
 *
 * **Days remaining are counted in whole calendar days, not 24-hour blocks.** A shop whose licence
 * ends at 23:00 tonight has "today" left, not "0.04 days". Everyone involved talks in days, so
 * the boundary is midnight, and the count is what a person would say out loud.
 */

/** Plans the server issues. `lifetime` is the one with no end date. */
export type PlanId = '1year' | '2year' | 'lifetime'

export interface Subscription {
  plan?: string
  status?: string
  startedAt?: string
  /** ISO date, or null/absent for lifetime. */
  expiresAt?: string | null
}

export interface AdminAccount {
  id: string
  email: string
  name?: string
  phone?: string
  shopName?: string
  /**
   * **Platform privilege**, not a job title: `admin` for an ordinary account, `superadmin` for one
   * that may open the admin API. This is the field the server authorises against — `lib/roles.ts`
   * explains why the shop job title is deliberately a different field.
   */
  role?: string
  /** What they do in the shop — `Role` in `lib/roles.ts`. Absent means owner. */
  shopRole?: string | null
  /** The owner this login belongs to. `null` on an owner. */
  ownerId?: string | null
  /**
   * Which edition they are on — `SoftwareType` in `lib/software.ts`. Absent reads as MyStockio,
   * since every account older than the field is on it. On a staff account this is the owner's.
   */
  softwareType?: string | null
  /** The owner's email, as given when the login was created. Kept for display. */
  ownerEmail?: string | null
  subscription?: Subscription
  createdAt?: string
  /** Set by the admin API when a payment has been recorded. */
  lastPaymentAt?: string | null
  lastPaymentAmount?: number | null
}

/**
 * What state an account is in, in the order it matters to whoever is looking.
 *
 * `expiring` exists as its own state rather than as "active with a small number" because it is
 * the only one that implies an action — it is the list of people to message this week.
 */
export type SubscriptionState = 'lifetime' | 'active' | 'expiring' | 'expired' | 'unknown'

/** How many days before expiry an account starts appearing in the chase-up list. */
export const EXPIRING_SOON_DAYS = 30

/** Whole days each plan runs for. `lifetime` never ends, so it has no number. */
export const PLAN_DAYS: Record<Exclude<PlanId, 'lifetime'>, number> = {
  '1year': 365,
  '2year': 730,
}

export const PLAN_LABEL: Record<PlanId, string> = {
  '1year': '1 year',
  '2year': '2 years',
  lifetime: 'Lifetime',
}

export function isPlanId(value: unknown): value is PlanId {
  return value === '1year' || value === '2year' || value === 'lifetime'
}

/** A plan's label, falling back to whatever the server called it rather than hiding it. */
export function planLabel(plan: unknown): string {
  return isPlanId(plan) ? PLAN_LABEL[plan] : String(plan ?? '—')
}

/**
 * True when this account never expires.
 *
 * Decided by the plan first and the missing date second. A backend that sends `plan: 'lifetime'`
 * with some far-future date, or a date with no plan, still reads correctly — and neither is
 * mistaken for a lapsed account, which is the failure that would matter.
 */
export function isLifetime(account: AdminAccount | undefined): boolean {
  const sub = account?.subscription
  if (!sub) return false
  if (sub.plan === 'lifetime') return true
  /* A plan that is set but not lifetime, with no expiry, is missing data — not immortality. */
  return false
}

/** Start of the day, so day counting has a stable boundary. */
function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whole days from `now` until the expiry date. Negative once it has passed.
 *
 * Null for a lifetime account or a missing date — the caller must decide what that means rather
 * than being handed a number that looks comparable. Returning 0 or Infinity here is what leads to
 * a lifetime customer sorting into the "expired" bucket.
 */
export function daysLeft(account: AdminAccount | undefined, now: Date = new Date()): number | null {
  if (isLifetime(account)) return null
  const raw = account?.subscription?.expiresAt
  if (!raw) return null
  const expiry = new Date(raw)
  if (Number.isNaN(expiry.getTime())) return null
  return Math.round((startOfDay(expiry) - startOfDay(now)) / DAY_MS)
}

/**
 * The account's state.
 *
 * `unknown` is deliberate: an account with no subscription block at all is a data problem, and
 * showing it as expired would send a renewal message to somebody who may be paid up. It is
 * surfaced as its own thing so it can be looked at.
 */
export function subscriptionState(
  account: AdminAccount | undefined,
  now: Date = new Date(),
): SubscriptionState {
  if (isLifetime(account)) return 'lifetime'

  const left = daysLeft(account, now)
  if (left === null) return 'unknown'
  if (left < 0) return 'expired'
  if (left <= EXPIRING_SOON_DAYS) return 'expiring'
  return 'active'
}

/** Whether this account should be chased — expiring soon, or already lapsed. */
export function needsRenewal(account: AdminAccount | undefined, now: Date = new Date()): boolean {
  const state = subscriptionState(account, now)
  return state === 'expiring' || state === 'expired'
}

/** Time left as a person would say it: "Lifetime", "expired 3 days ago", "17 days left". */
export function describeTimeLeft(account: AdminAccount | undefined, now: Date = new Date()): string {
  if (isLifetime(account)) return 'Lifetime'

  const left = daysLeft(account, now)
  if (left === null) return 'No subscription data'
  if (left === 0) return 'Expires today'
  if (left < 0) {
    const ago = Math.abs(left)
    return `Expired ${ago} day${ago === 1 ? '' : 's'} ago`
  }
  if (left === 1) return '1 day left'
  if (left < 45) return `${left} days left`

  /* Beyond about six weeks, months read better than a three-digit day count. */
  const months = Math.round(left / 30)
  return `${months} month${months === 1 ? '' : 's'} left`
}

/** `2027-08-19T…` → `19 Aug 2027`. Empty for a lifetime or missing date. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/**
 * The expiry an account would have after paying for `plan`, as an ISO date.
 *
 * Extends from the current expiry when it is still in the future, and from today when it has
 * already lapsed. That is the fair reading of both cases: somebody renewing early does not
 * forfeit the days they have paid for, and somebody renewing two months late does not get two
 * months of credit for time the app was unusable to them.
 *
 * Returns null for lifetime, which has nothing to extend.
 */
export function expiryAfterRenewal(
  account: AdminAccount | undefined,
  plan: PlanId,
  now: Date = new Date(),
): string | null {
  if (plan === 'lifetime') return null

  const left = daysLeft(account, now)
  const from = left !== null && left > 0 ? new Date(account!.subscription!.expiresAt!) : now
  const next = new Date(from.getTime() + PLAN_DAYS[plan] * DAY_MS)
  return next.toISOString()
}

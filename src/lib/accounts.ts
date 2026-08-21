/**
 * Turning the account list into the views the console shows.
 *
 * Searching, filtering, sorting and the counters at the top. Pure, and separate from the table
 * that renders it, because "which accounts are expiring" is a question with a right answer that
 * should not depend on a component re-rendering.
 */

import { isStaff } from './roles'
import {
  type AdminAccount,
  type SubscriptionState,
  daysLeft,
  isLifetime,
  needsRenewal,
  subscriptionState,
} from './subscription'

export type AccountFilter = 'all' | 'active' | 'expiring' | 'expired' | 'lifetime' | 'needs-renewal' | 'staff'

export const FILTER_LABEL: Record<AccountFilter, string> = {
  all: 'All accounts',
  'needs-renewal': 'Needs renewal',
  expiring: 'Expiring soon',
  expired: 'Expired',
  active: 'Active',
  lifetime: 'Lifetime',
  staff: 'Staff logins',
}

/**
 * Matches an account against a typed query.
 *
 * Every field somebody might have to hand when a shop rings up: the shop name, the owner, the
 * email they log in with, the phone number, and the account id. Case- and space-insensitive on
 * the phone, because a number written `98765 43210` should be findable by typing it either way.
 */
export function matchesQuery(account: AdminAccount, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true

  const digitsOnly = needle.replace(/\D/g, '')
  if (digitsOnly.length >= 4) {
    const phone = String(account.phone ?? '').replace(/\D/g, '')
    if (phone.includes(digitsOnly)) return true
  }

  return [account.shopName, account.name, account.email, account.phone, account.id]
    .map((field) => String(field ?? '').toLowerCase())
    .some((field) => field.includes(needle))
}

export function matchesFilter(
  account: AdminAccount,
  filter: AccountFilter,
  now: Date = new Date(),
): boolean {
  if (filter === 'staff') return isStaff(account)
  if (filter === 'all') return true
  if (filter === 'needs-renewal') return needsRenewal(account, now)
  if (filter === 'lifetime') return isLifetime(account)
  return subscriptionState(account, now) === (filter as SubscriptionState)
}

/**
 * The order accounts are listed in: the most urgent first.
 *
 * Whoever opens this screen is usually here to chase somebody, so the default is "closest to
 * lapsing at the top", with the already-expired above the merely expiring — they have been down
 * longest. Lifetime and unknown sink to the bottom, since neither is ever an action.
 */
export function byUrgency(now: Date = new Date()) {
  return (a: AdminAccount, b: AdminAccount): number => {
    const rank = (account: AdminAccount) => {
      const state = subscriptionState(account, now)
      if (state === 'expired') return 0
      if (state === 'expiring') return 1
      if (state === 'active') return 2
      if (state === 'unknown') return 3
      return 4 /* lifetime */
    }

    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank

    /* Within a rank, fewest days first — and a null (lifetime/unknown) never wins the comparison. */
    const left = daysLeft(a, now)
    const right = daysLeft(b, now)
    if (left !== null && right !== null && left !== right) return left - right

    return (a.shopName || a.email || '').localeCompare(b.shopName || b.email || '')
  }
}

/** Alphabetical by shop, for when somebody is looking for one particular customer. */
export function byShopName(a: AdminAccount, b: AdminAccount): number {
  return (a.shopName || a.name || a.email || '').localeCompare(b.shopName || b.name || b.email || '')
}

export type SortKey = 'urgency' | 'shop' | 'newest'

export function sortAccounts(
  accounts: AdminAccount[],
  key: SortKey,
  now: Date = new Date(),
): AdminAccount[] {
  const list = accounts.slice()
  if (key === 'shop') return list.sort(byShopName)
  if (key === 'newest') {
    return list.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  }
  return list.sort(byUrgency(now))
}

/**
 * Search + filter + sort, in the one call a screen actually needs.
 *
 * ── Which rows come back, and why staff are not among them ─────────────────────
 * **Owners, by default.** A staff login is not a customer: it holds no licence, is never chased, and
 * listing one beside its owner would count one shop twice on a screen whose whole purpose is "who do
 * I need to ring". Staff belong *under* their owner, and the table nests them there.
 *
 * Two exceptions, both because the alternative is a row nobody can reach:
 *
 *   · **A typed query searches everybody.** Somebody looking up `rekha@shop.com` has a cashier in
 *     mind, and "no results" for an account that plainly exists is the kind of answer that gets a
 *     tool abandoned.
 *   · **The Staff filter lists staff alone.** The direct answer to "who has logins".
 */
export function visibleAccounts(
  accounts: AdminAccount[] | undefined,
  options: { query?: string; filter?: AccountFilter; sort?: SortKey; now?: Date } = {},
): AdminAccount[] {
  const now = options.now ?? new Date()
  const filter = options.filter ?? 'all'
  const query = options.query ?? ''
  const searching = query.trim() !== ''

  return sortAccounts(
    (accounts ?? []).filter((account) => {
      if (!matchesFilter(account, filter, now)) return false
      if (!matchesQuery(account, query)) return false
      /* Staff are nested under their owner unless asked for by name, or by the Staff filter. */
      if (isStaff(account) && filter !== 'staff' && !searching) return false
      return true
    }),
    options.sort ?? 'urgency',
    now,
  )
}

export interface AccountSummary {
  total: number
  active: number
  expiring: number
  expired: number
  lifetime: number
  unknown: number
  /** Expiring plus expired — the size of the job on this screen. */
  needsRenewal: number
  /** How many of those cannot be messaged, because there is no usable phone number. */
  unreachable: number
  /** Staff logins, counted apart — they are not customers and hold no licence. */
  staff: number
}

/**
 * The counters along the top.
 *
 * `unreachable` is included because a renewal list is only as good as the phone numbers behind
 * it — a console that says "12 to chase" while four of them have no number is quietly overstating
 * what can be done, and the missing numbers never get filled in.
 */
export function summarise(
  accounts: AdminAccount[] | undefined,
  isReachable: (account: AdminAccount) => boolean,
  now: Date = new Date(),
): AccountSummary {
  const summary: AccountSummary = {
    total: 0,
    active: 0,
    expiring: 0,
    expired: 0,
    lifetime: 0,
    unknown: 0,
    needsRenewal: 0,
    unreachable: 0,
    staff: 0,
  }

  for (const account of accounts ?? []) {
    /*
     * **Staff are counted apart from every other figure here.**
     *
     * They hold no licence of their own — the server sends them their owner's — so folding them in
     * would count one shop as many: an owner and three staff would read as four customers, four
     * active licences, and four rows to chase when the owner renews. Every counter on this screen is
     * about paying customers, so every counter is about owners.
     */
    if (isStaff(account)) {
      summary.staff += 1
      continue
    }

    summary.total += 1
    const state = subscriptionState(account, now)
    if (state === 'lifetime') summary.lifetime += 1
    else if (state === 'active') summary.active += 1
    else if (state === 'expiring') summary.expiring += 1
    else if (state === 'expired') summary.expired += 1
    else summary.unknown += 1

    if (needsRenewal(account, now)) {
      summary.needsRenewal += 1
      if (!isReachable(account)) summary.unreachable += 1
    }
  }

  return summary
}

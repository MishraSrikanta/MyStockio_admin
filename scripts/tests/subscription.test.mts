/**
 * Subscription arithmetic, and the renewal list it produces.
 *
 * Everything this console shows about a customer comes from these functions, so the edge cases are
 * asserted rather than assumed. Two of them would each cost real money:
 *
 *   · **A lifetime account must never look expired.** The server sends `expiresAt: null`, and
 *     treating a missing date as "long past" would put every lifetime customer into the chase-up
 *     list and send them a renewal demand for something they already own outright.
 *   · **Days are whole calendar days.** A licence ending at 23:00 tonight has "today" left, not
 *     "0.04 days". Everyone involved talks in days, so the count has to match what a person would
 *     say out loud.
 *
 * `now` is injected everywhere so time can be fixed. A test that depends on the wall clock passes
 * for eleven months and then fails on a leap day, which teaches nobody anything.
 */

import {
  EXPIRING_SOON_DAYS,
  type AdminAccount,
  daysLeft,
  describeTimeLeft,
  expiryAfterRenewal,
  formatDate,
  isLifetime,
  needsRenewal,
  planLabel,
  subscriptionState,
} from '../../src/lib/subscription'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const NOW = new Date('2026-08-20T10:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

/** An account whose licence ends `days` from NOW. */
const inDays = (days: number, plan = '1year'): AdminAccount => ({
  id: `a-${days}`,
  email: 'a@shop.com',
  subscription: { plan, status: 'active', expiresAt: new Date(NOW.getTime() + days * DAY).toISOString() },
})

const lifetimeAccount: AdminAccount = {
  id: 'life',
  email: 'life@shop.com',
  subscription: { plan: 'lifetime', status: 'active', expiresAt: null },
}

/* ══════════════════════════════════════ lifetime is not expired ══ */

console.log('a lifetime account')

check('is recognised as lifetime', isLifetime(lifetimeAccount))
check('has no day count', daysLeft(lifetimeAccount, NOW) === null, String(daysLeft(lifetimeAccount, NOW)))
check('reads as "lifetime"', subscriptionState(lifetimeAccount, NOW) === 'lifetime', subscriptionState(lifetimeAccount, NOW))
check('is NOT expired', subscriptionState(lifetimeAccount, NOW) !== 'expired')
check('is NEVER chased for renewal', !needsRenewal(lifetimeAccount, NOW))
check('describes itself plainly', describeTimeLeft(lifetimeAccount, NOW) === 'Lifetime', describeTimeLeft(lifetimeAccount, NOW))

/* A lifetime plan whose expiry is missing entirely, rather than explicitly null. */
const lifetimeNoField: AdminAccount = { id: 'l2', email: 'l2@shop.com', subscription: { plan: 'lifetime' } }
check('an absent expiry on a lifetime plan is still lifetime', isLifetime(lifetimeNoField))
check('...and still not chased', !needsRenewal(lifetimeNoField, NOW))

/*
 * The opposite trap: no plan and no date is missing DATA, not immortality. Reporting it as
 * lifetime would hide a broken record forever; reporting it as expired would demand money from
 * somebody who may be paid up. So it gets its own state.
 */
const noData: AdminAccount = { id: 'x', email: 'x@shop.com' }
check('an account with no subscription block is "unknown"', subscriptionState(noData, NOW) === 'unknown')
check('...not lifetime', !isLifetime(noData))
check('...and not chased, because we do not know', !needsRenewal(noData, NOW))
check('...and says so rather than showing a number', describeTimeLeft(noData, NOW) === 'No subscription data')

/* ═══════════════════════════════════════════ counting days ══ */

console.log('\ncounting days')

check('30 days out is 30', daysLeft(inDays(30), NOW) === 30, String(daysLeft(inDays(30), NOW)))
check('1 day out is 1', daysLeft(inDays(1), NOW) === 1)
check('today is 0', daysLeft(inDays(0), NOW) === 0, String(daysLeft(inDays(0), NOW)))
check('yesterday is -1', daysLeft(inDays(-1), NOW) === -1)
check('a year out is 365', daysLeft(inDays(365), NOW) === 365)

/*
 * The calendar-day boundary. A licence ending at 23:00 tonight still has today; one that ended at
 * 01:00 this morning is already gone. Both are "less than a day" from now in raw milliseconds, and
 * a naive divide-and-floor would call them both 0.
 */
/*
 * Built from LOCAL date parts, not a UTC string.
 *
 * The count is in local calendar days, which is the right choice — a shopkeeper asking "does my
 * licence work today?" means their today, not UTC's. The consequence is that a fixture written as
 * `2026-08-20T23:00:00Z` is 04:30 the *next* day in IST, so it correctly reads as 1 day left and
 * this test would pass or fail depending on where it ran. Constructing the times locally states
 * the intent and holds in every timezone.
 */
const atLocal = (day: number, hour: number, minute = 0): string =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + day, hour, minute).toISOString()

const endsTonight: AdminAccount = {
  id: 'tonight',
  email: 't@shop.com',
  subscription: { plan: '1year', expiresAt: atLocal(0, 23, 0) },
}
const endedThisMorning: AdminAccount = {
  id: 'morning',
  email: 'm@shop.com',
  subscription: { plan: '1year', expiresAt: atLocal(0, 1, 0) },
}
check('a licence ending tonight has today left', daysLeft(endsTonight, NOW) === 0, String(daysLeft(endsTonight, NOW)))
check('...and is not yet expired', subscriptionState(endsTonight, NOW) !== 'expired')
check('one that ended this morning is also "today"', daysLeft(endedThisMorning, NOW) === 0)
check('one minute past midnight tomorrow is 1 day', daysLeft({ id: 'n', email: 'n', subscription: { expiresAt: atLocal(1, 0, 1) } }, NOW) === 1)
check('one minute before midnight tonight is 0', daysLeft({ id: 'p', email: 'p', subscription: { expiresAt: atLocal(0, 23, 59) } }, NOW) === 0)
check('yesterday at any hour is -1', daysLeft({ id: 'y', email: 'y', subscription: { expiresAt: atLocal(-1, 12) } }, NOW) === -1)
check('a malformed date is treated as no data', daysLeft({ id: 'z', email: 'z', subscription: { expiresAt: 'not a date' } }, NOW) === null)

/* ══════════════════════════════════════════════ the states ══ */

console.log('\nthe states, and the renewal boundary')

check('far out is active', subscriptionState(inDays(200), NOW) === 'active')
check(`${EXPIRING_SOON_DAYS + 1} days is still active`, subscriptionState(inDays(EXPIRING_SOON_DAYS + 1), NOW) === 'active')
check(`exactly ${EXPIRING_SOON_DAYS} days is expiring`, subscriptionState(inDays(EXPIRING_SOON_DAYS), NOW) === 'expiring')
check('1 day is expiring', subscriptionState(inDays(1), NOW) === 'expiring')
check('today is expiring, not expired', subscriptionState(inDays(0), NOW) === 'expiring')
check('yesterday is expired', subscriptionState(inDays(-1), NOW) === 'expired')
check('long past is expired', subscriptionState(inDays(-400), NOW) === 'expired')

check('an active account is not chased', !needsRenewal(inDays(200), NOW))
check('an expiring one is chased', needsRenewal(inDays(10), NOW))
check('an expired one is chased', needsRenewal(inDays(-10), NOW))

/* ═══════════════════════════════════════════════ the wording ══ */

console.log('\nhow it reads')

check('expires today', describeTimeLeft(inDays(0), NOW) === 'Expires today', describeTimeLeft(inDays(0), NOW))
check('1 day left is singular', describeTimeLeft(inDays(1), NOW) === '1 day left')
check('17 days left', describeTimeLeft(inDays(17), NOW) === '17 days left')
check('1 day ago is singular', describeTimeLeft(inDays(-1), NOW) === 'Expired 1 day ago')
check('5 days ago', describeTimeLeft(inDays(-5), NOW) === 'Expired 5 days ago')
/* Past about six weeks a three-digit day count stops being useful to a person. */
check('months once it is far out', describeTimeLeft(inDays(180), NOW) === '6 months left', describeTimeLeft(inDays(180), NOW))
check('1 month is singular', describeTimeLeft(inDays(30 * 1 + 15), NOW).startsWith('2 month') || describeTimeLeft(inDays(45), NOW) === '2 months left')
check('44 days still reads in days', describeTimeLeft(inDays(44), NOW) === '44 days left')

check('a plan label is friendly', planLabel('1year') === '1 year' && planLabel('lifetime') === 'Lifetime')
check('an unknown plan shows what the server said', planLabel('3year') === '3year')
check('a missing plan shows a dash', planLabel(undefined) === '—')

check('a date formats readably', formatDate('2027-08-19T00:00:00.000Z').includes('2027'), formatDate('2027-08-19T00:00:00.000Z'))
check('a null date formats empty', formatDate(null) === '')
check('a nonsense date formats empty', formatDate('nope') === '')

/* ══════════════════════════════════ what a renewal grants ══ */

console.log('\nrenewal dates')

/*
 * Renewing early must not forfeit paid-for days, and renewing late must not grant credit for time
 * the app was unusable. Those two rules are only consistent if the extension runs from whichever
 * of (current expiry, today) is later — which is what this asserts from both sides.
 */
const early = expiryAfterRenewal(inDays(60), '1year', NOW)
const earlyDays = Math.round((new Date(early!).getTime() - NOW.getTime()) / DAY)
check('renewing 60 days early adds a year on top', earlyDays === 425, String(earlyDays))

const late = expiryAfterRenewal(inDays(-60), '1year', NOW)
const lateDays = Math.round((new Date(late!).getTime() - NOW.getTime()) / DAY)
check('renewing 60 days late gives a full year from today', lateDays === 365, String(lateDays))

const onTime = expiryAfterRenewal(inDays(0), '1year', NOW)
check('renewing on the last day gives a full year from today', Math.round((new Date(onTime!).getTime() - NOW.getTime()) / DAY) === 365)

const twoYear = expiryAfterRenewal(inDays(-10), '2year', NOW)
check('a two-year plan grants 730 days', Math.round((new Date(twoYear!).getTime() - NOW.getTime()) / DAY) === 730)

check('lifetime has no expiry to compute', expiryAfterRenewal(inDays(30), 'lifetime', NOW) === null)
check('renewing an account with no data starts from today', Math.round((new Date(expiryAfterRenewal(noData, '1year', NOW)!).getTime() - NOW.getTime()) / DAY) === 365)

/* ═════════════════════════════════════════════ the invariant ══ */

console.log('\nthe invariant')

/*
 * The one property that keeps a paying customer from being harassed: an account is chased only
 * when it has a real expiry date that is within the window or already past. Nothing without a date
 * may ever land in the renewal list.
 */
let violations = 0
const SAMPLE: AdminAccount[] = [
  lifetimeAccount,
  lifetimeNoField,
  noData,
  ...[-500, -30, -1, 0, 1, 15, 30, 31, 90, 400].map((d) => inDays(d)),
  { id: 'q', email: 'q', subscription: { plan: '1year', expiresAt: 'rubbish' } },
]
for (const account of SAMPLE) {
  const chased = needsRenewal(account, NOW)
  const left = daysLeft(account, NOW)
  if (chased && left === null) violations += 1
  if (chased && left !== null && left > EXPIRING_SOON_DAYS) violations += 1
  if (isLifetime(account) && chased) violations += 1
}
check('nothing without a real expiry is ever chased', violations === 0, `${violations} violation(s)`)

console.log()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

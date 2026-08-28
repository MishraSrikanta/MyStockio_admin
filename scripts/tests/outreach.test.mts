/**
 * Renewal messages, phone numbers, and the lists the console shows.
 *
 * The phone assertions carry the most weight. WhatsApp answers a malformed number with a "not on
 * WhatsApp" page that looks exactly like the customer genuinely not having it — so a number this
 * app cannot make sense of has to disable the button rather than offer one that quietly fails. A
 * shop that never gets chased because of a stray bracket in its phone number is a shop that
 * silently lapses.
 */

import {
  DEFAULT_COUNTRY_CODE,
  formatAmount,
  normalisePhone,
  reminderMessage,
  toneFor,
  whatsappLink,
} from '../../src/lib/outreach'
import { type AccountFilter, summarise, visibleAccounts } from '../../src/lib/accounts'
import type { AdminAccount } from '../../src/lib/subscription'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/*
 * **The real clock, deliberately — not a frozen date.**
 *
 * This was pinned to a fixed timestamp, and it worked until the day rolled over: the fixtures dated
 * their expiries from the frozen moment while `reminderMessage` read the actual date, so "7 days
 * left" quietly became "6 days left" overnight and a suite that had passed for weeks failed on a
 * calendar boundary rather than on a change.
 *
 * The functions that take a `now` are still given this one, so those assertions stay exact. The ones
 * that cannot — the message builders read the clock themselves — now agree with the fixtures because
 * both sides start from the same instant, whatever day it is.
 */
const NOW = new Date()
const DAY = 24 * 60 * 60 * 1000

const account = (over: Partial<AdminAccount> & { days?: number | null }): AdminAccount => {
  const { days, ...rest } = over
  return {
    id: rest.id ?? 'a1',
    email: rest.email ?? 'a@shop.com',
    name: rest.name ?? 'Ramesh',
    phone: rest.phone,
    shopName: rest.shopName ?? 'Balaji Traders',
    subscription:
      days === null
        ? { plan: 'lifetime', expiresAt: null }
        : { plan: '1year', expiresAt: new Date(NOW.getTime() + (days ?? 10) * DAY).toISOString() },
    ...rest,
  }
}

/* ══════════════════════════════════════════════ phone numbers ══ */

console.log('phone numbers')

check('a plain 10-digit number gets the country code', normalisePhone('9876543210') === `${DEFAULT_COUNTRY_CODE}9876543210`)
check('spaces are stripped', normalisePhone('98765 43210') === '919876543210')
check('hyphens are stripped', normalisePhone('98765-43210') === '919876543210')
check('brackets are stripped', normalisePhone('(98765) 43210') === '919876543210')
check('a leading + is dropped', normalisePhone('+91 98765 43210') === '919876543210')
check('a leading 0 is replaced by the code', normalisePhone('09876543210') === '919876543210')
check('an already-prefixed number is left alone', normalisePhone('919876543210') === '919876543210')
check('a different country code is honoured', normalisePhone('9876543210', '977') === '9779876543210')

/* The cases that must NOT produce a link. */
check('an empty number is unusable', normalisePhone('') === '')
check('undefined is unusable', normalisePhone(undefined) === '')
check('a too-short number is unusable', normalisePhone('12345') === '')
check('letters alone are unusable', normalisePhone('call me') === '')
check('a single digit is unusable', normalisePhone('9') === '')
check('a 16-digit number is unusable', normalisePhone('1234567890123456') === '')

/* ══════════════════════════════════════════ the WhatsApp link ══ */

console.log('\nthe WhatsApp link')

const chaseable = account({ days: 5, phone: '9876543210' })
const link = whatsappLink(chaseable, 'Hello there')
check('a link is built for a usable number', link.startsWith('https://wa.me/919876543210?text='), link.slice(0, 44))
check('the message is URL-encoded', link.includes('Hello%20there'), link)

const unreachable = account({ days: 5, phone: 'n/a' })
check('no link without a usable number', whatsappLink(unreachable, 'Hi') === '')
check('no link when the phone is missing entirely', whatsappLink(account({ days: 5 }), 'Hi') === '')

/* A message with newlines and rupees must survive encoding intact. */
const rich = whatsappLink(chaseable, 'Line one\nLine two ₹3,000')
check('newlines are encoded', rich.includes('%0A'))
check('the rupee sign is encoded', rich.includes('%E2%82%B9'))
check('...and nothing is left raw', !/[\n₹]/.test(rich))

/* ══════════════════════════════════════════ the message text ══ */

console.log('\nwhat the message says')

const expiring = reminderMessage(account({ days: 7 }), 'expiring')
check('it greets the shop by name', expiring.includes('Balaji Traders'), expiring.split('\n')[0])
check('it says how long is left', expiring.includes('7 days left'), expiring)
check('it names the app', expiring.includes('MyStockio'))
/*
 * Three to five letters for the month, not exactly three. `en-IN` abbreviates September as "Sept"
 * and does not abbreviate May at all, so a three-letter assertion passes for most of the year and
 * fails in the rest — which is exactly how it failed, on a calendar boundary rather than a change.
 */
check('it gives the end date', /\d{2} \w{3,5} \d{4}/.test(expiring), expiring)
/* No amount in a reminder: prices change, and a stale figure in writing is an argument later. */
check('it does NOT quote a price', !expiring.includes('₹'))

const expired = reminderMessage(account({ days: -12 }), 'expired')
check('an expired message says so', expired.includes('expired'), expired)
/* The reassurance matters — the usual fear is that the data is gone. */
check('...and reassures that nothing was deleted', expired.toLowerCase().includes('data is safe'))
check('...and asks a question rather than demanding', expired.includes('?'))

const receipt = reminderMessage(account({ days: 365 }), 'receipt', { amount: 3000 })
check('a receipt thanks them', receipt.toLowerCase().includes('thank you'))
check('...and states the amount', receipt.includes('3,000'), receipt)
check('...and the new expiry', /\d{2} \w{3} \d{4}/.test(receipt))

const lifetimeReceipt = reminderMessage(account({ days: null }), 'receipt', { amount: 12000 })
check('a lifetime receipt says it never expires', lifetimeReceipt.includes('lifetime'), lifetimeReceipt)
check('...and quotes no expiry date', !/\d{2} \w{3} \d{4}/.test(lifetimeReceipt))

const withContact = reminderMessage(account({ days: 5 }), 'expiring', { contact: '+91 90000 00000' })
check('a contact number is appended when given', withContact.includes('+91 90000 00000'))
check('...and omitted when not', !expiring.includes('Reply here'))

/* A shop with no name at all must still get a sensible greeting. */
const nameless = reminderMessage({ id: 'n', email: 'n@shop.com', subscription: { plan: '1year', expiresAt: new Date(NOW.getTime() + 5 * DAY).toISOString() } }, 'expiring')
check('a nameless account still reads properly', nameless.startsWith('Hello,'), nameless.split('\n')[0])
check('...with no stray placeholder', !nameless.includes('undefined'))

check('the tone follows the state — expiring', toneFor(account({ days: 5 }), NOW) === 'expiring')
check('the tone follows the state — expired', toneFor(account({ days: -5 }), NOW) === 'expired')

check('amounts use Indian grouping', formatAmount(120000) === '1,20,000', formatAmount(120000))
check('a small amount is plain', formatAmount(500) === '500')
check('a nonsense amount does not print NaN', formatAmount(Number.NaN) === '0')

/* ══════════════════════════════════════ the lists and counters ══ */

console.log('\nfiltering, sorting and the counters')

const roster: AdminAccount[] = [
  account({ id: 'far', shopName: 'Far Future', days: 300, phone: '9000000001' }),
  account({ id: 'soon', shopName: 'Ending Soon', days: 5, phone: '9000000002' }),
  account({ id: 'sooner', shopName: 'Ending Sooner', days: 1, phone: '9000000003' }),
  account({ id: 'gone', shopName: 'Long Gone', days: -90, phone: '' }),
  account({ id: 'life', shopName: 'Forever Stores', days: null, phone: '9000000005' }),
  { id: 'broken', email: 'broken@shop.com', shopName: 'No Data' },
]

const urgent = visibleAccounts(roster, { now: NOW })
check('the expired one is first', urgent[0]?.id === 'gone', String(urgent[0]?.id))
check('then the soonest to lapse', urgent[1]?.id === 'sooner', String(urgent[1]?.id))
check('then the next soonest', urgent[2]?.id === 'soon', String(urgent[2]?.id))
check('lifetime sinks to the bottom', urgent[urgent.length - 1]?.id === 'life', String(urgent[urgent.length - 1]?.id))

const counts: Record<AccountFilter, number> = {
  all: 6,
  'needs-renewal': 3,
  expiring: 2,
  expired: 1,
  active: 1,
  lifetime: 1,
}
for (const [filter, expected] of Object.entries(counts) as [AccountFilter, number][]) {
  const got = visibleAccounts(roster, { filter, now: NOW }).length
  check(`filter "${filter}" shows ${expected}`, got === expected, String(got))
}

check('search finds a shop by name', visibleAccounts(roster, { query: 'forever', now: NOW }).length === 1)
check('search is case-insensitive', visibleAccounts(roster, { query: 'FOREVER', now: NOW }).length === 1)
check('search finds by email', visibleAccounts(roster, { query: 'broken@', now: NOW })[0]?.id === 'broken')
/* A number written with a space must be findable typed either way. */
check('search finds by phone digits', visibleAccounts(roster, { query: '9000000003', now: NOW })[0]?.id === 'sooner')
check('...even typed with a space', visibleAccounts(roster, { query: '90000 00003', now: NOW })[0]?.id === 'sooner')
check('a query matching nothing shows nothing', visibleAccounts(roster, { query: 'zzzz', now: NOW }).length === 0)
check('an empty query shows everything', visibleAccounts(roster, { query: '   ', now: NOW }).length === 6)
check('no accounts at all is survivable', visibleAccounts(undefined, { now: NOW }).length === 0)

const reachable = (a: AdminAccount) => normalisePhone(a.phone) !== ''
const summary = summarise(roster, reachable, NOW)
check('total is counted', summary.total === 6, String(summary.total))
check('active is counted', summary.active === 1, String(summary.active))
check('expiring is counted', summary.expiring === 2, String(summary.expiring))
check('expired is counted', summary.expired === 1, String(summary.expired))
check('lifetime is counted', summary.lifetime === 1, String(summary.lifetime))
check('unknown is counted separately', summary.unknown === 1, String(summary.unknown))
check('needs-renewal is expiring + expired', summary.needsRenewal === 3, String(summary.needsRenewal))
/*
 * The honest counter: of the three to chase, one has no usable number. A console reporting "3 to
 * chase" while one of them cannot be reached overstates what can be done, and the missing number
 * never gets filled in.
 */
check('unreachable is counted, so the gap is visible', summary.unreachable === 1, String(summary.unreachable))
check('a lifetime account is never counted as needing renewal', summarise([account({ days: null, phone: '' })], reachable, NOW).needsRenewal === 0)

console.log()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

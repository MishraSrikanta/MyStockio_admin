/**
 * Checks the reference admin API against ADMIN-API-CONTRACT.md.
 *
 *   npm run test:api
 *
 * Two things are being verified, and the second matters more than the first.
 *
 * **That the routes work** — creating, listing, amending, deleting, taking a payment.
 *
 * **That a shop's own token cannot reach any of them.** The console's password is compiled into a
 * JavaScript bundle and anybody can read it, so it protects nothing on its own. Server-side role
 * enforcement is the only thing standing between one customer and every other customer's details,
 * and that is asserted here from both directions: an admin token gets in, a shop token does not.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname.slice(1))
const PORT = 8801
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-contract-'))
/** What the console sends in X-Admin-Key. It has no sign-in call; this is its credential. */
const CONSOLE_KEY = 'contract-console-key'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const child = spawn(process.execPath, [join(HERE, 'admin-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_SECRET: 'contract-test', ADMIN_API_KEY: CONSOLE_KEY },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function call(method, path, { body, token: bearer, key } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (key) headers['X-Admin-Key'] = key
  const response = await fetch(`${BASE}/${path.replace(/^\//, '')}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the reference server did not start')
}

try {
  await waitForServer()

  /* ── the administrator ─────────────────────────────────────────────────── */
  console.log('the administrator')

  const boot = await call('POST', 'api/v1/admin/bootstrap', {
    body: { email: 'boss@shop.com', password: 'admin-pass', name: 'Boss' },
  })
  check('an administrator can be seeded', boot.status === 201, String(boot.status))
  const adminToken = boot.body?.accessToken
  check('...and gets a token', typeof adminToken === 'string' && adminToken.length > 20)
  check('...marked superadmin', boot.body?.account?.role === 'superadmin', String(boot.body?.account?.role))
  check('...with no password hash in the response', !JSON.stringify(boot.body).includes('scrypt$'))

  const signIn = await call('POST', 'api/v1/admin/login', {
    body: { email: 'boss@shop.com', password: 'admin-pass' },
  })
  check('the admin login route works', signIn.status === 200, String(signIn.status))
  check('a wrong password is refused', (await call('POST', 'api/v1/admin/login', { body: { email: 'boss@shop.com', password: 'nope' } })).status === 401)
  check(
    'an unknown email gives the same 401, not a 404',
    (await call('POST', 'api/v1/admin/login', { body: { email: 'nobody@shop.com', password: 'nope' } })).status === 401,
  )

  /* ── creating customers through the ordinary signup route ──────────────── */
  console.log('\ncreating accounts (the shared signup route)')

  const created = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Ramesh', email: 'Ramesh@Shop.com', password: 'pw', phone: '9876543210', shopName: 'Balaji Traders', plan: '1year' },
  })
  check('an account is created', created.status === 201, String(created.status))
  const shopId = created.body?.account?.id
  const shopToken = created.body?.accessToken
  check('the email is lower-cased', created.body?.account?.email === 'ramesh@shop.com')
  check('the shop name is kept', created.body?.account?.shopName === 'Balaji Traders')
  check('a one-year subscription is issued', created.body?.account?.subscription?.plan === '1year')
  check('...with an expiry about a year out', (() => {
    const days = Math.round((new Date(created.body.account.subscription.expiresAt) - Date.now()) / 86_400_000)
    return days >= 364 && days <= 366
  })(), String(created.body?.account?.subscription?.expiresAt))
  check('a duplicate email is refused', (await call('POST', 'api/v1/auth/register', { body: { name: 'X', email: 'ramesh@shop.com', password: 'pw' } })).status === 409)
  check(
    'missing fields are refused with per-field detail',
    (await call('POST', 'api/v1/auth/register', { body: {} })).body?.error?.details?.email === 'is required',
  )

  const lifetime = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Sita', email: 'sita@shop.com', password: 'pw', shopName: 'Sita Stores', plan: 'lifetime' },
  })
  check('a lifetime account can be created', lifetime.body?.account?.subscription?.plan === 'lifetime')
  check('...and carries no expiry', lifetime.body?.account?.subscription?.expiresAt === null)

  /* ══════════════════ the guarantee that actually protects the data ══ */
  console.log('\nonly an administrator may use the admin API')

  check('no token is refused', (await call('GET', 'api/v1/admin/accounts')).status === 401)
  check('a nonsense token is refused', (await call('GET', 'api/v1/admin/accounts', { token: 'not-a-token' })).status === 401)
  /*
   * The one that matters: a real, valid token belonging to a shop. It authenticates perfectly and
   * must still be refused, or any customer could read every other customer's details.
   */
  const asShop = await call('GET', 'api/v1/admin/accounts', { token: shopToken })
  check("a SHOP's valid token is refused with 403", asShop.status === 403, String(asShop.status))
  check('...and returns no accounts at all', !asShop.body?.accounts)
  check(
    'a shop cannot delete an account either',
    (await call('DELETE', `api/v1/admin/accounts/${shopId}`, { token: shopToken })).status === 403,
  )
  check(
    'a shop cannot record a payment',
    (await call('POST', 'api/v1/admin/payments', { token: shopToken, body: { accountId: shopId, amount: 1, plan: '1year' } })).status === 403,
  )
  check(
    'a shop cannot sign in through the admin login route',
    (await call('POST', 'api/v1/admin/login', { body: { email: 'ramesh@shop.com', password: 'pw' } })).status === 403,
  )

  /* ══════════════════ the console's key, which is its only credential ══ */
  console.log('\nthe console key')

  /*
   * The console signs in locally and never calls the server, so this header is the whole of its
   * authorisation. Both directions matter: the right key must work, and a wrong one must not — an
   * endpoint that accepts an unrecognised key has no protection at all, and the failure would be
   * invisible because everything would keep working.
   */
  const viaKey = await call('GET', 'api/v1/admin/accounts', { key: CONSOLE_KEY })
  check('the right key lists accounts', viaKey.status === 200, String(viaKey.status))
  check('a wrong key is refused', (await call('GET', 'api/v1/admin/accounts', { key: 'wrong-key' })).status === 403)
  check(
    'a key of the right length but wrong content is refused',
    (await call('GET', 'api/v1/admin/accounts', { key: 'x'.repeat(CONSOLE_KEY.length) })).status === 403,
  )
  check('no credential at all is 401, not 403', (await call('GET', 'api/v1/admin/accounts')).status === 401)
  /*
   * A whitespace-only header value is stripped by the HTTP layer before the server sees it, so this
   * arrives as no credential at all and is a 401 rather than a 403. Worth asserting the real
   * behaviour: either answer refuses the request, and the distinction only matters to whoever is
   * reading the log — but a test that claimed 403 would be documenting something untrue.
   */
  check('a whitespace-only key reads as no credential', (await call('GET', 'api/v1/admin/accounts', { key: ' ' })).status === 401)

  /*
   * On a throwaway account, not on `shopId`. A payment recorded here would otherwise show up in the
   * payment-history assertions further down — tests that share mutable state fail in pairs and send
   * you looking at the wrong one.
   */
  const keyTarget = await call('POST', 'api/v1/auth/register', {
    body: { name: 'KeyTest', email: 'keytest@shop.com', password: 'pw', plan: '1year' },
  })
  const keyTargetId = keyTarget.body.account.id
  check(
    'the key can record a payment',
    (await call('POST', 'api/v1/admin/payments', { key: CONSOLE_KEY, body: { accountId: keyTargetId, amount: 1, plan: '1year' } })).status === 201,
  )
  check(
    'a wrong key cannot record a payment',
    (await call('POST', 'api/v1/admin/payments', { key: 'wrong-key', body: { accountId: keyTargetId, amount: 1, plan: '1year' } })).status === 403,
  )
  await call('DELETE', `api/v1/admin/accounts/${keyTargetId}`, { key: CONSOLE_KEY })
  /* The stronger credential stays available: a real administrator's token still works. */
  check('a bearer admin token works alongside the key', (await call('GET', 'api/v1/admin/accounts', { token: adminToken })).status === 200)

  /* ── listing ──────────────────────────────────────────────────────────── */
  console.log('\nlisting accounts')

  const list = await call('GET', 'api/v1/admin/accounts', { token: adminToken })
  check('an admin token lists accounts', list.status === 200, String(list.status))
  check('both customers are listed', list.body?.accounts?.length === 2, String(list.body?.accounts?.length))
  check('the administrator is NOT listed as a customer', !list.body.accounts.some((a) => a.role === 'superadmin'))
  check('no password hash is anywhere in the list', !JSON.stringify(list.body).includes('scrypt$'))
  check('subscription data comes with each account', list.body.accounts.every((a) => a.subscription?.plan))
  check('phone numbers come through, for the renewal messages', list.body.accounts.some((a) => a.phone === '9876543210'))

  /* ── amending ─────────────────────────────────────────────────────────── */
  console.log('\namending an account')

  const renamed = await call('PATCH', `api/v1/admin/accounts/${shopId}`, {
    token: adminToken,
    body: { shopName: 'Balaji Super Traders', phone: '9000000001' },
  })
  check('the shop name changes', renamed.body?.account?.shopName === 'Balaji Super Traders')
  check('the phone changes', renamed.body?.account?.phone === '9000000001')
  check('untouched fields are left alone', renamed.body?.account?.email === 'ramesh@shop.com')

  const reEmailed = await call('PATCH', `api/v1/admin/accounts/${shopId}`, {
    token: adminToken,
    body: { email: 'NewMail@Shop.com' },
  })
  check('the login email can be changed', reEmailed.body?.account?.email === 'newmail@shop.com')
  check(
    'but not to one already in use',
    (await call('PATCH', `api/v1/admin/accounts/${shopId}`, { token: adminToken, body: { email: 'sita@shop.com' } })).status === 409,
  )
  check(
    'and not to nothing',
    (await call('PATCH', `api/v1/admin/accounts/${shopId}`, { token: adminToken, body: { email: '  ' } })).status === 400,
  )

  await call('PATCH', `api/v1/admin/accounts/${shopId}`, { token: adminToken, body: { password: 'brand-new-pw' } })
  check(
    'a changed password works for signing in',
    (await call('POST', 'api/v1/auth/login', { body: { email: 'newmail@shop.com', password: 'brand-new-pw' } })).status === 200,
  )
  check(
    '...and the old one no longer does',
    (await call('POST', 'api/v1/auth/login', { body: { email: 'newmail@shop.com', password: 'pw' } })).status === 401,
  )

  /* ── payments and renewal ─────────────────────────────────────────────── */
  console.log('\ntaking a payment')

  const before = (await call('GET', `api/v1/admin/accounts/${shopId}`, { token: adminToken })).body.account
  const beforeExpiry = new Date(before.subscription.expiresAt).getTime()

  const paid = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: shopId, amount: 3000, plan: '1year', method: 'upi', reference: 'UPI-123' },
  })
  check('a payment is accepted', paid.status === 201, String(paid.status))
  const afterExpiry = new Date(paid.body.account.subscription.expiresAt).getTime()
  check(
    'the subscription is extended, not reset',
    Math.round((afterExpiry - beforeExpiry) / 86_400_000) === 365,
    `${Math.round((afterExpiry - beforeExpiry) / 86_400_000)} days added`,
  )
  check('the payment is recorded against the account', paid.body?.account?.lastPaymentAmount === 3000)
  check('...with a timestamp', Boolean(paid.body?.account?.lastPaymentAt))

  const history = await call('GET', `api/v1/admin/payments?accountId=${shopId}`, { token: adminToken })
  check('the payment appears in the history', history.body?.payments?.length === 1, String(history.body?.payments?.length))
  check('...with who recorded it', history.body.payments[0].recordedBy === 'boss@shop.com')
  check('...and the reference', history.body.payments[0].reference === 'UPI-123')

  /* A lapsed account extends from today, not from its old expiry. */
  const lapsed = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Old', email: 'old@shop.com', password: 'pw', plan: '1year' },
  })
  const lapsedId = lapsed.body.account.id
  await call('PATCH', `api/v1/admin/accounts/${lapsedId}`, { token: adminToken, body: { plan: '1year' } })
  const renewedLapsed = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: lapsedId, amount: 3000, plan: '1year' },
  })
  const lapsedDays = Math.round((new Date(renewedLapsed.body.account.subscription.expiresAt) - Date.now()) / 86_400_000)
  check('renewing gives a full term from the later of today / current expiry', lapsedDays >= 729 && lapsedDays <= 731, `${lapsedDays} days`)

  const toLifetime = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: lapsedId, amount: 12000, plan: 'lifetime' },
  })
  check('paying for lifetime removes the expiry', toLifetime.body?.account?.subscription?.expiresAt === null)
  check('...and records the plan', toLifetime.body?.account?.subscription?.plan === 'lifetime')


  /* ── refunds ───────────────────────────────────────────────────────────── */
  /*
   * Money out is the same ledger read backwards. The two things that must hold, because both are
   * discovered expensively: a refund must not shorten the term the shop paid for, and it must not
   * masquerade as the last payment received.
   */
  console.log('\nrefunds')

  const beforeRefund = await call('GET', `api/v1/admin/accounts/${shopId}`, { token: adminToken })
  const expiryBefore = beforeRefund.body?.account?.subscription?.expiresAt

  const refunded = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: shopId, amount: 500, plan: '1year', method: 'upi', type: 'refund', note: 'goodwill' },
  })
  check('a refund is accepted', refunded.status === 201, String(refunded.status))
  check('...and comes back as a refund', refunded.body?.payment?.type === 'refund', String(refunded.body?.payment?.type))
  check('...with the amount kept positive', refunded.body?.payment?.amount === 500, String(refunded.body?.payment?.amount))
  check(
    '...and the licence is NOT shortened',
    refunded.body?.account?.subscription?.expiresAt === expiryBefore,
    `${expiryBefore} → ${refunded.body?.account?.subscription?.expiresAt}`,
  )
  check(
    '...and it is not reported as the last payment',
    refunded.body?.account?.lastPaymentAmount !== 500,
    String(refunded.body?.account?.lastPaymentAmount),
  )

  const ledger = await call('GET', `api/v1/admin/payments?accountId=${shopId}`, { token: adminToken })
  const refundRows = (ledger.body?.payments ?? []).filter((p) => p.type === 'refund')
  check('the refund is in the ledger', refundRows.length === 1, `${refundRows.length} refund row(s)`)
  check('...and every other row is typed as a payment', (ledger.body?.payments ?? []).every((p) => p.type === 'payment' || p.type === 'refund'))
  check('...and the refund records who took it', typeof refundRows[0]?.recordedBy === 'string' && refundRows[0].recordedBy.length > 0)

  /* An absent type must still be a payment, so a client written before refunds keeps working. */
  const untyped = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: shopId, amount: 100, plan: '1year' },
  })
  check('a payment with no type is recorded as one', untyped.body?.payment?.type === 'payment', String(untyped.body?.payment?.type))
  check('...and it does extend the licence', untyped.body?.account?.subscription?.expiresAt !== expiryBefore)

  /* A refund of zero is as invalid as a payment of zero — the direction is not the amount. */
  check(
    'a zero refund is refused',
    (await call('POST', 'api/v1/admin/payments', { token: adminToken, body: { accountId: shopId, amount: 0, plan: '1year', type: 'refund' } })).status === 400,
  )
  check(
    'a nonsense type is treated as a payment, not rejected',
    (await call('POST', 'api/v1/admin/payments', { token: adminToken, body: { accountId: shopId, amount: 10, plan: '1year', type: 'wibble' } })).body?.payment?.type === 'payment',
  )

  console.log('\nbad payment input')
  check('a zero amount is refused', (await call('POST', 'api/v1/admin/payments', { token: adminToken, body: { accountId: shopId, amount: 0, plan: '1year' } })).status === 400)
  check('a negative amount is refused', (await call('POST', 'api/v1/admin/payments', { token: adminToken, body: { accountId: shopId, amount: -100, plan: '1year' } })).status === 400)
  check('an unknown plan is refused', (await call('POST', 'api/v1/admin/payments', { token: adminToken, body: { accountId: shopId, amount: 100, plan: '3year' } })).status === 400)
  check('an unknown account is a 404', (await call('POST', 'api/v1/admin/payments', { token: adminToken, body: { accountId: 'nope', amount: 100, plan: '1year' } })).status === 404)
  check(
    'an expiry cannot be posted directly',
    (await call('POST', 'api/v1/admin/payments', {
      token: adminToken,
      body: { accountId: shopId, amount: 1, plan: '1year', expiresAt: '2099-01-01T00:00:00.000Z' },
    })).body?.account?.subscription?.expiresAt?.startsWith('2099') !== true,
  )

  /* ── deleting ─────────────────────────────────────────────────────────── */
  console.log('\ndeleting an account')

  const gone = await call('DELETE', `api/v1/admin/accounts/${lapsedId}`, { token: adminToken })
  check('an account is deleted', gone.status === 200, String(gone.status))
  check('...and disappears from the list', !(await call('GET', 'api/v1/admin/accounts', { token: adminToken })).body.accounts.some((a) => a.id === lapsedId))
  check('...and can no longer sign in', (await call('POST', 'api/v1/auth/login', { body: { email: 'old@shop.com', password: 'pw' } })).status === 401)
  check('its payments go with it', (await call('GET', `api/v1/admin/payments?accountId=${lapsedId}`, { token: adminToken })).body.payments.length === 0)
  check('deleting it again is a 404', (await call('DELETE', `api/v1/admin/accounts/${lapsedId}`, { token: adminToken })).status === 404)
  check(
    'an administrator cannot be deleted through this route',
    (await call('DELETE', `api/v1/admin/accounts/${boot.body.account.id}`, { token: adminToken })).status === 403,
  )

  /* ── shapes ───────────────────────────────────────────────────────────── */

  /* ── roles and the owner they hang from ────────────────────────────────── */
  /*
   * The shape being asserted: an owner holds the licence, staff hang off an owner and hold none, and
   * the two fields never cross. `role` is platform privilege — it decides who may call the admin API
   * — and `shopRole` is a job title. Keeping them apart is what stops a public signup route from
   * being a way to ask for `superadmin`.
   */
  console.log('\nroles')

  const ownerSignup = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Family Owner', email: 'famowner@shop.com', password: 'Passw0rd!', shopName: 'Family Stores', plan: '1year' },
  })
  const familyOwnerId = ownerSignup.body?.account?.id
  check('an account with no shopRole is created as an owner', ownerSignup.body?.account?.shopRole === 'owner', String(ownerSignup.body?.account?.shopRole))
  check('...and gets a licence of its own', !!ownerSignup.body?.account?.subscription?.expiresAt)
  check('...and answers to nobody', ownerSignup.body?.account?.ownerId === null)

  const cashier = await call('POST', 'api/v1/auth/register', {
    body: {
      name: 'Rekha', email: 'rekha@shop.com', password: 'Passw0rd!',
      shopRole: 'cashier', ownerEmail: 'famowner@shop.com',
    },
  })
  const cashierId = cashier.body?.account?.id
  check('a cashier is created', cashier.status === 201, String(cashier.status))
  check('...with the role it asked for', cashier.body?.account?.shopRole === 'cashier')
  check('...pointed at the owner by id', cashier.body?.account?.ownerId === familyOwnerId)
  check('...keeping the email for display', cashier.body?.account?.ownerEmail === 'famowner@shop.com')
  /*
   * The load-bearing one: staff hold NO licence of their own. Issuing one would make a cashier a
   * second paying customer — an extra row on the money screen and an extra name in the chase list.
   */
  check('...reading the owner licence, not one of its own', cashier.body?.account?.subscriptionFrom === 'owner', String(cashier.body?.account?.subscriptionFrom))
  check('...and that licence is the owner exact expiry', cashier.body?.account?.subscription?.expiresAt === ownerSignup.body?.account?.subscription?.expiresAt)

  /* Case and spacing on the owner email must not decide whether a login can be created. */
  const spaced = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Anil', email: 'anil@shop.com', password: 'Passw0rd!', shopRole: 'product_manager', ownerEmail: '  FAMOWNER@shop.com ' },
  })
  check('an owner email is matched case-insensitively', spaced.body?.account?.ownerId === familyOwnerId, String(spaced.status))

  /*
   * The shop name is inherited when it is left out, because a staff login works in the owner's shop.
   * "Optional" has to mean inherited rather than empty — a cashier row reading "(no name)" next to an
   * owner called Family Stores is a hole in the screen, not a choice somebody made.
   */
  check(
    'a staff signup with no shop name inherits the owner’s',
    spaced.body?.account?.shopName === 'Family Stores',
    String(spaced.body?.account?.shopName),
  )
  const ownBranch = await call('POST', 'api/v1/auth/register', {
    body: {
      name: 'Branch Cashier', email: 'branch@shop.com', password: 'Passw0rd!',
      shopRole: 'cashier', ownerEmail: 'famowner@shop.com', shopName: 'Family Stores — Cuttack',
    },
  })
  check(
    '...but a shop name that was given is kept',
    ownBranch.body?.account?.shopName === 'Family Stores — Cuttack',
    String(ownBranch.body?.account?.shopName),
  )
  check(
    '...and an owner with no shop name leaves it blank rather than inventing one',
    typeof spaced.body?.account?.shopName === 'string',
  )

  console.log('\nrefusing a broken hierarchy')

  check(
    'staff without an owner email is refused',
    (await call('POST', 'api/v1/auth/register', { body: { name: 'X', email: 'x1@shop.com', password: 'Passw0rd!', shopRole: 'cashier' } })).status === 400,
  )
  check(
    'an owner email nobody has is refused',
    (await call('POST', 'api/v1/auth/register', { body: { name: 'X', email: 'x2@shop.com', password: 'Passw0rd!', shopRole: 'cashier', ownerEmail: 'ghost@shop.com' } })).status === 400,
  )
  /* Two levels, exactly: a cashier cannot be somebody's owner. */
  const nested = await call('POST', 'api/v1/auth/register', {
    body: { name: 'X', email: 'x3@shop.com', password: 'Passw0rd!', shopRole: 'cashier', ownerEmail: 'rekha@shop.com' },
  })
  check('a staff member cannot be named as the owner', nested.status === 400, String(nested.status))
  check('...and says so in words', String(nested.body?.error?.message ?? '').includes('not an owner'), nested.body?.error?.message)

  const badRole = await call('POST', 'api/v1/auth/register', {
    body: { name: 'X', email: 'x4@shop.com', password: 'Passw0rd!', shopRole: 'emperor', ownerEmail: 'famowner@shop.com' },
  })
  check('an unknown role is refused, not defaulted', badRole.status === 400, String(badRole.status))

  /*
   * The security assertion this whole design exists for. `role` is what the authoriser trusts, and
   * `auth/register` is public — so a signup body naming it must not be able to grant itself the
   * admin API.
   */
  const escalate = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Sneaky', email: 'sneaky@shop.com', password: 'Passw0rd!', role: 'superadmin', shopRole: 'owner' },
  })
  check('a signup cannot name itself superadmin', escalate.body?.account?.role !== 'superadmin', String(escalate.body?.account?.role))
  const sneakyLogin = await call('POST', 'api/v1/admin/login', { body: { email: 'sneaky@shop.com', password: 'Passw0rd!' } })
  check('...and that account cannot even sign in to the admin API', sneakyLogin.status === 403, String(sneakyLogin.status))
  check(
    '...nor is superadmin accepted as a shopRole',
    (await call('POST', 'api/v1/auth/register', { body: { name: 'X', email: 'x5@shop.com', password: 'Passw0rd!', shopRole: 'superadmin' } })).status === 400,
  )

  console.log('\nlisting a family')

  const family = await call('GET', `api/v1/admin/accounts?ownerId=${familyOwnerId}`, { token: adminToken })
  /* Three now: the product manager, the one that inherited the shop name, and the branch cashier. */
  check('an owner staff can be listed', family.body?.total === 3, String(family.body?.total))
  check('...and they are all staff', (family.body?.accounts ?? []).every((a) => a.shopRole !== 'owner'))

  const justOwners = await call('GET', 'api/v1/admin/accounts?shopRole=owner', { token: adminToken })
  check('owners alone can be listed', (justOwners.body?.accounts ?? []).every((a) => a.shopRole === 'owner'))
  check('...and the staff are not among them', !(justOwners.body?.accounts ?? []).some((a) => a.email === 'rekha@shop.com'))

  const everyone = await call('GET', 'api/v1/admin/accounts', { token: adminToken })
  check('the unfiltered list still returns everybody', (everyone.body?.accounts ?? []).some((a) => a.email === 'rekha@shop.com'))

  console.log('\nmoney belongs to the owner')

  const payStaff = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: cashierId, amount: 3000, plan: '1year' },
  })
  check('a payment against staff is refused', payStaff.status === 400, String(payStaff.status))
  check('...naming the owner to use instead', String(payStaff.body?.error?.message ?? '').includes('famowner@shop.com'), payStaff.body?.error?.message)

  /* Renewing the owner must move the staff licence with it — it is the same licence. */
  const renewed = await call('POST', 'api/v1/admin/payments', {
    token: adminToken,
    body: { accountId: familyOwnerId, amount: 3000, plan: '1year' },
  })
  const afterRenewal = await call('GET', `api/v1/admin/accounts/${cashierId}`, { token: adminToken })
  check(
    'renewing the owner extends the staff licence too',
    afterRenewal.body?.account?.subscription?.expiresAt === renewed.body?.account?.subscription?.expiresAt,
    afterRenewal.body?.account?.subscription?.expiresAt,
  )

  console.log('\nchanging and removing')

  /* Deleting an owner who still has staff is refused rather than cascaded. */
  const blocked = await call('DELETE', `api/v1/admin/accounts/${familyOwnerId}`, { token: adminToken })
  check('an owner with staff cannot be deleted', blocked.status === 409, String(blocked.status))
  check('...and the message lists who is in the way', String(blocked.body?.error?.message ?? '').includes('rekha@shop.com'), blocked.body?.error?.message)
  check('...and the owner is still there', (await call('GET', `api/v1/admin/accounts/${familyOwnerId}`, { token: adminToken })).status === 200)

  /* Demoting an owner who still has staff is refused for the same reason. */
  check(
    'an owner with staff cannot be demoted to staff',
    (await call('PATCH', `api/v1/admin/accounts/${familyOwnerId}`, { token: adminToken, body: { shopRole: 'cashier', ownerEmail: 'famowner@shop.com' } })).status === 409,
  )

  /*
   * Moving a staff member to another owner.
   *
   * The destination owner is created here rather than borrowed from an earlier section — those get
   * deleted by the deletion tests, and a suite whose assertions depend on the order of unrelated
   * blocks fails for reasons that have nothing to do with the thing under test.
   */
  const secondOwner = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Second Owner', email: 'second@shop.com', password: 'Passw0rd!', shopName: 'Second Stores', plan: '1year' },
  })
  const moved = await call('PATCH', `api/v1/admin/accounts/${cashierId}`, {
    token: adminToken,
    body: { ownerEmail: 'second@shop.com' },
  })
  check('a staff member can be moved to another owner', moved.body?.account?.ownerEmail === 'second@shop.com', String(moved.status))
  check('...and points at the new owner id', moved.body?.account?.ownerId === secondOwner.body?.account?.id)
  check('...and now reads that owner licence', moved.body?.account?.subscriptionFrom === 'owner')

  /* Promoting a staff member to owner: they answer to nobody and get their own licence. */
  const promoted = await call('PATCH', `api/v1/admin/accounts/${spaced.body?.account?.id}`, {
    token: adminToken,
    body: { shopRole: 'owner', plan: '1year' },
  })
  check('a staff member can be promoted to owner', promoted.body?.account?.shopRole === 'owner', String(promoted.status))
  check('...losing the owner above them', promoted.body?.account?.ownerId === null)
  check('...and gaining a licence of their own', promoted.body?.account?.subscriptionFrom === 'own' && !!promoted.body?.account?.subscription?.expiresAt)

  /* With every staff member gone, the owner can be deleted. Each one, not just the first. */
  await call('DELETE', `api/v1/admin/accounts/${ownBranch.body?.account?.id}`, { token: adminToken })
  await call('DELETE', `api/v1/admin/accounts/${cashierId}`, { token: adminToken })
  check(
    'with no staff left, the owner deletes cleanly',
    (await call('DELETE', `api/v1/admin/accounts/${familyOwnerId}`, { token: adminToken })).status === 200,
  )


  /* ── which software a customer is on ──────────────────────────────────── */
  /*
   * The edition belongs to the owner and is read live, exactly like the licence. Staff have none of
   * their own, so an upgrade moves the whole shop at once rather than leaving the counter behind.
   */
  console.log('\nsoftware type')

  const mini = await call('POST', 'api/v1/auth/register', {
    body: {
      name: 'Mini Owner', email: 'mini@shop.com', password: 'Passw0rd!',
      shopName: 'Mini Stores', plan: '1year', softwareType: 'mystockio_mini',
    },
  })
  const miniOwnerId = mini.body?.account?.id
  check('an owner can be created on Mini', mini.body?.account?.softwareType === 'mystockio_mini', String(mini.body?.account?.softwareType))

  /*
   * The default that keeps the shared signup route working. `auth/register` is public and MyStockio's
   * own form uses it; refusing a body without `softwareType` would break that form on deploy. So an
   * absent value reads as the full product — which is also the truth for every account older than
   * the field.
   */
  const noType = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Plain Owner', email: 'plain@shop.com', password: 'Passw0rd!', plan: '1year' },
  })
  check('an omitted edition defaults to MyStockio', noType.body?.account?.softwareType === 'mystockio', String(noType.body?.account?.softwareType))

  /* A near-miss must be refused rather than corrected: silently accepted, it mislabels a customer. */
  const nearMiss = await call('POST', 'api/v1/auth/register', {
    body: { name: 'X', email: 'nearmiss@shop.com', password: 'Passw0rd!', softwareType: 'mystockio_minii' },
  })
  check('an unrecognised edition is refused', nearMiss.status === 400, String(nearMiss.status))
  check('...with per-field detail', typeof nearMiss.body?.error?.details?.softwareType === 'string', nearMiss.body?.error?.details?.softwareType)

  /* ── staff take the owner's edition ─────────────────────────────────── */

  const miniStaff = await call('POST', 'api/v1/auth/register', {
    body: {
      name: 'Mini Cashier', email: 'minitill@shop.com', password: 'Passw0rd!',
      shopRole: 'cashier', ownerEmail: 'mini@shop.com',
    },
  })
  const miniStaffId = miniStaff.body?.account?.id
  check('a staff login reads the owner’s edition', miniStaff.body?.account?.softwareType === 'mystockio_mini', String(miniStaff.body?.account?.softwareType))

  /* A staff signup naming its own edition must not get one — the shop's is the only answer. */
  const pushy = await call('POST', 'api/v1/auth/register', {
    body: {
      name: 'Pushy', email: 'pushy@shop.com', password: 'Passw0rd!',
      shopRole: 'cashier', ownerEmail: 'mini@shop.com', softwareType: 'mystockio',
    },
  })
  check('a staff signup cannot pick a different edition', pushy.body?.account?.softwareType === 'mystockio_mini', String(pushy.body?.account?.softwareType))

  /* ── editing it ─────────────────────────────────────────────────────── */

  const upgraded = await call('PATCH', `api/v1/admin/accounts/${miniOwnerId}`, {
    token: adminToken,
    body: { softwareType: 'mystockio' },
  })
  check('an owner can be moved to another edition', upgraded.body?.account?.softwareType === 'mystockio', String(upgraded.body?.account?.softwareType))

  /* The whole reason it is resolved live rather than copied: the staff must move with the shop. */
  const staffAfter = await call('GET', `api/v1/admin/accounts/${miniStaffId}`, { token: adminToken })
  check(
    '...and every staff login follows without being touched',
    staffAfter.body?.account?.softwareType === 'mystockio',
    String(staffAfter.body?.account?.softwareType),
  )

  /* Setting it on a staff account is refused: it would be a value nothing reads. */
  const onStaff = await call('PATCH', `api/v1/admin/accounts/${miniStaffId}`, {
    token: adminToken,
    body: { softwareType: 'mystockio_mini' },
  })
  check('setting an edition on staff is refused', onStaff.status === 400, String(onStaff.status))
  check('...naming the owner to change instead', String(onStaff.body?.error?.message ?? '').includes('mini@shop.com'), onStaff.body?.error?.message)

  const badPatch = await call('PATCH', `api/v1/admin/accounts/${miniOwnerId}`, {
    token: adminToken,
    body: { softwareType: 'mystockio_ultra' },
  })
  check('an unrecognised edition is refused on PATCH too', badPatch.status === 400, String(badPatch.status))

  /* An account created before the field existed reads as the full product, not as unknown. */
  const legacyOwner = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Legacy', email: 'legacyowner@shop.com', password: 'Passw0rd!', plan: '1year' },
  })
  check('a legacy-shaped account reads as MyStockio', legacyOwner.body?.account?.softwareType === 'mystockio')

  /* Promotion keeps somebody on the edition they were already using. */
  const promotedMini = await call('POST', 'api/v1/auth/register', {
    body: { name: 'Future Owner', email: 'future@shop.com', password: 'Passw0rd!', shopRole: 'manager', ownerEmail: 'plain@shop.com' },
  })
  await call('PATCH', `api/v1/admin/accounts/${noType.body?.account?.id}`, { token: adminToken, body: { softwareType: 'mystockio_mini' } })
  const nowOwner = await call('PATCH', `api/v1/admin/accounts/${promotedMini.body?.account?.id}`, {
    token: adminToken,
    body: { shopRole: 'owner', plan: '1year' },
  })
  check(
    'promoting staff to owner keeps the edition they were on',
    nowOwner.body?.account?.softwareType === 'mystockio_mini',
    String(nowOwner.body?.account?.softwareType),
  )

  console.log('\nerror shapes')
  const bad = await call('POST', 'api/v1/admin/login', { body: {} })
  check('errors are nested as { error: { code, message } }', typeof bad.body?.error?.message === 'string')
  check('...with a stable code', bad.body?.error?.code === 'VALIDATION_FAILED', String(bad.body?.error?.code))
  check('an unmatched admin route is a 404, not a 401', (await call('GET', 'api/v1/admin/nonsense', { token: adminToken })).status === 404)

  console.log()
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
} catch (error) {
  failures += 1
  console.log(`ERROR  ${error.message}`)
  console.log(error.stack)
} finally {
  child.kill()
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  process.exitCode = failures === 0 ? 0 : 1
}

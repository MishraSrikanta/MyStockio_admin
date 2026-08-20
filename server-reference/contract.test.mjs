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

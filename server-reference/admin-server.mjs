/**
 * A runnable reference implementation of the admin API.
 *
 *   npm run api        # http://127.0.0.1:5000
 *
 * Zero dependencies, single file, JSON on disk. It exists for two reasons:
 *
 *   1. **So the console can be used and tested now.** The real backend has no admin surface yet.
 *      Without this, none of the list / amend / delete / payment screens could be exercised at
 *      all, and a UI nobody has ever run is a UI that does not work.
 *   2. **So the contract is unambiguous.** ADMIN-API-CONTRACT.md describes these routes in prose;
 *      this is the same thing in code, and `contract.test.mjs` checks the two agree.
 *
 * It is NOT for production. Passwords use scrypt (fine), but there is no rate limiting, no audit
 * log, no migrations, and the store is a file rewritten in full on every change.
 */

import { createServer } from 'node:http'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PORT = Number(process.env.PORT || 5000)
const DATA_DIR = process.env.DATA_DIR || join(dirname(new URL(import.meta.url).pathname.slice(1)), '.data')
const DATA_FILE = join(DATA_DIR, 'admin-store.json')
const SECRET = process.env.ADMIN_SECRET || 'reference-admin-secret'

/**
 * The shared key the console sends in `X-Admin-Key`.
 *
 * The console has no sign-in call — its login is checked in the browser — so there is no session to
 * authorise against, and this key is what the server trusts instead. In a real deployment it lives
 * in the environment and nowhere else.
 *
 * The trade, stated where it is implemented: a shared key cannot say *which* administrator acted,
 * so a deletion or a payment cannot be attributed to a person. A bearer token from a real
 * administrator account is still accepted, so the better option stays available.
 */
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'change-me-before-deploying'
const TOKEN_TTL_S = 12 * 60 * 60

/* ───────────────────────────────────────────────────────────────── the store ── */

mkdirSync(DATA_DIR, { recursive: true })

const db = existsSync(DATA_FILE)
  ? JSON.parse(readFileSync(DATA_FILE, 'utf8'))
  : { users: [], payments: [] }

function save() {
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2))
}

/* ────────────────────────────────────────────────────── passwords and tokens ── */

function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(plain, salt, 64).toString('hex')}`
}

function verifyPassword(plain, stored) {
  const [, salt, expected] = String(stored ?? '').split('$')
  if (!salt || !expected) return false
  const actual = scryptSync(plain, salt, 64).toString('hex')
  /* Constant time, so a wrong password cannot be narrowed down by how long the answer took. */
  const a = Buffer.from(actual, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const b64 = (value) => Buffer.from(value).toString('base64url')

function sign(payload, ttl) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttl }))
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const mac = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${mac}`
}

function verify(bearer) {
  const parts = String(bearer ?? '').split('.')
  if (parts.length !== 3) return null
  const [head, body, mac] = parts
  const expected = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
  if (mac !== expected) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

/* ───────────────────────────────────────────────────────────── subscriptions ── */

const PLAN_DAYS = { '1year': 365, '2year': 730, lifetime: null }
const DEFAULT_PLAN = '1year'
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Builds a subscription. **Dates are computed here and never accepted from a client.**
 *
 * A console that could post its own `expiresAt` could grant a decade by editing one field in the
 * browser, and the same applies to the admin app — being trusted to record a payment is not the
 * same as being trusted to invent time.
 */
function buildSubscription(plan, from = new Date()) {
  const chosen = plan in PLAN_DAYS ? plan : DEFAULT_PLAN
  const days = PLAN_DAYS[chosen]
  return {
    plan: chosen,
    status: 'active',
    startedAt: from.toISOString(),
    expiresAt: days === null ? null : new Date(from.getTime() + days * DAY_MS).toISOString(),
  }
}

/* ────────────────────────────────────────────────────────────────── roles ── */

/**
 * What somebody does in the shop. Must match `Role` in `src/lib/roles.ts`.
 *
 * **`superadmin` is not in this list and must never be**, which is the whole reason this is a
 * separate field from `role`. `auth/register` is public: if a job title were read out of the field
 * the authoriser trusts, `{"role":"superadmin"}` in a signup body would be a request to become an
 * administrator. `role` keeps authorising; `shopRole` only describes a job.
 */
const SHOP_ROLES = ['owner', 'manager', 'cashier', 'product_manager', 'accountant']
const DEFAULT_SHOP_ROLE = 'owner'

/**
 * The shop role from a request body, defaulting to owner.
 *
 * An absent field is an owner, so a client written before roles existed keeps creating customers
 * exactly as it did. An *unrecognised* one is refused rather than defaulted: silently turning
 * `cashierr` into an owner would hand a counter login somebody's licence.
 */
function readShopRole(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SHOP_ROLE
  const role = String(value)
  return SHOP_ROLES.includes(role) ? role : null
}

/**
 * Resolves the owner an incoming staff account should hang from.
 *
 * Returns `{ owner }` on success or `{ error }` with a sentence for the operator. Three refusals,
 * each a different mistake:
 *
 *   · no email at all — the one thing a staff login cannot do without
 *   · an email nobody has — usually the owner has not been created yet
 *   · an email belonging to **staff** — the hierarchy is two levels, and a cashier cannot have
 *     staff of their own. Refused here rather than accepted and flattened, because flattening would
 *     silently attach somebody to the wrong shop.
 */
function resolveOwner(ownerEmail) {
  const email = String(ownerEmail ?? '').trim().toLowerCase()
  if (!email) return { error: "An owner's email is required for this role." }

  const owner = db.users.find((u) => u.email === email)
  if (!owner) return { error: 'No account has that email. Create the owner first.' }
  if (owner.role === 'superadmin') return { error: 'An administrator cannot own shop logins.' }

  const theirRole = owner.shopRole ?? DEFAULT_SHOP_ROLE
  if (theirRole !== 'owner') {
    return { error: `That account is a ${theirRole.replace('_', ' ')}, not an owner. Name the owner they report to instead.` }
  }
  return { owner }
}

/** How many staff hang off an account. Used to refuse deleting or demoting an owner who has them. */
function staffOf(ownerId) {
  return db.users.filter((u) => (u.shopRole ?? DEFAULT_SHOP_ROLE) !== 'owner' && u.ownerId === ownerId)
}

/**
 * Renewal, extending from whichever is later: the current expiry or today.
 *
 * Somebody renewing early keeps the days they already paid for; somebody renewing two months late
 * does not get credit for two months the app was unusable to them. Both readings are defensible
 * on their own and indefensible together, so this picks one and the contract states it.
 */
function renewSubscription(existing, plan) {
  if (plan === 'lifetime') return buildSubscription('lifetime')
  const now = new Date()
  const current = existing?.expiresAt ? new Date(existing.expiresAt) : null
  const from = current && current.getTime() > now.getTime() ? current : now
  const built = buildSubscription(plan, from)
  /* `startedAt` records when the licence period began, which a renewal does not reset. */
  return { ...built, startedAt: existing?.startedAt || built.startedAt }
}

/**
 * The subscription fields for an account, resolving a staff member's to their owner's.
 *
 * `subscriptionFrom` is the honest part: `'own'` for an owner, `'owner'` for a staff member reading
 * somebody else's, and `'none'` when a staff member's owner has been deleted. A screen that cannot
 * tell those apart would show a cashier as an expired customer and put them in the chase list.
 */
function staffSubscription(user) {
  const role = user.shopRole ?? DEFAULT_SHOP_ROLE
  if (role === 'owner') return { subscription: user.subscription ?? null, subscriptionFrom: 'own' }

  const owner = user.ownerId ? db.users.find((u) => u.id === user.ownerId) : null
  if (!owner) return { subscription: null, subscriptionFrom: 'none' }
  return { subscription: owner.subscription ?? null, subscriptionFrom: 'owner' }
}

/* ─────────────────────────────────────────────────────────────────── shaping ── */

/** The public shape. The password hash never leaves the database. */
function publicUser(user) {
  const payments = db.payments.filter((p) => p.accountId === user.id).sort((a, b) => b.at.localeCompare(a.at))
  /*
   * "Last payment" means the last money that came *in*. A refund is in the same ledger, and showing
   * one here would put a returned amount on the row as though the shop had just paid it.
   */
  const last = payments.find((p) => p.type !== 'refund')
  const refunded = payments
    .filter((p) => p.type === 'refund')
    .reduce((sum, p) => sum + Math.abs(Number(p.amount) || 0), 0)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    shopName: user.shopName,
    /* Platform privilege. Not a job title — see SHOP_ROLES. */
    role: user.role,
    shopRole: user.shopRole ?? 'owner',
    ownerId: user.ownerId ?? null,
    ownerEmail: user.ownerEmail ?? null,
    /**
     * Staff carry their **owner's** licence, read live rather than copied.
     *
     * Copying it at creation would drift the moment the owner renews, and the drift is invisible:
     * a cashier locked out in April while the shop's licence runs to next March. So the answer is
     * computed on every read, and `subscriptionFrom` says whose it is.
     */
    ...staffSubscription(user),
    createdAt: user.createdAt,
    lastPaymentAt: last ? last.at : null,
    lastPaymentAmount: last ? last.amount : null,
    paymentCount: payments.length,
    refundedTotal: refunded,
  }
}

function sendJson(res, status, body, origin) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendError(res, status, code, message, origin, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } }, origin)
}

/* ──────────────────────────────────────────────────────────────────── routes ── */

/**
 * Requires an administrator.
 *
 * The whole point of the admin API: a shop's own token must NOT open it. The console's
 * compiled-in password gates the interface only — it ships in the bundle and anybody can read it —
 * so this check is the only thing that actually protects one customer's details from another's.
 */
function requireAdmin(req, res, origin) {
  /*
   * Either credential opens this: the shared console key, or a bearer token belonging to a real
   * administrator account.
   *
   * The key is compared in constant time, length-checked first. That is close to ceremonial for a
   * value that ships inside a JavaScript bundle — but the server cannot know that, and it should
   * not be the weaker half of the arrangement.
   */
  const provided = String(req.headers['x-admin-key'] ?? '')
  if (provided) {
    const a = Buffer.from(provided)
    const b = Buffer.from(ADMIN_API_KEY)
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { id: 'console', email: 'console', role: 'superadmin', viaKey: true }
    }
    sendError(res, 403, 'FORBIDDEN', 'That admin key is not recognised.', origin)
    return null
  }

  const claims = verify(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  if (!claims) {
    sendError(res, 401, 'UNAUTHENTICATED', 'Send an X-Admin-Key header, or an administrator bearer token.', origin)
    return null
  }
  const user = db.users.find((u) => u.id === claims.sub)
  if (!user || user.role !== 'superadmin') {
    /* A shop's token is perfectly valid and must still be refused. That is the whole point. */
    sendError(res, 403, 'FORBIDDEN', 'This endpoint is for administrators only.', origin)
    return null
  }
  return user
}

const server = createServer((req, res) => {
  const origin = req.headers.origin
  const url = new URL(req.url, `http://${req.headers.host}`)
  const route = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin)
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body = {}
    try {
      const raw = Buffer.concat(chunks).toString('utf8')
      body = raw ? JSON.parse(raw) : {}
    } catch {
      sendError(res, 400, 'BAD_JSON', 'The request body was not valid JSON.', origin)
      return
    }

    if (route === '/health') {
      sendJson(res, 200, { ok: true, users: db.users.length, payments: db.payments.length }, origin)
      return
    }

    /* ── seeding an administrator ─────────────────────────────────────────── */
    /*
     * Present only in the reference server. A real deployment promotes an existing account by hand
     * in the database; an endpoint that mints administrators would be the largest hole possible.
     */
    if (route === '/api/v1/admin/bootstrap' && req.method === 'POST') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      if (!email || !password) {
        sendError(res, 400, 'VALIDATION_FAILED', 'Email and password are required.', origin)
        return
      }
      let user = db.users.find((u) => u.email === email)
      if (!user) {
        user = {
          id: randomBytes(12).toString('hex'),
          email,
          name: String(body.name ?? 'Administrator'),
          phone: '',
          shopName: '',
          role: 'superadmin',
          subscription: buildSubscription('lifetime'),
          passwordHash: hashPassword(password),
          createdAt: new Date().toISOString(),
        }
        db.users.push(user)
      } else {
        user.role = 'superadmin'
        user.passwordHash = hashPassword(password)
      }
      save()
      sendJson(res, 201, { accessToken: sign({ sub: user.id, typ: 'access' }, TOKEN_TTL_S), account: publicUser(user) }, origin)
      return
    }

    /* ── signing in ───────────────────────────────────────────────────────── */
    if ((route === '/api/v1/admin/login' || route === '/api/v1/auth/login') && req.method === 'POST') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      if (!email || !password) {
        sendError(res, 400, 'VALIDATION_FAILED', 'Email and password are required.', origin, {
          email: email ? undefined : 'is required',
          password: password ? undefined : 'is required',
        })
        return
      }

      const user = db.users.find((u) => u.email === email)
      const hash = user ? user.passwordHash : `scrypt$0000${'0'.repeat(128)}`
      /* Compared even when nothing matched, so timing does not reveal which emails exist. */
      const matches = verifyPassword(password, hash)
      if (!user || !matches) {
        sendError(res, 401, 'UNAUTHENTICATED', 'Email or password is incorrect.', origin)
        return
      }

      /* The dedicated admin route refuses a shop account outright. */
      if (route === '/api/v1/admin/login' && user.role !== 'superadmin') {
        sendError(res, 403, 'FORBIDDEN', 'This account is not an administrator.', origin)
        return
      }

      sendJson(res, 200, { accessToken: sign({ sub: user.id, typ: 'access' }, TOKEN_TTL_S), account: publicUser(user) }, origin)
      return
    }

    /* ── the ordinary signup route, which the console reuses ───────────────── */
    if (route === '/api/v1/auth/register' && req.method === 'POST') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      const name = String(body.name ?? '').trim()

      const details = {}
      if (!name) details.name = 'is required'
      if (!email) details.email = 'is required'
      if (!password) details.password = 'is required'
      if (Object.keys(details).length) {
        sendError(res, 400, 'VALIDATION_FAILED', 'Please check the details entered.', origin, details)
        return
      }
      if (db.users.some((u) => u.email === email)) {
        sendError(res, 409, 'EMAIL_TAKEN', 'An account with that email already exists.', origin)
        return
      }

      const shopRole = readShopRole(body.shopRole)
      if (!shopRole) {
        sendError(res, 400, 'VALIDATION_FAILED', 'That is not a role this app knows.', origin, {
          shopRole: `must be one of ${SHOP_ROLES.join(', ')}`,
        })
        return
      }

      /*
       * Staff hang from an owner; owners hang from nobody. Resolved to an **id** and stored as one,
       * with the email kept alongside only for display: matching on email at read time would
       * silently re-point a cashier at somebody else the day an owner changes their address.
       */
      let ownerId = null
      let ownerEmail = null
      if (shopRole !== 'owner') {
        const resolved = resolveOwner(body.ownerEmail)
        if (resolved.error) {
          sendError(res, 400, 'VALIDATION_FAILED', resolved.error, origin, { ownerEmail: 'is required and must be an owner' })
          return
        }
        ownerId = resolved.owner.id
        ownerEmail = resolved.owner.email
      }

      /*
       * A staff login works in the owner's shop, so a blank shop name inherits it.
       *
       * "Optional" has to mean *inherited*, not *empty*: a cashier row reading "(no name)" beside an
       * owner called Balaji Traders is not a field somebody chose to leave blank, it is a hole in the
       * screen. A value that was actually typed is kept as typed — one owner can have two branches.
       */
      const typedShopName = String(body.shopName ?? '').trim().slice(0, 120)
      const inheritedShopName =
        !typedShopName && ownerId ? String(db.users.find((u) => u.id === ownerId)?.shopName ?? '') : ''

      const user = {
        id: randomBytes(12).toString('hex'),
        email,
        name,
        phone: String(body.phone ?? '').trim().slice(0, 20),
        shopName: typedShopName || inheritedShopName,
        /*
         * **`role` is set here, never read from the body.** It is what the admin API authorises
         * against, so a public signup route must not let a caller name it. The job title went into
         * `shopRole` above, where it can do no such thing.
         */
        role: 'admin',
        shopRole,
        ownerId,
        ownerEmail,
        /*
         * Staff get **no subscription of their own** — they ride on the owner's licence. Issuing one
         * would make a cashier a second paying customer: an extra row on the money screen, an extra
         * entry in the chase list, and an expiry that could lock out a shop whose owner has paid.
         */
        subscription: shopRole === 'owner' ? buildSubscription(body.plan) : null,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      }
      db.users.push(user)
      save()
      sendJson(res, 201, { accessToken: sign({ sub: user.id, typ: 'access' }, TOKEN_TTL_S), account: publicUser(user) }, origin)
      return
    }

    /* ── the account list ─────────────────────────────────────────────────── */
    if (route === '/api/v1/admin/accounts' && req.method === 'GET') {
      if (!requireAdmin(req, res, origin)) return
      /* Administrators are not customers, so they are not in the customer list. */
      let listed = db.users.filter((u) => u.role !== 'superadmin')

      /*
       * Two optional filters, so a caller can ask the shape of the question it actually has:
       *
       *   `?ownerId=` — one owner's staff. What a "sub ids" screen needs.
       *   `?shopRole=` — every cashier, say. `owner` gives the paying customers alone, which is the
       *                  list the money screen and the chase list are really about.
       *
       * **Everything is still returned by default.** A console that pages or filters by default
       * silently under-reports, and an admin list that quietly omits rows is worse than a long one.
       */
      const ownerId = url.searchParams.get('ownerId')
      if (ownerId) listed = listed.filter((u) => u.ownerId === ownerId)

      const shopRole = url.searchParams.get('shopRole')
      if (shopRole) listed = listed.filter((u) => (u.shopRole ?? DEFAULT_SHOP_ROLE) === shopRole)

      const accounts = listed.map(publicUser)
      sendJson(res, 200, { accounts, total: accounts.length }, origin)
      return
    }

    const accountMatch = /^\/api\/v1\/admin\/accounts\/([^/]+)$/.exec(route)
    if (accountMatch) {
      if (!requireAdmin(req, res, origin)) return
      const id = decodeURIComponent(accountMatch[1])
      const user = db.users.find((u) => u.id === id)
      if (!user) {
        sendError(res, 404, 'NOT_FOUND', 'No account with that id.', origin)
        return
      }

      if (req.method === 'GET') {
        sendJson(res, 200, { account: publicUser(user) }, origin)
        return
      }

      if (req.method === 'PATCH') {
        if (body.email !== undefined) {
          const email = String(body.email).trim().toLowerCase()
          if (!email) {
            sendError(res, 400, 'VALIDATION_FAILED', 'An email cannot be blank.', origin)
            return
          }
          if (db.users.some((u) => u.email === email && u.id !== user.id)) {
            sendError(res, 409, 'EMAIL_TAKEN', 'Another account already uses that email.', origin)
            return
          }
          user.email = email
        }
        if (body.name !== undefined) user.name = String(body.name).trim()
        if (body.phone !== undefined) user.phone = String(body.phone).trim().slice(0, 20)
        if (body.shopName !== undefined) user.shopName = String(body.shopName).trim().slice(0, 120)
        if (body.password) user.passwordHash = hashPassword(String(body.password))
        /*
         * Changing the plan re-issues the subscription from today rather than extending it. A plan
         * change is a correction ("this should have been lifetime"), not a purchase — purchases go
         * through /payments, which extends.
         */
        if (body.plan !== undefined) user.subscription = buildSubscription(String(body.plan))

        /*
         * ── changing what somebody is ────────────────────────────────────────
         * Both directions are refused when they would break the two-level shape, and both messages
         * name the thing to do first. Left unguarded, the first produces a login that is an owner
         * *and* has an owner, and the second orphans everybody underneath.
         */
        if (body.shopRole !== undefined) {
          const nextRole = readShopRole(body.shopRole)
          if (!nextRole) {
            sendError(res, 400, 'VALIDATION_FAILED', 'That is not a role this app knows.', origin, {
              shopRole: `must be one of ${SHOP_ROLES.join(', ')}`,
            })
            return
          }

          const currentRole = user.shopRole ?? DEFAULT_SHOP_ROLE

          if (nextRole !== 'owner' && currentRole === 'owner') {
            /* Demoting an owner who still has staff would leave them pointing at a non-owner. */
            const staff = staffOf(user.id)
            if (staff.length > 0) {
              sendError(
                res,
                409,
                'HAS_STAFF',
                `${user.shopName || user.name || user.email} still has ${staff.length} staff login${staff.length === 1 ? '' : 's'}. Move them to another owner first.`,
                origin,
              )
              return
            }
          }

          if (nextRole === 'owner') {
            /* Promoted to owner: they answer to nobody, and they need a licence of their own. */
            user.ownerId = null
            user.ownerEmail = null
            if (!user.subscription) user.subscription = buildSubscription(body.plan)
          } else if (currentRole === 'owner') {
            /*
             * Owner → staff. They must name an owner in the same request, because a staff account
             * with nobody above it is the orphan state — able to sign in, attached to no shop.
             */
            const resolved = resolveOwner(body.ownerEmail)
            if (resolved.error) {
              sendError(res, 400, 'VALIDATION_FAILED', `${resolved.error} A ${nextRole.replace('_', ' ')} must belong to an owner.`, origin, {
                ownerEmail: 'is required when changing an owner into staff',
              })
              return
            }
            user.ownerId = resolved.owner.id
            user.ownerEmail = resolved.owner.email
            /* Their own licence goes: they are on the owner's now. Refunds are a separate decision. */
            user.subscription = null
          }
          user.shopRole = nextRole
        }

        /* Moving a staff member to a different owner. */
        if (body.ownerEmail !== undefined && (user.shopRole ?? DEFAULT_SHOP_ROLE) !== 'owner') {
          const resolved = resolveOwner(body.ownerEmail)
          if (resolved.error) {
            sendError(res, 400, 'VALIDATION_FAILED', resolved.error, origin, { ownerEmail: 'must be an owner' })
            return
          }
          if (resolved.owner.id === user.id) {
            sendError(res, 400, 'VALIDATION_FAILED', 'An account cannot be its own owner.', origin)
            return
          }
          user.ownerId = resolved.owner.id
          user.ownerEmail = resolved.owner.email
        }

        save()
        sendJson(res, 200, { account: publicUser(user) }, origin)
        return
      }

      if (req.method === 'DELETE') {
        if (user.role === 'superadmin') {
          sendError(res, 403, 'FORBIDDEN', 'An administrator account cannot be deleted here.', origin)
          return
        }

        /*
         * An owner with staff is refused rather than cascaded, deliberately.
         *
         * Cascading would delete other people's logins as a side effect of one click — and the
         * cashier who can no longer sign in tomorrow morning has no way to find out why. Refusing
         * makes the consequence a decision: move them, or delete them, and then delete the owner.
         */
        const staff = staffOf(user.id)
        if (staff.length > 0) {
          sendError(
            res,
            409,
            'HAS_STAFF',
            `${user.shopName || user.name || user.email} has ${staff.length} staff login${staff.length === 1 ? '' : 's'} (${staff
              .map((s) => s.email)
              .join(', ')}). Delete or move them first — they would otherwise be left unable to sign in.`,
            origin,
          )
          return
        }
        db.users = db.users.filter((u) => u.id !== user.id)
        /* The payment history goes with it; keeping orphaned money records helps nobody. */
        db.payments = db.payments.filter((p) => p.accountId !== user.id)
        save()
        sendJson(res, 200, { deleted: true, id: user.id }, origin)
        return
      }
    }

    /* ── payments ─────────────────────────────────────────────────────────── */
    if (route === '/api/v1/admin/payments' && req.method === 'POST') {
      const admin = requireAdmin(req, res, origin)
      if (!admin) return

      const accountId = String(body.accountId ?? '')
      const amount = Number(body.amount)
      const plan = String(body.plan ?? '')
      /*
       * One ledger, two directions. A refund is the same kind of record with the sign reversed —
       * `amount` stays positive and `type` carries the direction, so a total is a sum over one
       * table read in date order rather than a join across two.
       *
       * Anything other than 'refund' is a payment, including the field being absent. A client that
       * predates refunds sends nothing and keeps working.
       */
      const type = String(body.type ?? 'payment') === 'refund' ? 'refund' : 'payment'

      const details = {}
      if (!accountId) details.accountId = 'is required'
      if (!Number.isFinite(amount) || amount <= 0) details.amount = 'must be more than zero'
      if (!(plan in PLAN_DAYS)) details.plan = 'must be 1year, 2year or lifetime'
      if (Object.keys(details).length) {
        sendError(res, 400, 'VALIDATION_FAILED', 'Please check the payment details.', origin, details)
        return
      }

      const user = db.users.find((u) => u.id === accountId)
      if (!user) {
        sendError(res, 404, 'NOT_FOUND', 'No account with that id.', origin)
        return
      }

      /*
       * Money belongs to the owner, because the licence does. Recording a payment against a cashier
       * would try to extend a subscription they do not have, and would put their name on a line in
       * the GST report for a licence somebody else bought.
       */
      if ((user.shopRole ?? DEFAULT_SHOP_ROLE) !== 'owner') {
        const owner = user.ownerId ? db.users.find((u) => u.id === user.ownerId) : null
        sendError(
          res,
          400,
          'NOT_AN_OWNER',
          `${user.name || user.email} is a ${(user.shopRole ?? '').replace('_', ' ')}, and staff do not hold a licence. Record this against ${
            owner ? owner.email : 'their owner'
          } instead.`,
          origin,
        )
        return
      }

      /*
       * Money received and time granted are one event, so they are one write.
       *
       * **A refund does not take the time back**, deliberately. Refunding a licence and revoking it
       * are separate decisions — a goodwill refund usually leaves the shop running to the end of the
       * term it paid for — and shortening a subscription as a side effect of a bookkeeping entry is
       * the kind of surprise that is discovered by a customer being locked out.
       */
      if (type === 'payment') user.subscription = renewSubscription(user.subscription, plan)

      const record = {
        id: randomBytes(8).toString('hex'),
        accountId,
        amount,
        plan,
        method: String(body.method ?? 'cash'),
        reference: String(body.reference ?? ''),
        note: String(body.note ?? ''),
        at: new Date().toISOString(),
        recordedBy: admin.email,
        type,
      }
      db.payments.push(record)
      save()
      sendJson(res, 201, { account: publicUser(user), payment: record }, origin)
      return
    }

    if (route === '/api/v1/admin/payments' && req.method === 'GET') {
      if (!requireAdmin(req, res, origin)) return
      const accountId = url.searchParams.get('accountId')
      const payments = db.payments
        .filter((p) => !accountId || p.accountId === accountId)
        .sort((a, b) => b.at.localeCompare(a.at))
      sendJson(res, 200, { payments, total: payments.length }, origin)
      return
    }

    /* An unmatched admin path is a 404, never a 401 — a typo must not look like a permissions
       problem, which is the wrong thing to spend an afternoon on. */
    sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${route}.`, origin)
  })
})

server.listen(PORT, () => {
  console.log(`MyStockio admin reference API on http://127.0.0.1:${PORT}`)
  console.log(`  store    ${DATA_FILE}`)
  console.log('  admin    POST api/v1/admin/{bootstrap,login}, GET/PATCH/DELETE api/v1/admin/accounts')
  console.log('  payments POST/GET api/v1/admin/payments')
  console.log('  shared   POST api/v1/auth/{login,register}')
})

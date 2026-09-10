# MyStockio Admin

The vendor-side console. Every customer account in one table: who they are, what they pay for, how
long they have left, who needs chasing, and who has just paid.

Separate project, separate folder, separate port. It shares no files with MyStockio or MyCodeScan —
it only calls the same HTTP API — so nothing here can affect either of them.

```bash
npm install
npm run dev        # http://localhost:5177
```

## Trying it before the backend is ready

The account list, edits, deletions and payments need endpoints the current backend does not have
yet (see `ADMIN-API-CONTRACT.md` §1). A runnable reference implementation ships with this project so
the console can be used and tested today:

```bash
npm run api        # the reference API on http://127.0.0.1:5000
```

Sign in with an administrator account the backend knows. Nothing needs seeding in this app — on the
reference server, mint one with `POST api/v1/admin/bootstrap`; against the real backend, use the
account you promoted there. `ADMIN_API_KEY` in `src/lib/config.ts` is an alternative the reference
server also accepts.

**Creating an account works against the real backend already** — it goes through the ordinary
`api/v1/auth/register` route, the same one MyStockio's signup form uses, so a customer created here
can sign into MyStockio immediately.

## Signing in

**The server decides.** An email and a password go to `POST api/v1/admin/login`, and its answer is
the whole of it: a token means an administrator is signed in, and every admin request carries that
token.

There is **no list of credentials in this app**. Administrators are added, changed and revoked in the
backend, with no rebuild and no deployment. Whoever the backend accepts, the console accepts.

That is a real improvement over what was here before, and worth being precise about why. This app
previously held id/password pairs and compared them in the browser. A credential compiled into a
bundle is readable by anyone who can load the page — View Source, or one look at the network tab — so
it only ever stopped somebody who was not looking. **A password only the server knows cannot be
extracted from a page at all.**

The three failures are reported apart, because they have different fixes:

| Answer | Means | The fix |
| --- | --- | --- |
| **401** | those credentials are wrong | retype them |
| **403** | the account is real but is not an administrator | promote it in the backend; retyping never helps |
| **network / timeout** | nothing was decided | the server is down or unreachable — the password may be perfectly good |

The token lives in `sessionStorage`, so **closing the tab signs you out**. When it expires the
console returns to this screen, which is now the correct response: signing in again mints a new one.

`ADMIN_API_KEY` in `src/lib/config.ts` remains as an `X-Admin-Key` fallback for the bundled reference
server. **Leave it empty for the real backend** — not caution, but because its CORS reply allows
`Authorization` and `Content-Type` and nothing else, so the browser fails the preflight and the
request dies unsent.

One loose end worth knowing: `SIGNUP_ACCESS_KEY` in `src/lib/access.ts` is still in the bundle, and
has to be — it is the `developerCode` the shared `api/v1/auth/register` route checks, and it must
match MyStockio's copy. It is not a login. But if any administrator password on the server is still
the same string as that invite code, change the password: the code is readable in the bundle, and
reusing it would hand back exactly the exposure this change removed.

## What it does

- **Accounts** — one row per customer: shop, user id, phone, plan, time left, expiry, last payment.
  Sorted most-urgent-first by default, because that is why the screen gets opened.
- **Counters** — all / to chase / expired / expiring / active / lifetime, each one a filter. Also
  how many of the chase list have **no usable phone number**, so the gap is visible instead of the
  count quietly overstating what can be done.
- **Create** — an owner with a plan and a software edition, or a staff login (cashier, product
  manager, …) under an owner. The server sets the dates; an expiry cannot be typed.
- **Amend** — shop name, owner, user id (email), phone, password. A changed password works at once.
- **Payments** — amount, plan, method and reference in one action that also renews the licence, plus
  a WhatsApp receipt.
- **Chasing** — a written reminder per account and a `wa.me` link that opens WhatsApp with it
  filled in. Free: your own WhatsApp sends it, no Business API and no per-message charge.
- **Delete** — permanent, and it asks for the shop name to be typed rather than an "are you sure",
  because a confirm dialog gets dismissed by reflex.

### Roles, owners and staff

**`Role` in `src/lib/roles.ts`** — `owner`, `manager`, `cashier`, `product_manager`, `accountant`.

Creating a login asks for the role **first**, because it decides what the rest of the form asks:

| Chosen | The form shows | The form hides |
| --- | --- | --- |
| **Owner** | a subscription plan | the owner field — they have nobody above them |
| anything else | the owner's email, required | the plan — staff ride on the owner's licence |

**Picking the owner fills in the shop name.** A staff login works in that shop, so it takes the
owner's shop name along with their plan and expiry — the three things it does not own. The field
stays editable for the branch case, and a name typed by hand is never overwritten afterwards; left
blank, the server uses the owner's.

The owner is picked from the accounts already loaded, or typed if they are not in the list. Either
way the **email** is what gets sent: the server resolves it and is the authority on whether it exists
and is really an owner, so a stale list cannot attach somebody to the wrong shop.

In the table, an owner's row carries `3 staff` and an expander. Their people sit underneath it,
collapsed by default, with their roles and whose licence they are on. `+ add staff` on the row opens
the create form already pointed at that owner. Searching or the **Staff logins** filter lifts staff
to the top level, because a row nobody can reach is worse than a row in the wrong place.

**Two levels, exactly.** Staff cannot have staff — an owner-email pointing at a cashier is refused
here *and* by the server, which is the check that counts.

#### What this deliberately does not do

- **Staff hold no licence.** They read their owner's, resolved live (`subscriptionFrom` says whose).
  Copying it at creation would drift the moment the owner renews, and the drift is invisible: a
  cashier locked out in April while the shop is paid up to next March.
- **Staff are counted apart from every figure on the screen.** An owner with three staff is *one*
  customer, one licence, one row to chase. Folding them in would read as four.
- **Payments belong to the owner.** The server answers `400` for a payment against staff, so the
  drawer does not offer the form.
- **No permission enforcement.** `ROLE_NOTE` describes what each role is *for*; nothing here decides
  what a cashier may do. That belongs in the shop app — a permission matrix in this console would
  read as an authorisation model while enforcing nothing.

#### `role` is not `shopRole`, on purpose

`role` is **platform privilege** (`admin` / `superadmin`) and is what the server authorises against.
`shopRole` is a **job**. They are separate fields because `api/v1/auth/register` is public: if a job
title were read out of the field the authoriser trusts, `{"role":"superadmin"}` in a signup body
would be a request to become an administrator. The contract test asserts that a signup naming `role`
does not get it, that the account is then refused by `admin/login` with 403, and that
`shopRole: "superadmin"` is a 400.

### Which software: MyStockio or MyStockio Mini

`SoftwareType` in `src/lib/software.ts` — `mystockio` or `mystockio_mini`.

**Required on the create form for an owner, and nothing is pre-selected.** Which edition a shop
bought is a commercial fact the app cannot infer, and a guess surfaces months later as a support call
about a feature they never had.

**Change it any time** from an owner's drawer — an upgrade from Mini, or a correction. The edition
shows in the table under the plan (Mini in amber, since it is the exception), and the filter dropdown
has *On MyStockio* / *On MyStockio Mini* for answering "who is on what".

**Staff take the owner's**, like the shop name and the licence. They are not asked, and the server
refuses to store one on a staff row — it would be a value nothing reads. Change it on the owner and
every login under them follows in the same instant, because it is resolved live rather than copied.

An account created before this field existed reads as **MyStockio**: Mini came later, so a missing
value is history rather than a gap.

### The money screen

The **Money** tab beside Accounts. One period filter — last 12 months, this financial year, all time
— and everything on the screen follows it.

- **Add payment** works money-first: type the amount, then find the shop. The per-account form in the
  drawer stays, because when somebody has just paid *that* is the quicker route. This one also
  records **refunds**, which the drawer cannot.
- **Net revenue** leads, with collected, refunded, taxable value and GST payable beside it.
- **Charts** — money by month against its own refunds, cumulative revenue, revenue by plan, how they
  paid, the customer base by state, entries per month. Every one has a **Table** toggle showing the
  same figures, so nothing is only available by looking.
- **GST report** — a printable summary; **Save as PDF** goes through the browser's own print dialog,
  and **CSV** downloads the ledger for an accountant to re-add.

Three things it deliberately will not do:

| It says | Rather than | Because |
| --- | --- | --- |
| Profit: **—**, "no costs configured" | showing net revenue as profit | profit is revenue minus costs, and nothing here knows the costs. Set `MONTHLY_COSTS` in `src/lib/config.ts` and the figure, the margin and the loss warning all start working. |
| Lapsed licences: **≈₹8,000** | a booked loss | it prices expired accounts at today's rate for their plan, which is not what they paid. An estimate of revenue *not* collected, kept apart from refunds, which are a fact. |
| "not a tax invoice" on the report | looking like a filing | tax invoices are per sale, serially numbered, and carry the customer's GSTIN. A document that looks like one and is not is the expensive kind of wrong. |

**GST is treated as inclusive**: ₹3,000 is ₹2,542.37 of value plus ₹457.63 of tax, not ₹3,000 plus
₹540. That reading is the difference between a correct return and one overstating revenue by 18%, so
it is one constant — `GST_INCLUSIVE` — asserted in the tests and printed on the report itself. Tax is
computed on money **kept**, so a refund takes its GST back out with it.

Fill in `BUSINESS` in `src/lib/config.ts` before sending the report anywhere. `gstin` is blank by
default and prints as a visible *— not set —* rather than being quietly omitted.

## Tests

```bash
npm test           # the API contract, then the pure logic
npm run test:api   # the reference server against ADMIN-API-CONTRACT.md
npm run test:lib   # subscription arithmetic, money, reminders, filtering
```

Three things get the most attention, because each would cost real money:

- **A lifetime account must never look expired.** `expiresAt: null` is not "long ago". Treating it
  as such would put every lifetime customer in the chase list and demand money for something they
  own outright.
- **A shop's token must not open the admin API.** Asserted with a real, valid customer token —
  which authenticates perfectly and still has to be refused.
- **The GST split must add back up to the total, and a refund must take its tax with it.** Both are
  checked across a spread of awkward amounts, because these figures go onto a return: two
  independently-rounded halves drift a paisa from their own total, and a refund that reduces revenue
  but not the liability overstates what is owed.

## Deployment

`npm run build` runs `tsc --noEmit && vite build`. **A test file cannot fail a deployment**, and
three separate things have to hold for that to stay true:

1. **The build does not run the tests.** `npm test` is something a person runs. No `postinstall`,
   `prepare` or `prebuild` hook runs one either — those fire on Vercel *before* the build, where a
   failing assertion about arithmetic would be an even more confusing red deployment.
2. **`tsc` cannot see them.** `tsconfig.json` keeps `include` to `src` and `vite.config.ts`, and
   excludes `scripts`, `server-reference` and every test shape — `*.test.*` **and** `*.spec.*`, in
   `.ts`, `.mts`, `.tsx`, `.js` and `.mjs`, plus `__tests__/`. The list covers shapes that do not
   exist yet, because the one that gets added later is the one that breaks the build.
3. **Nothing in `src` imports them.** This is what actually keeps test code out of the shipped
   JavaScript: Vite bundles by following imports, so a file nothing imports is not in the output.

> **`.vercelignore` is not one of those three.** It applies to CLI uploads (`vercel deploy`); a
> deployment triggered from Git clones the whole repository, so `scripts/` and `server-reference/`
> *are* present in that build environment. They still cannot break it — because of the three points
> above. The ignore file keeps a CLI upload small; the exclusions are what keep the build green.

All three are asserted in `scripts/tests/deployment.test.mts`, so widening `include`, adding a test
to the build script, or importing a suite from `src` now fails `npm test` instead of a deployment.

Verified empirically as well: a deliberately invalid `.test.mts` in `scripts/tests` **and** a broken
`.test.ts` inside `src/lib` were both present while `npm run build` succeeded, and the built bundle
contains no test, suite-runner or reference-server strings.

`vercel.json` sends `X-Robots-Tag: noindex, nofollow` for every path. An internal console has no
business in a search index.

## Where the backend is

`src/lib/config.ts`, two constants, the same arrangement as MyStockio:

```ts
// const PROD_BASE = "https://financegpt-backend-phm6.onrender.com/";
// const DEV_BASE = "https://financegpt-backend-phm6.onrender.com/";
const PROD_BASE = "http://localhost:5000/"; // a production build
const DEV_BASE = "http://localhost:5000/"; // vite dev
```

`vite dev` uses `DEV_BASE` and a build uses `PROD_BASE`. Override either without touching the source
using `VITE_API_ENV=dev|prod`, or point one build anywhere with `VITE_API_BASE_URL`.

## The endpoints

Declared in `APIEndpoint` in the same file, in two groups because they are at different stages.

**Shared with MyStockio** — `api/v1/auth/register`, `login`, `me`. Creating a customer really does go
through the ordinary signup route, which is why it worked before the admin API existed.

**Admin** — every one requires an administrator token:

| Method | Path                               | Answers                                                                                             |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| POST   | `api/v1/admin/login`               | `{ accessToken, account }` · 403 for a shop account · called once at sign-in, after the local check |
| GET    | `api/v1/admin/accounts`            | `{ accounts[], total }` · customers only, newest first, unpaged                                     |
| GET    | `api/v1/admin/accounts/{id}`       | `{ account }`                                                                                       |
| PATCH  | `api/v1/admin/accounts/{id}`       | `{ account }` · 400 blank email, 409 taken; `plan` re-issues from today                             |
| DELETE | `api/v1/admin/accounts/{id}`       | `{ deleted, id }` · drops payments; 403 on an admin, 404 the second time                            |
| POST   | `api/v1/admin/payments`            | `{ account, payment }` · 400 on amount ≤ 0 or a bad plan, 404 unknown account                       |
| GET    | `api/v1/admin/payments?accountId=` | `{ payments[], total }` · newest first; omit for all                                                |

Every failure is `{ error: { code, message, details } }`, and any unmatched `/api/v1/admin/*` path is
a **404 rather than a 401** — a typo that looks like a permissions problem is an afternoon spent on
the wrong question.

## The background

`src/components/ShaderBackground.tsx` is a WebGL field of three brand colours flowing through one
another. Self-contained: no store, no context, no required props, so it can be pasted into MyStockio
or MyCodeScan as-is.

Built for a phone rather than merely tolerated on one — a full-screen fragment shader is the easiest
way to flatten a mid-range device:

- rendered at ~55% of device pixels and capped at 1280, so fragment cost falls with the square
- capped at 30fps; the drift is slow and 60fps costs twice the GPU to look identical
- paused when the tab is hidden
- `low-power`, no antialias, no depth or stencil buffer
- layered sines rather than a noise function — several times cheaper per fragment, and at this scale
  it never visibly repeats
- `prefers-reduced-motion` draws one frame and stops: the colour is the design, the movement is what
  somebody asked to be spared
- no WebGL, a failed compile or a lost context leaves the CSS gradient showing, with nothing logged
  at the user

The GL context is explicitly released on unmount. A browser allows only a handful of live contexts,
and a component that mounts and unmounts — a hot reload, a route change — otherwise exhausts them
and every later canvas fails for no visible reason.

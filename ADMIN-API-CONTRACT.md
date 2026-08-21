# The admin API

**What to add to the backend.** This document is the whole agreement. `server-reference/admin-server.mjs`
implements it and `server-reference/contract.test.mjs` checks it (100+ assertions), so if the two
ever disagree, the tests are the tie-breaker.

---

## 1. What already exists, and what does not

The console needs six operations. **One of them is already live**, and that is not a detail — it
means creating a customer works against the real backend today, with nothing added.

| Operation | Endpoint | Status |
| --- | --- | --- |
| Create a customer | `POST api/v1/auth/register` | **live** — the same route MyStockio's signup uses |
| Sign in | `POST api/v1/auth/login` | **live** |
| List every account | `GET api/v1/admin/accounts` | to add |
| Read one account | `GET api/v1/admin/accounts/{id}` | to add |
| Amend one account | `PATCH api/v1/admin/accounts/{id}` | to add |
| Delete one account | `DELETE api/v1/admin/accounts/{id}` | to add |
| Record a payment or refund | `POST api/v1/admin/payments` | to add |
| Payment history | `GET api/v1/admin/payments?accountId=` | to add |
| Admin sign-in (optional) | `POST api/v1/admin/login` | to add, or reuse the one above |

Nothing before this needed to read somebody else's account, so the existing API is entirely
self-service. That is why the five admin routes have to be built rather than borrowed.

---

## 2. Authorisation — read this first

**The console's password protects nothing.** It is compiled into a JavaScript bundle. Anyone who
can load the page can read it, and no amount of hashing in the client changes that. It stops a
passer-by from seeing the screen, and that is all it is for.

**So the server is the only real gate.** Every `api/v1/admin/*` request must be authorised
server-side, and the requirement is stricter than "has a valid token":

```
1. A valid bearer token.                              → else 401
2. Belonging to an account with an administrator role. → else 403
```

Step 2 is the one that matters. A shop's token is *perfectly valid* — it just must not open this
API. Without that check, any customer could read every other customer's email, phone number and
payment history by calling the endpoint directly with their own token. The contract test asserts
this from both directions: an admin token gets in, and a **real shop token gets 403**.

**Administrators are promoted by hand,** in the database. Do not build an endpoint that creates
them — an internet-reachable route that mints administrators is the largest hole available. The
reference server has a `bootstrap` route purely so the test suite can seed one; it must not be
deployed.

**Administrators are not customers.** `GET /accounts` excludes them, and `DELETE` refuses one.

---

## 3. The account shape

Returned by every endpoint here. `subscription` is what the whole console is built on.

```json
{
  "id": "6a8454525ea6ec85560b2e59",
  "email": "ramesh@shop.com",
  "name": "Ramesh Kumar",
  "phone": "9876543210",
  "shopName": "Balaji Traders",
  "role": "admin",
  "subscription": {
    "plan": "1year",
    "status": "active",
    "startedAt": "2026-08-20T06:12:44.019Z",
    "expiresAt": "2027-08-20T06:12:44.019Z"
  },
  "shopRole": "owner",
  "ownerId": null,
  "ownerEmail": null,
  "subscriptionFrom": "own",
  "createdAt": "2026-08-20T06:12:44.019Z",
  "lastPaymentAt": "2026-08-20T09:30:00.000Z",
  "lastPaymentAmount": 3000,
  "paymentCount": 2
}
```

### `role` and `shopRole` are different fields, and must stay that way

This is the one thing in this document that is a **security** requirement rather than a modelling
preference.

| Field | Means | Set by |
| --- | --- | --- |
| `role` | **platform privilege** — `admin`, or `superadmin` for accounts that may open the admin API | the server, **never** a request body |
| `shopRole` | **a job in a shop** — `owner`, `manager`, `cashier`, `product_manager`, `accountant` | the client, from an allowlist |

`POST api/v1/auth/register` is public. If a job title were read out of the field the authoriser
trusts, then `{"role":"superadmin"}` in a signup body is a request to become an administrator. So the
job title goes in `shopRole`, `role` is assigned server-side and never read from input, and
**`superadmin` is not a valid `shopRole`**. The contract test asserts all three from the outside: a
signup naming `role` does not get it, that account is refused by `admin/login` with 403, and
`shopRole: "superadmin"` is a 400.

### Owners hold licences; staff hang off an owner

Two levels, exactly — staff cannot have staff.

- **`shopRole: "owner"`** — the customer. Has `ownerId: null`, holds a subscription, appears in the
  chase list, and is who payments are recorded against.
- **anything else** — staff. Has an `ownerId`, holds **no subscription of its own**, and is never
  chased or charged.

**An absent `shopRole` means `owner`.** Every account that existed before roles did has no such
field, and reading it any other way turns the entire existing customer base into staff — losing their
licences and their place in the renewal list in one deploy.

### `subscription` on a staff account is the owner's, resolved live

A staff login signs in on its owner's licence, so the server sends **the owner's** subscription and
says so with `subscriptionFrom`:

| `subscriptionFrom` | Means |
| --- | --- |
| `own` | an owner's own licence |
| `owner` | a staff account reading its owner's |
| `none` | a staff account whose owner is missing — a real state, and a fault worth surfacing |

**Resolved on every read, never copied at creation.** A copy drifts the moment the owner renews, and
the drift is invisible: a cashier locked out in April while the shop is paid up to next March.

**Never include the password hash.** Not here, not on login, not anywhere. A hash that leaves the
database can be attacked offline at leisure by anyone who captured one response.

### `expiresAt: null` means lifetime, not expired

The single most important field in this document. A lifetime licence has **no** expiry date, and
the console distinguishes three cases that a single date field cannot:

| `plan` | `expiresAt` | Reads as |
| --- | --- | --- |
| `lifetime` | `null` | **Lifetime** — never chased for renewal |
| `1year` / `2year` | an ISO date | active / expiring / expired, by the date |
| anything | absent | **unknown** — a data problem, surfaced, never chased |

Sending `expiresAt: "9999-01-01"` for a lifetime account instead of `null` would work by accident
and then break the day somebody sorts by date. Send `null`.

### `phone` is load-bearing

It is what the WhatsApp reminders are sent to. An account without a usable number cannot be
chased, and the console counts those separately so the gap is visible rather than quietly
overstating how many customers can be reached.

---

## 4. Subscriptions are computed, never posted

**The server owns the dates. A client may send a `plan`; it may never send an `expiresAt`.**

A console that could post its own expiry could grant itself a decade by editing one field in the
browser. Being trusted to record a payment is not the same as being trusted to invent time. The
contract test asserts that an `expiresAt` in a payment body is ignored.

| `plan` | Runs for |
| --- | --- |
| `1year` | 365 days |
| `2year` | 730 days |
| `lifetime` | no expiry (`expiresAt: null`) |

An unrecognised plan falls back to `1year` rather than to no subscription, so an account always has
a real expiry.

### Renewal extends from the later of (current expiry, today)

```
renewing 60 days early  → 60 + 365 = 425 days from today
renewing 60 days late   →       365 days from today
```

Somebody renewing early does not forfeit days they have paid for. Somebody renewing two months
late does not get credit for two months the app was unusable to them. Each reading is defensible
alone and indefensible together, so pick this one and keep it.

`startedAt` records when the licence period began and a **renewal does not reset it**.

### A plan *change* is not a renewal

`PATCH { plan }` re-issues the subscription from today. That is a correction — "this should have
been lifetime" — and it is deliberately different from `POST /payments`, which extends. Two
different intents, two different routes.

---

## 5. The endpoints

### `GET api/v1/admin/accounts`

Admin only. Every customer account.

```json
{ "accounts": [ /* account shapes */ ], "total": 42 }
```

A bare array is also accepted by the client, as is `{ "data": [...] }`. Paging is not specified —
this is a list of a shop-software vendor's customers, which is hundreds, not millions. Add paging
when it is genuinely needed and version it then.

### `PATCH api/v1/admin/accounts/{id}`

Admin only. Only the fields present are changed.

```json
{ "email": "new@shop.com", "name": "…", "phone": "…", "shopName": "…", "password": "…", "plan": "2year" }
```

- `email` is the customer's **user id** — what they sign in with. Lower-case and trim it. Refuse a
  blank one (`400`) and one already used by another account (`409`).
- `password`, when present, is re-hashed. The old one must stop working immediately.
- `plan`, when present, re-issues the subscription from today (§4).

`200 { "account": { … } }`

### `DELETE api/v1/admin/accounts/{id}`

Admin only. Permanent. The payment history goes with it — orphaned money records help nobody.
Refuse to delete an administrator (`403`). Deleting a missing account is `404`, not a silent
success: the console shows the row until the server confirms, and a false success leaves a ghost.

`200 { "deleted": true, "id": "…" }`

### `POST api/v1/admin/payments`

Admin only. **Records the money and extends the subscription in one call.**

```json
{ "accountId": "…", "amount": 3000, "plan": "1year", "method": "upi", "reference": "UPI-123",
  "note": "", "type": "payment" }
```

One call, not two, and this is deliberate: money received and time granted are the same event.
Splitting them across two requests means a network failure between them leaves a shop that has paid
and not been credited — and no way to tell that from a shop that has not paid.

- `amount` must be more than zero → else `400`. **Refunds included** — the amount stays positive and
  `type` carries the direction.
- `plan` must be one of the three → else `400`.
- An unknown `accountId` → `404`.
- Record **who** took the payment. A money log without an author is not a log.

`201 { "account": { … }, "payment": { … } }` — with the subscription already extended, so the
console needs no second request to show the new date.

#### `type` — one ledger, two directions

`"payment"` (the default, and what an absent field means) or `"refund"`.

- **A refund does not shorten the subscription.** Refunding a licence and revoking it are separate
  decisions — a goodwill refund usually leaves the shop running to the end of the term it paid for —
  and quietly cutting a term short as a side effect of a bookkeeping entry is discovered by a
  customer being locked out.
- **Refunds are not deletions.** Money that came in and went back out both happened, and both belong
  in the record. Deleting the original payment instead rewrites history and silently reduces GST
  already declared.
- **`lastPaymentAt` / `lastPaymentAmount` must skip refunds.** They mean the last money that came
  *in*; a refund there puts a returned amount on the row as though the shop had just paid it.

Omitting the field entirely stays valid, so a client written before refunds existed keeps working.

### `GET api/v1/admin/payments?accountId={id}`

Admin only. Newest first. Omit `accountId` for everything — that is what the revenue dashboard and
the GST report are built from, so **this route must return the whole ledger, not just one page.**

Each row carries `type`, so a total is a sum over one table read in date order. A row without it is
a payment.

---

### `POST api/v1/auth/register` — creating a login

Two new optional fields, on the route that already exists:

```json
{ "name": "Rekha", "email": "rekha@shop.com", "password": "…",
  "shopRole": "cashier", "ownerEmail": "owner@shop.com" }
```

| Field | Rule |
| --- | --- |
| `shopRole` | One of `owner`, `manager`, `cashier`, `product_manager`, `accountant`. **Absent means `owner`.** An unrecognised value is a `400` — never defaulted, since silently turning `cashierr` into an owner hands a counter login somebody's licence. `superadmin` is a `400`. |
| `ownerEmail` | **Required for every role except `owner`**, ignored for an owner. Resolved to an `ownerId` and stored as one; the email is kept alongside for display only. |

`ownerEmail` is refused with `400` when it is missing, when no account has it, or when it belongs to
an account that is **not an owner** — that last one is what keeps the hierarchy two levels deep.
Match it case-insensitively and trimmed.

**A staff signup gets no subscription.** Ignore `plan` for a non-owner rather than issuing a second
licence: a cashier with their own expiry is a second paying customer on every report, and one who can
be locked out while their shop is paid up.

**A blank `shopName` on a staff signup inherits the owner's.** "Optional" has to mean *inherited*,
not *empty* — a cashier row reading "(no name)" beside an owner called Balaji Traders is a hole in
the screen, not a choice somebody made. A name that *was* given is kept exactly as given, because one
owner with two branches is a real thing. So a staff account ends up matching its owner on all three
of the things it does not own: **shop name, plan and expiry.**

### `GET api/v1/admin/accounts` — filters

Everything is still returned by default, owners and staff together, each with `shopRole` and
`ownerId`, so one request builds the whole tree.

| Query | Returns |
| --- | --- |
| `?ownerId={id}` | that owner's staff — the "sub ids" list |
| `?shopRole=owner` | paying customers alone, which is what the money and chase screens are about |

Do not make either the default. An admin list that quietly omits rows is worse than a long one.

### `PATCH api/v1/admin/accounts/{id}` — moving people around

`shopRole` and `ownerEmail` are accepted, with two refusals that keep the shape intact:

- **Demoting an owner who still has staff → `409 HAS_STAFF`.** They would be left pointing at a
  non-owner.
- **Owner → staff requires an `ownerEmail` in the same request → `400`.** A staff account with nobody
  above it can still sign in and belongs to no shop.

Promotion to owner clears `ownerId` and issues a licence. Owner → staff drops their own licence, since
they are on the owner's now — refunding it is a separate, deliberate decision.

### `DELETE api/v1/admin/accounts/{id}` — an owner with staff

**`409 HAS_STAFF`, listing the emails in the way.** Not a cascade: deleting other people's logins as a
side effect of one click leaves a cashier unable to sign in tomorrow morning with no way to find out
why. Refusing makes it a decision — move them, or delete them, then delete the owner.

### `POST api/v1/admin/payments` — money belongs to the owner

**`400 NOT_AN_OWNER` when `accountId` is a staff login**, naming the owner to use instead. The licence
is the owner's, so recording a payment against a cashier would try to extend a subscription that does
not exist and would put their name on a GST line for a licence somebody else bought.

---

## 6. Error shape

Every failure, nested:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Please check the payment details.",
             "details": { "amount": "must be more than zero" } } }
```

`message` is shown to the operator as written, so write it as a sentence a person would say.
`code` is stable and matched on. `details` maps field to problem, and carries **only the fields
that actually failed** — an entry for a field that passed reads as a false accusation.

An unmatched `api/v1/admin/*` route must answer **404, not 401**. A typo that looks like a
permissions problem is an afternoon lost to the wrong question.

---

## 7. Checklist

- [ ] Every `api/v1/admin/*` route requires a token **and** an administrator role — a valid shop
      token gets `403`
- [ ] Administrators are promoted by hand; no endpoint creates one
- [ ] Administrators are excluded from `GET /accounts` and cannot be deleted through it
- [ ] No password hash in any response
- [ ] `expiresAt: null` for lifetime — never a far-future date
- [ ] A refund records without extending the subscription, and never appears as `lastPaymentAmount`
- [ ] `role` is never read from a request body, and `superadmin` is not a valid `shopRole`
- [ ] An account with no `shopRole` behaves exactly as an owner did before roles existed
- [ ] Staff hold no subscription of their own and read their owner's live, with `subscriptionFrom`
- [ ] A staff signup with no `shopName` inherits the owner's; one that is given is kept as given
- [ ] Staff cannot own staff; deleting or demoting an owner with staff is a 409, not a cascade
- [ ] A payment against a staff account is a 400
- [ ] Subscription dates computed server-side; `expiresAt` never accepted from a client
- [ ] Renewal extends from the later of (current expiry, today); `startedAt` is not reset
- [ ] `PATCH { plan }` re-issues from today, unlike a payment
- [ ] Payment and renewal are one atomic call, and the payment records who took it
- [ ] `email` changes are lower-cased, trimmed, and refused when already in use (`409`)
- [ ] A changed password works at once and the old one stops working
- [ ] Deleting an account removes its payments and answers `404` the second time
- [ ] Errors use `{ error: { code, message, details } }`; unmatched admin routes are `404`

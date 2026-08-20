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
  "createdAt": "2026-08-20T06:12:44.019Z",
  "lastPaymentAt": "2026-08-20T09:30:00.000Z",
  "lastPaymentAmount": 3000,
  "paymentCount": 2
}
```

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
- [ ] Subscription dates computed server-side; `expiresAt` never accepted from a client
- [ ] Renewal extends from the later of (current expiry, today); `startedAt` is not reset
- [ ] `PATCH { plan }` re-issues from today, unlike a payment
- [ ] Payment and renewal are one atomic call, and the payment records who took it
- [ ] `email` changes are lower-cased, trimmed, and refused when already in use (`409`)
- [ ] A changed password works at once and the old one stops working
- [ ] Deleting an account removes its payments and answers `404` the second time
- [ ] Errors use `{ error: { code, message, details } }`; unmatched admin routes are `404`

/**
 * Who somebody is inside a shop, and which owner they belong to.
 *
 * ── The shape of the thing ─────────────────────────────────────────────────────
 * An **owner** is the customer: they hold the licence, they pay, they are the row in the accounts
 * table. Everybody else — cashier, product manager, accountant — is **staff**, a login that belongs
 * to an owner and rides on the owner's licence. One owner, many staff.
 *
 * That is deliberately **two levels, not a tree**. A cashier cannot have staff of their own. Real
 * shops do not nest four deep, and every question worth asking here ("who does this login belong
 * to", "what can this owner's people do", "does this licence cover them") has a one-hop answer. A
 * general hierarchy would cost cycle checks, recursive queries and orphan handling to model
 * something nobody asked for.
 *
 * ══ WHY THIS IS NOT THE EXISTING `role` FIELD ════════════════════════════════════
 *
 * `AdminAccount.role` already exists and already means something else: **platform privilege**, either
 * `admin` (an ordinary account) or `superadmin` (may open the admin API). It is what the server
 * authorises against.
 *
 * Putting job titles into that field would be a security bug, not a tidy-up. `POST auth/register` is
 * a **public** route; if it read a job title out of the same field the authoriser trusts, then
 * `{"role":"superadmin"}` in a signup body is a request to become an administrator. Even with a
 * server-side allowlist today, the two concepts would sit one careless edit apart forever.
 *
 * So the job title lives in `shopRole` and the two never meet. `role` keeps authorising; `shopRole`
 * describes a job. Nothing about admin authorisation changes.
 */

/** What somebody does in the shop. The value is what goes over the wire and into the database. */
export enum Role {
  /** Holds the licence and pays for it. The customer. */
  Owner = 'owner',
  /** Runs the shop day to day on the owner's behalf. */
  Manager = 'manager',
  /** Takes payments at the counter. */
  Cashier = 'cashier',
  /** Maintains the catalogue: products, prices, stock. */
  ProductManager = 'product_manager',
  /** Reads the books. */
  Accountant = 'accountant',
}

/** Every role, owner first — the order they appear in a dropdown. */
export const ROLES: Role[] = [Role.Owner, Role.Manager, Role.Cashier, Role.ProductManager, Role.Accountant]

export const ROLE_LABEL: Record<Role, string> = {
  [Role.Owner]: 'Owner',
  [Role.Manager]: 'Manager',
  [Role.Cashier]: 'Cashier',
  [Role.ProductManager]: 'Product manager',
  [Role.Accountant]: 'Accountant',
}

/**
 * One line on what each role is for.
 *
 * Descriptions, **not permissions**. What a cashier may actually do is enforced in the shop app, and
 * writing a permission matrix here would invent an authorisation model this console does not apply —
 * which is worse than no model, because it reads as one.
 */
export const ROLE_NOTE: Record<Role, string> = {
  [Role.Owner]: 'Holds the licence and pays for it. Has no owner above them.',
  [Role.Manager]: 'Runs the shop for the owner. Belongs to an owner.',
  [Role.Cashier]: 'Takes payments at the counter. Belongs to an owner.',
  [Role.ProductManager]: 'Maintains products, prices and stock. Belongs to an owner.',
  [Role.Accountant]: 'Reads the books. Belongs to an owner.',
}

/** Whatever the server sent, as a `Role` — or `null` when it is not one. */
export function asRole(value: unknown): Role | null {
  return typeof value === 'string' && (ROLES as string[]).includes(value) ? (value as Role) : null
}

/**
 * The role of an account, defaulting to owner.
 *
 * **The default is load-bearing.** Every account that existed before roles did is an owner — they
 * hold a licence and pay for it — so a missing `shopRole` reads as `owner` rather than as unknown.
 * Reading it the other way would strip every existing customer of their own licence.
 */
export function roleOf(account: { shopRole?: string | null }): Role {
  return asRole(account.shopRole) ?? Role.Owner
}

export function isOwner(account: { shopRole?: string | null }): boolean {
  return roleOf(account) === Role.Owner
}

/** Staff: anybody who is not an owner, and therefore belongs to one. */
export function isStaff(account: { shopRole?: string | null }): boolean {
  return !isOwner(account)
}

/**
 * Whether picking this role means an owner has to be named.
 *
 * The single rule the create form is built on: owners have nobody above them, everybody else does.
 */
export function needsOwner(role: Role): boolean {
  return role !== Role.Owner
}

/* ────────────────────────────────────────────────────────── the family ── */

/** The minimum an account needs to have for the functions below. */
export interface Related {
  id: string
  email: string
  name?: string
  shopName?: string
  shopRole?: string | null
  /** Set by the server on staff accounts. */
  ownerId?: string | null
  /** What was typed when they were created, kept for display when the id cannot be resolved. */
  ownerEmail?: string | null
}

/** The staff belonging to one owner. */
export function childrenOf<T extends Related>(accounts: T[], ownerId: string): T[] {
  return accounts
    .filter((account) => isStaff(account) && account.ownerId === ownerId)
    .sort((a, b) => roleThenName(a, b))
}

/**
 * The owner a staff account belongs to.
 *
 * Matches on `ownerId` first and falls back to `ownerEmail`, because a backend that stores only the
 * email it was given still has to produce a usable screen. Returns `null` for an owner, and for a
 * staff account whose owner is not in the list — which is a real state worth showing rather than
 * hiding, since it means a deleted or mistyped owner.
 */
export function ownerOf<T extends Related>(account: Related, accounts: T[]): T | null {
  if (isOwner(account)) return null
  if (account.ownerId) {
    const byId = accounts.find((candidate) => candidate.id === account.ownerId)
    if (byId) return byId
  }
  const email = account.ownerEmail?.trim().toLowerCase()
  if (!email) return null
  return accounts.find((candidate) => candidate.email.trim().toLowerCase() === email) ?? null
}

export interface Family<T> {
  owner: T
  staff: T[]
}

/**
 * Owners with their staff attached, and the staff nobody claims.
 *
 * `orphans` exists because the alternative is worse. A staff account whose owner has been deleted or
 * whose email was mistyped would otherwise vanish from every screen — still able to sign in, still
 * invisible to whoever is looking. Surfaced, it can be fixed.
 */
export function families<T extends Related>(accounts: T[]): { families: Family<T>[]; orphans: T[] } {
  const owners = accounts.filter(isOwner)
  const ownerIds = new Set(owners.map((owner) => owner.id))

  const claimed = new Set<string>()
  const result = owners.map((owner) => {
    const staff = childrenOf(accounts, owner.id)
    for (const member of staff) claimed.add(member.id)
    return { owner, staff }
  })

  const orphans = accounts.filter(
    (account) =>
      isStaff(account) &&
      !claimed.has(account.id) &&
      /* Not claimed by id, and not resolvable by email either. */
      !(account.ownerId && ownerIds.has(account.ownerId)) &&
      !ownerOf(account, accounts),
  )

  return { families: result, orphans }
}

/** How many staff each owner has, for the table. */
export function staffCounts(accounts: Related[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const account of accounts) {
    if (!isStaff(account)) continue
    const owner = ownerOf(account, accounts)
    if (!owner) continue
    counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1)
  }
  return counts
}

/** Owners only — the accounts that hold a licence, pay, and can be chased. */
export function owners<T extends Related>(accounts: T[]): T[] {
  return accounts.filter(isOwner)
}

/** A readable name, whatever fields the server filled in. */
export function nameOf(account: Related): string {
  return account.shopName || account.name || account.email
}

/**
 * A name in the possessive — `Balaji Traders’` rather than `Balaji Traders’s`.
 *
 * Worth a function because shop names ending in *s* are common (Traders, Stores, Sons) and the
 * doubled sibilant is exactly the kind of small wrongness that makes a screen look unfinished.
 */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`
}

/** Owners are listed by name; staff by role, then name — so a family reads in a sensible order. */
function roleThenName(a: Related, b: Related): number {
  const byRole = ROLES.indexOf(roleOf(a)) - ROLES.indexOf(roleOf(b))
  return byRole !== 0 ? byRole : nameOf(a).localeCompare(nameOf(b))
}

/* ─────────────────────────────────────────────────── creating a login ── */

export interface RoleChoice {
  role: Role
  /** The owner's email, for staff. Ignored for an owner. */
  ownerEmail: string
}

export interface RoleProblem {
  field: 'role' | 'ownerEmail'
  message: string
}

/**
 * What the shop-name field should hold once an owner is chosen.
 *
 * A staff login works in the owner's shop, so it takes the owner's shop name. Making somebody retype
 * a name they can see two fields above is busywork, and the retyped version is the one that ends up
 * spelled differently — two rows that are the same shop and do not look like it.
 *
 * Three rules, in this order, and the middle one is the one that matters:
 *
 *   1. **A name typed by hand is never overwritten.** `edited` says a person has been in that field;
 *      after that, changing owner leaves what they wrote alone. An auto-fill that clobbers typing is
 *      worse than no auto-fill.
 *   2. Otherwise the owner's name is copied — the ordinary case.
 *   3. With no owner, or an owner who has no shop name, whatever is there stays. Nothing is invented.
 *
 * The field stays editable either way: one owner with two branches is a real thing, which is why
 * this copies rather than locks.
 */
export function shopNameFor({
  owner,
  current,
  edited,
}: {
  /** The owner just chosen, or `null` when the email matches nobody yet. */
  owner: Related | null
  /** What the field holds now. */
  current: string
  /** Whether a person has typed in the field themselves. */
  edited: boolean
}): string {
  if (edited) return current
  const inherited = owner?.shopName?.trim()
  return inherited ? inherited : current
}

/**
 * Checks a role choice before it is sent.
 *
 * The server checks all of this again and is the authority — this exists so the form can refuse in
 * the same breath as the typing, rather than after a round trip. The messages say what to do, not
 * what went wrong.
 */
export function checkRoleChoice(choice: RoleChoice, accounts: Related[]): RoleProblem | null {
  if (!asRole(choice.role)) return { field: 'role', message: 'Choose a role.' }

  if (!needsOwner(choice.role)) return null

  const email = choice.ownerEmail.trim().toLowerCase()
  if (!email) {
    return { field: 'ownerEmail', message: `A ${ROLE_LABEL[choice.role].toLowerCase()} belongs to an owner — give the owner's email.` }
  }
  if (!email.includes('@')) return { field: 'ownerEmail', message: 'That does not look like an email address.' }

  const match = accounts.find((account) => account.email.trim().toLowerCase() === email)
  if (!match) {
    return { field: 'ownerEmail', message: 'No account has that email. Create the owner first.' }
  }
  if (!isOwner(match)) {
    /* Two levels only — staff cannot have staff. Stated as the fix, not as a rule violated. */
    return {
      field: 'ownerEmail',
      message: `${nameOf(match)} is a ${ROLE_LABEL[roleOf(match)].toLowerCase()}, not an owner. Name the owner they report to instead.`,
    }
  }
  return null
}

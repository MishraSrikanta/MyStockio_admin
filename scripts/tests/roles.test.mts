/**
 * Roles, and who belongs to whom.
 *
 * Four things here would be quietly wrong rather than loudly broken, which is why each gets its own
 * assertions:
 *
 *   · **An account with no `shopRole` is an owner.** Every customer that existed before roles did
 *     has no such field. Read any other way, the whole existing customer base becomes staff — losing
 *     their licences, their place in the chase list and their rows on the money screen at once.
 *   · **`role` and `shopRole` never mix.** `role` is platform privilege, the field the server
 *     authorises against; `shopRole` is a job. A `superadmin` handed a job title must not become a
 *     shop login, and a cashier must not be able to name themselves into the admin API.
 *   · **Two levels, exactly.** Staff cannot have staff, so the form must refuse an owner-email that
 *     points at a cashier.
 *   · **A staff account whose owner is gone must still be findable.** Silence there means a login
 *     that can still sign in and appears on no screen.
 */

import {
  asRole,
  checkRoleChoice,
  childrenOf,
  families,
  isOwner,
  isStaff,
  nameOf,
  needsOwner,
  ownerOf,
  owners,
  possessive,
  Role,
  shopNameFor,
  ROLE_LABEL,
  ROLES,
  roleOf,
  staffCounts,
  type Related,
} from '../../src/lib/roles'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const account = (over: Partial<Related> & { id: string; email: string }): Related => ({ ...over })

/* A shop: one owner, three staff. */
const boss = account({ id: 'own-1', email: 'boss@shop.com', shopName: 'Balaji Traders', shopRole: Role.Owner })
const till = account({ id: 'st-1', email: 'till@shop.com', name: 'Rekha', shopRole: Role.Cashier, ownerId: 'own-1', ownerEmail: 'boss@shop.com' })
const stock = account({ id: 'st-2', email: 'stock@shop.com', name: 'Anil', shopRole: Role.ProductManager, ownerId: 'own-1', ownerEmail: 'boss@shop.com' })
const books = account({ id: 'st-3', email: 'books@shop.com', name: 'Priya', shopRole: Role.Accountant, ownerId: 'own-1', ownerEmail: 'boss@shop.com' })
/* A second shop, and an account created before roles existed. */
const other = account({ id: 'own-2', email: 'other@shop.com', shopName: 'Sharma Stores', shopRole: Role.Owner })
const legacy = account({ id: 'own-3', email: 'legacy@shop.com', shopName: 'Old Shop' })

const all = [boss, till, stock, books, other, legacy]

/* ══════════════════════════════════════════════════════ reading a role ══ */

console.log('reading a role')

check('the enum carries the wire values', Role.Cashier === ('cashier' as Role) && Role.ProductManager === ('product_manager' as Role))
check('every role has a label', ROLES.every((role) => (ROLE_LABEL[role] ?? '').length > 0))
check('owner comes first in the list', ROLES[0] === Role.Owner)

check('a known role is recognised', asRole('cashier') === Role.Cashier)
check('an unknown role is not', asRole('emperor') === null)
check('a non-string is not', asRole(7) === null && asRole(undefined) === null && asRole(null) === null)

/*
 * The default that protects every existing customer. An account created before roles existed has no
 * `shopRole`, and it is an owner — it holds a licence and pays for it.
 */
check('no shopRole means owner', roleOf(legacy) === Role.Owner)
check('...and reads as an owner', isOwner(legacy) && !isStaff(legacy))
check('an explicit owner is an owner', isOwner(boss))
check('a cashier is staff', isStaff(till) && !isOwner(till))
check('rubbish in shopRole reads as owner, not as staff', roleOf(account({ id: 'x', email: 'x@x.com', shopRole: 'nonsense' })) === Role.Owner)

/*
 * `role` is platform privilege and must never be read as a job. A superadmin carries `role`, not
 * `shopRole`, and reading the wrong field is how a console administrator would appear in a shop's
 * staff list — or worse, how a cashier would be treated as one.
 */
const superadmin = { id: 'adm-1', email: 'admin@console', role: 'superadmin' } as Related & { role: string }
check('a superadmin is not staff of anybody', isOwner(superadmin) && ownerOf(superadmin, all) === null)
const cashierClaimingAdmin = { ...till, role: 'superadmin' } as Related & { role: string }
check('the job title is read from shopRole, not role', roleOf(cashierClaimingAdmin) === Role.Cashier)

/* ══════════════════════════════════════════ who belongs to whom ══ */

console.log('\nwho belongs to whom')

check('an owner has children', childrenOf(all, 'own-1').length === 3, String(childrenOf(all, 'own-1').length))
check('...in role order, not insertion order', childrenOf(all, 'own-1').map((s) => roleOf(s)).join(',') === 'cashier,product_manager,accountant')
check('an owner with no staff has none', childrenOf(all, 'own-2').length === 0)
check('staff are never their own children', !childrenOf(all, 'own-1').some((s) => s.id === 'own-1'))

check('a staff member resolves to their owner', ownerOf(till, all)?.id === 'own-1')
check('an owner has no owner', ownerOf(boss, all) === null)

/* A backend that stored only the email must still produce a usable screen. */
const emailOnly = account({ id: 'st-9', email: 'temp@shop.com', shopRole: Role.Cashier, ownerEmail: 'BOSS@shop.com' })
check('an owner can be resolved by email alone', ownerOf(emailOnly, all)?.id === 'own-1')
check('...case-insensitively', ownerOf(account({ id: 's', email: 's@s.com', shopRole: Role.Cashier, ownerEmail: '  boss@SHOP.com ' }), all)?.id === 'own-1')

/* The state that must never be silent: a staff account whose owner is not there. */
const orphan = account({ id: 'st-x', email: 'ghost@shop.com', shopRole: Role.Cashier, ownerId: 'own-deleted', ownerEmail: 'gone@shop.com' })
check('a staff member with a missing owner resolves to nobody', ownerOf(orphan, all) === null)

const grouped = families([...all, orphan])
check('every owner gets a family', grouped.families.length === 3, String(grouped.families.length))
check('the staff land under the right owner', grouped.families.find((f) => f.owner.id === 'own-1')?.staff.length === 3)
check('an owner with no staff still gets a family', grouped.families.find((f) => f.owner.id === 'own-2')?.staff.length === 0)
check('the orphan is surfaced, not dropped', grouped.orphans.length === 1 && grouped.orphans[0].id === 'st-x')
check('...and is not counted under any owner', !grouped.families.some((f) => f.staff.some((s) => s.id === 'st-x')))

const counts = staffCounts([...all, orphan])
check('staff counts are per owner', counts.get('own-1') === 3 && counts.get('own-2') === undefined)
check('an orphan is counted against nobody', [...counts.values()].reduce((a, b) => a + b, 0) === 3)

check('owners() keeps only owners', owners(all).map((o) => o.id).join(',') === 'own-1,own-2,own-3')
/* Shop names ending in s are common, and 'Traders's' is the kind of wrongness that shows. */
check('a possessive avoids the doubled s', possessive('Balaji Traders') === 'Balaji Traders’', possessive('Balaji Traders'))
check('...and keeps it where it belongs', possessive('Rekha') === 'Rekha’s', possessive('Rekha'))
check('...case-insensitively', possessive('SONS') === 'SONS’', possessive('SONS'))

check('a name falls back through shop, person, email', nameOf(boss) === 'Balaji Traders' && nameOf(till) === 'Rekha' && nameOf(account({ id: 'z', email: 'z@z.com' })) === 'z@z.com')

/* ═══════════════════════════════════ the shop name follows the owner ══ */

console.log('\nthe shop name follows the owner')

/*
 * Staff work in the owner's shop, so the field is filled from the owner rather than typed again. The
 * retyped version is the one that ends up spelled differently, leaving two rows that are the same
 * shop and do not look like it.
 */
check('an owner’s shop name is copied', shopNameFor({ owner: boss, current: '', edited: false }) === 'Balaji Traders')
check('...over an earlier auto-filled value', shopNameFor({ owner: other, current: 'Balaji Traders', edited: false }) === 'Sharma Stores')

/*
 * The rule that matters most: a name somebody typed is never overwritten. An auto-fill that clobbers
 * typing is worse than no auto-fill, because the typing was the deliberate act.
 */
check('a hand-typed name survives a change of owner', shopNameFor({ owner: other, current: 'Balaji Traders — Cuttack', edited: true }) === 'Balaji Traders — Cuttack')
check('...even when it was cleared on purpose', shopNameFor({ owner: boss, current: '', edited: true }) === '')

/* Nothing is invented when there is nothing to copy. */
check('no owner leaves the field alone', shopNameFor({ owner: null, current: 'Half typed', edited: false }) === 'Half typed')
check('an owner with no shop name leaves it alone', shopNameFor({ owner: account({ id: 'o9', email: 'o9@shop.com', shopRole: Role.Owner }), current: 'Kept', edited: false }) === 'Kept')
check('...and a whitespace-only shop name counts as none', shopNameFor({ owner: account({ id: 'o8', email: 'o8@shop.com', shopName: '   ', shopRole: Role.Owner }), current: 'Kept', edited: false }) === 'Kept')
check('a copied name is trimmed', shopNameFor({ owner: account({ id: 'o7', email: 'o7@shop.com', shopName: '  Padded Traders  ', shopRole: Role.Owner }), current: '', edited: false }) === 'Padded Traders')

/* ════════════════════════════════════════ choosing a role on the form ══ */

console.log('\nchoosing a role')

check('an owner needs no owner above them', !needsOwner(Role.Owner))
for (const role of ROLES.filter((r) => r !== Role.Owner)) {
  check(`a ${ROLE_LABEL[role].toLowerCase()} needs one`, needsOwner(role))
}

check('an owner passes with no email', checkRoleChoice({ role: Role.Owner, ownerEmail: '' }, all) === null)
check('...and ignores one that was typed anyway', checkRoleChoice({ role: Role.Owner, ownerEmail: 'boss@shop.com' }, all) === null)

const missing = checkRoleChoice({ role: Role.Cashier, ownerEmail: '' }, all)
check('a cashier without an owner is refused', missing?.field === 'ownerEmail', missing?.message)
check('...and the message says what to do', (missing?.message ?? '').includes("owner's email"), missing?.message)

check('a cashier with a good owner passes', checkRoleChoice({ role: Role.Cashier, ownerEmail: 'boss@shop.com' }, all) === null)
check('...case and space tolerant', checkRoleChoice({ role: Role.Cashier, ownerEmail: '  BOSS@shop.com  ' }, all) === null)

const unknown = checkRoleChoice({ role: Role.Cashier, ownerEmail: 'nobody@shop.com' }, all)
check('an unknown owner email is refused', unknown?.field === 'ownerEmail', unknown?.message)
check('...telling you to create the owner first', (unknown?.message ?? '').includes('Create the owner first'), unknown?.message)

const notAnEmail = checkRoleChoice({ role: Role.Cashier, ownerEmail: 'boss' }, all)
check('something that is not an email is refused', notAnEmail?.field === 'ownerEmail')

/* Two levels, exactly: a cashier cannot be somebody's owner. */
const nested = checkRoleChoice({ role: Role.Cashier, ownerEmail: 'till@shop.com' }, all)
check('a staff member cannot be named as the owner', nested?.field === 'ownerEmail', nested?.message)
check('...and the message names their actual role', (nested?.message ?? '').includes('cashier'), nested?.message)

/* An account with no shopRole is an owner, so it is a valid parent. */
check('a legacy account can own staff', checkRoleChoice({ role: Role.Manager, ownerEmail: 'legacy@shop.com' }, all) === null)

const badRole = checkRoleChoice({ role: 'emperor' as Role, ownerEmail: '' }, all)
check('an invalid role is refused', badRole?.field === 'role')

console.log()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

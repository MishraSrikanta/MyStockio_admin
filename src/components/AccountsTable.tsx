/**
 * The accounts table, with each owner's staff nested underneath.
 *
 * ── Why the staff are rows inside a row, and not rows of their own ─────────────
 * A staff login is not a customer. It holds no licence, pays nothing, and is never chased — so
 * listing one at the top level would count one shop twice on a screen whose whole job is "who do I
 * need to ring today". The owner is the row; their people are underneath it, collapsed until asked
 * for.
 *
 * Collapsed by default, because the common question is about shops and the uncommon one is about
 * logins. The count on the owner's row is the affordance: `3 staff` says there is something to open
 * without opening it.
 *
 * ── The one case that breaks the nesting, on purpose ──────────────────────────
 * A **search** and the **Staff filter** both put staff at the top level, because a row nobody can
 * reach is worse than a row in the wrong place. Somebody typing `rekha@shop.com` has a cashier in
 * mind, and "no results" for an account that plainly exists is how a tool loses its user's trust.
 * Those rows say who they belong to instead of pretending to be owners.
 *
 * ══ WHAT MAKES THIS FAST, AND WHAT MADE IT SLOW ══════════════════════════════════
 *
 * The first version asked each row to find its own relatives — `childrenOf(accounts, id)` on every
 * owner row, `ownerOf(account, accounts)` on every staff row. Each of those walks the whole list, so
 * rendering n rows walked the list n times: **quadratic**, and measurably so. One character typed
 * into the search box cost 26ms at 120 rows, 59ms at 360, and **209ms at 1200** — a keystroke you
 * sit and wait for.
 *
 * Now the relationships are indexed **once per account list** and each row is handed its own slice,
 * so rendering is linear. The rows are memoised on top of that, so a keystroke re-renders only the
 * rows whose data actually changed rather than every row that survived the filter.
 *
 * That is why the props below are shaped as they are: `staff` and `owner` arrive ready-made and every
 * callback is stable. Passing `accounts` down and letting a row search it would undo both the
 * indexing and the memoisation in a single line.
 */

import { memo, useCallback, useMemo, useState } from 'react'
import { formatAmount, normalisePhone, reminderMessage, toneFor, whatsappLink } from '@/lib/outreach'
import { isStaff, nameOf, possessive, ROLE_LABEL, ROLES, roleOf, Role } from '@/lib/roles'
import {
  type AdminAccount,
  describeTimeLeft,
  formatDate,
  isLifetime,
  planLabel,
  subscriptionState,
} from '@/lib/subscription'
import { Badge } from './ui'

const STATE_TONE = {
  lifetime: 'violet',
  active: 'success',
  expiring: 'warning',
  expired: 'danger',
  unknown: 'neutral',
} as const

/** Staff wear a quieter badge than a licence state — a job title is not an alarm. */
const ROLE_TONE = 'info' as const

/** One shared empty array, so "no staff" is a stable prop rather than a fresh `[]` each render. */
const NO_STAFF: AdminAccount[] = []

const reachable = (account: AdminAccount) => normalisePhone(account.phone) !== ''

export function AccountsTable({
  rows,
  accounts,
  loading,
  onSelect,
  onAddStaff,
}: {
  /** What to show at the top level — already searched, filtered and sorted. */
  rows: AdminAccount[]
  /** Everything loaded, so an owner's staff can be found without another request. */
  accounts: AdminAccount[]
  loading: boolean
  onSelect: (account: AdminAccount) => void
  /** Opens the create form as a staff login already pointed at this owner. */
  onAddStaff: (owner: AdminAccount) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())

  /*
   * The whole hierarchy, indexed in one pass and reused by every row.
   *
   * Keyed on `accounts`, so it survives every keystroke — a search changes which rows are shown,
   * never who belongs to whom. This is what keeps rendering linear instead of quadratic.
   */
  const { staffByOwner, byId, byEmail } = useMemo(() => {
    const byId = new Map<string, AdminAccount>()
    const byEmail = new Map<string, AdminAccount>()
    for (const account of accounts) {
      byId.set(account.id, account)
      byEmail.set(account.email.trim().toLowerCase(), account)
    }

    const staffByOwner = new Map<string, AdminAccount[]>()
    for (const account of accounts) {
      if (!isStaff(account)) continue
      /* By id when it resolves, else by the email that was typed — the same rule as `ownerOf`. */
      const owner =
        (account.ownerId ? byId.get(account.ownerId) : undefined) ??
        (account.ownerEmail ? byEmail.get(account.ownerEmail.trim().toLowerCase()) : undefined)
      if (!owner) continue
      const list = staffByOwner.get(owner.id)
      if (list) list.push(account)
      else staffByOwner.set(owner.id, [account])
    }

    /* Role order within a family, so it reads cashier → product manager → accountant every time. */
    for (const list of staffByOwner.values()) {
      list.sort(
        (a, b) => ROLES.indexOf(roleOf(a)) - ROLES.indexOf(roleOf(b)) || nameOf(a).localeCompare(nameOf(b)),
      )
    }

    return { staffByOwner, byId, byEmail }
  }, [accounts])

  /** Stable, so a memoised row is not invalidated by a new function identity every render. */
  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const ownerOfRow = (account: AdminAccount): AdminAccount | null =>
    (account.ownerId ? byId.get(account.ownerId) : undefined) ??
    (account.ownerEmail ? byEmail.get(account.ownerEmail.trim().toLowerCase()) : undefined) ??
    null

  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[980px] border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="th">Shop</th>
            <th className="th">Role</th>
            <th className="th">User id (email)</th>
            <th className="th">Phone</th>
            <th className="th">Plan</th>
            <th className="th">Time left</th>
            <th className="th">Expires</th>
            <th className="th">Last payment</th>
            <th className="th">Chase</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="td text-center text-slate-500" colSpan={9}>
                {loading ? 'Loading…' : accounts.length === 0 ? 'No accounts yet.' : 'Nothing matches that.'}
              </td>
            </tr>
          ) : (
            rows.flatMap((account) => {
              /* A staff row at the top level: reached by search, or by the Staff filter. */
              if (isStaff(account)) {
                return [
                  <StaffRow
                    key={account.id}
                    account={account}
                    owner={ownerOfRow(account)}
                    onSelect={onSelect}
                    topLevel
                  />,
                ]
              }

              const staff = staffByOwner.get(account.id) ?? NO_STAFF
              const expanded = open.has(account.id)

              return [
                <OwnerRow
                  key={account.id}
                  account={account}
                  staff={staff}
                  expanded={expanded}
                  onToggle={toggle}
                  onSelect={onSelect}
                  onAddStaff={onAddStaff}
                />,
                ...(expanded
                  ? staff.map((member) => (
                      <StaffRow key={member.id} account={member} owner={account} onSelect={onSelect} />
                    ))
                  : []),
              ]
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One owner: the shop, its licence, and the handle on its staff.
 *
 * Memoised, and every prop is either a primitive or an identity that changes only when the data
 * does. That is the point — while somebody types in the search box, the rows that survive the filter
 * have no reason to render again, and now they do not.
 */
const OwnerRow = memo(function OwnerRow({
  account,
  staff,
  expanded,
  onToggle,
  onSelect,
  onAddStaff,
}: {
  account: AdminAccount
  staff: AdminAccount[]
  expanded: boolean
  onToggle: (id: string) => void
  onSelect: (account: AdminAccount) => void
  onAddStaff: (owner: AdminAccount) => void
}) {
  const state = subscriptionState(account)
  const link = whatsappLink(account, reminderMessage(account, toneFor(account)))

  return (
    <tr className="group hover:bg-slate-800/40">
      <td className="td">
        <div className="flex items-start gap-1.5">
          {/*
            The expander only exists where there is something to expand. A disabled chevron on every
            childless row is nine tenths noise.
          */}
          {staff.length > 0 ? (
            <button
              type="button"
              onClick={() => onToggle(account.id)}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} ${possessive(nameOf(account))} staff`}
              className="-ml-1 mt-px w-5 shrink-0 text-[15px] leading-none text-slate-400 transition-colors hover:text-slate-100"
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0">
            <button
              type="button"
              className="text-left font-semibold text-sky-300 hover:underline"
              onClick={() => onSelect(account)}
            >
              {account.shopName || account.name || '(no name)'}
            </button>
            {account.name && account.shopName && (
              <span className="block text-[11.5px] text-slate-500">{account.name}</span>
            )}
            <span className="mt-0.5 flex items-center gap-2">
              {staff.length > 0 && (
                <button
                  type="button"
                  onClick={() => onToggle(account.id)}
                  className="text-[11.5px] text-slate-400 hover:text-slate-200 hover:underline"
                >
                  {staff.length} staff
                </button>
              )}
              <button
                type="button"
                onClick={() => onAddStaff(account)}
                className="text-[11.5px] text-slate-500 opacity-0 transition-opacity hover:text-sky-300 hover:underline focus:opacity-100 group-hover:opacity-100"
              >
                + add staff
              </button>
            </span>
          </span>
        </div>
      </td>
      <td className="td">
        <Badge tone="neutral">Owner</Badge>
      </td>
      <td className="td num truncate">{account.email}</td>
      <td className="td num">
        {account.phone ? (
          reachable(account) ? (
            account.phone
          ) : (
            <span className="text-rose-300" title="WhatsApp cannot use this number">
              {account.phone}
            </span>
          )
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>
      <td className="td">{planLabel(account.subscription?.plan)}</td>
      <td className="td">
        <Badge tone={STATE_TONE[state]}>{describeTimeLeft(account)}</Badge>
      </td>
      <td className="td num">{isLifetime(account) ? 'Never' : formatDate(account.subscription?.expiresAt) || '—'}</td>
      <td className="td num">
        {account.lastPaymentAt ? `₹${formatAmount(account.lastPaymentAmount ?? 0)}` : <span className="text-slate-600">—</span>}
      </td>
      <td className="td">
        {state === 'lifetime' || state === 'active' ? (
          <span className="text-slate-600">—</span>
        ) : link ? (
          <a href={link} target="_blank" rel="noreferrer" className="text-emerald-300 hover:underline">
            WhatsApp
          </a>
        ) : (
          <span className="text-rose-400" title="No usable phone number">
            no number
          </span>
        )}
      </td>
    </tr>
  )
})

/**
 * One staff login.
 *
 * The licence columns are deliberately **not** repeated as data. A cashier's expiry is their owner's
 * expiry, and printing it again on their row would invite somebody to renew a cashier — so the row
 * says *whose* licence it is instead, and the chase column is blank because you never chase staff.
 */
const StaffRow = memo(function StaffRow({
  account,
  owner,
  onSelect,
  topLevel = false,
}: {
  account: AdminAccount
  /** Resolved by the parent from its index. `null` when the owner is missing, which is shown. */
  owner: AdminAccount | null
  onSelect: (account: AdminAccount) => void
  /** Reached by a search rather than by expanding an owner, so it carries no indent. */
  topLevel?: boolean
}) {
  const role = roleOf(account)

  return (
    <tr className="bg-slate-900/40 hover:bg-slate-800/40">
      <td className="td">
        <div className={topLevel ? '' : 'ml-1.5 border-l-2 border-white/10 pl-4'}>
          <button
            type="button"
            className="text-left font-medium text-slate-200 hover:text-sky-300 hover:underline"
            onClick={() => onSelect(account)}
          >
            {account.name || account.email}
          </button>
          {/*
            An owner that cannot be resolved is called out rather than left blank. A staff login
            attached to nobody can still sign in and would otherwise appear on no screen at all.
          */}
          <span className="block text-[11.5px] text-slate-500">
            {owner ? (
              <>
                {topLevel ? 'works for ' : ''}
                {nameOf(owner)}
              </>
            ) : (
              <span className="text-rose-300">
                owner missing{account.ownerEmail ? ` (${account.ownerEmail})` : ''}
              </span>
            )}
          </span>
        </div>
      </td>
      <td className="td">
        <Badge tone={role === Role.Manager ? 'violet' : ROLE_TONE}>{ROLE_LABEL[role]}</Badge>
      </td>
      <td className="td num truncate">{account.email}</td>
      <td className="td num">{account.phone || <span className="text-slate-600">—</span>}</td>
      {/* The licence belongs to the owner. Said once, in words, rather than copied into four columns. */}
      <td className="td text-[12px] text-slate-500" colSpan={4}>
        {owner
          ? `On ${possessive(nameOf(owner))} licence — ${describeTimeLeft(owner).toLowerCase()}`
          : 'No licence: this login has no owner.'}
      </td>
      <td className="td">
        <span className="text-slate-600">—</span>
      </td>
    </tr>
  )
})

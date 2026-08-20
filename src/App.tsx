import { useEffect, useMemo, useState } from 'react'
import { APP_NAME, CONSOLE_NAME, OFFICIAL_SITE_URL, logoUrl } from './assets/brand'
import { AccountDrawer } from './components/AccountDrawer'
import { CreateAccountModal } from './components/CreateAccountModal'
import { Dashboard } from './components/Dashboard'
import { PaymentModal } from './components/PaymentModal'
import { RevenueReport } from './components/RevenueReport'
import { ShaderBackground } from './components/ShaderBackground'
import { LoginScreen } from './components/LoginScreen'
import { Badge, Button, Input, Notice, Stat } from './components/ui'
import { type AccountFilter, FILTER_LABEL, summarise, visibleAccounts } from './lib/accounts'
import { ApiError, closeSession, isMissingAdminApi, listAccounts, listPayments } from './lib/api'
import { ADMIN_STORAGE } from './lib/config'
import { formatAmount, normalisePhone, reminderMessage, toneFor, whatsappLink } from './lib/outreach'
import type { Payment } from './lib/revenue'
import {
  type AdminAccount,
  describeTimeLeft,
  formatDate,
  isLifetime,
  planLabel,
  subscriptionState,
} from './lib/subscription'

const STATE_TONE = {
  lifetime: 'violet',
  active: 'success',
  expiring: 'warning',
  expired: 'danger',
  unknown: 'neutral',
} as const

export function App() {
  /*
   * Who is in, or '' for nobody. Read from sessionStorage so a refresh does not ask again but
   * closing the tab does — it sits beside the token, which has the same lifetime.
   */
  const [who, setWho] = useState(() => {
    try {
      return sessionStorage.getItem(ADMIN_STORAGE.who) ?? ''
    } catch {
      return ''
    }
  })
  const signedIn = who !== ''
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [missingApi, setMissingApi] = useState(false)

  /** Which screen: the customer table, or the money. */
  const [view, setView] = useState<'accounts' | 'dashboard'>('accounts')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [selected, setSelected] = useState<AdminAccount | null>(null)
  const [creating, setCreating] = useState(false)
  const [paying, setPaying] = useState(false)
  const [reporting, setReporting] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError('')
    setMissingApi(false)
    try {
      /*
       * Both halves together, and **the ledger is allowed to fail on its own**.
       *
       * The accounts are what the console is for; the payments are what the dashboard is for. A
       * backend with accounts but no payments route should still show the table rather than one
       * error covering both, so the ledger settles to empty and the dashboard says it is empty.
       */
      const [nextAccounts, nextPayments] = await Promise.all([
        listAccounts(),
        listPayments().catch(() => [] as Payment[]),
      ])
      setAccounts(nextAccounts)
      setPayments(nextPayments)
    } catch (caught) {
      if (isMissingAdminApi(caught)) {
        setMissingApi(true)
      } else if (caught instanceof ApiError && caught.status === 401) {
        /*
         * The token has lapsed. Back to the door, which **is** the right move now that the door is
         * the server: signing in again mints a new token, and that is the whole fix.
         *
         * It was wrong while the login was a local comparison — there was nothing to renew, so the
         * screen just refused a correct password and sent you straight back. Now the round trip
         * actually resolves it.
         */
        closeSession()
        try {
          sessionStorage.removeItem(ADMIN_STORAGE.who)
        } catch {
          /* ignore */
        }
        setWho('')
      } else if (caught instanceof ApiError && caught.status === 403) {
        /*
         * Authenticated, but not as an administrator — the account is a shop's, or was never
         * promoted. A different fix from the 401, and worth saying so rather than sending somebody
         * to re-type a password that was never wrong.
         */
        setError(
          'The server accepted the sign-in but refused the admin API — that account is not an administrator.',
        )
      } else {
        setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (signedIn) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn])

  const reachable = (account: AdminAccount) => normalisePhone(account.phone) !== ''
  const summary = useMemo(() => summarise(accounts, reachable), [accounts])
  const shown = useMemo(() => visibleAccounts(accounts, { query, filter }), [accounts, query, filter])

  if (!signedIn) return <LoginScreen onIn={setWho} />

  /** Replaces one account in place, or drops it after a delete. */
  const applyChange = (updated: AdminAccount | null) => {
    if (!updated) {
      setAccounts((current) => current.filter((a) => a.id !== selected?.id))
      setSelected(null)
      return
    }
    setAccounts((current) => current.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)))
    setSelected((current) => (current && current.id === updated.id ? { ...current, ...updated } : current))
  }

  return (
    <div className="mx-auto max-w-7xl px-3 py-4 sm:px-5">
      {/* Behind everything. Falls back to the CSS gradient where WebGL is unavailable. */}
      <ShaderBackground />

      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <img src={logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-white/10" />
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-x-2 text-[18px] font-bold leading-tight tracking-tight text-slate-100">
              {APP_NAME}
              <span className="text-[12.5px] font-semibold text-sky-300">{CONSOLE_NAME}</span>
              {who && <span className="text-[12px] font-medium text-slate-500">· {who}</span>}
            </h1>
          <p className="text-[12.5px] text-slate-400">
            {summary.total} account{summary.total === 1 ? '' : 's'} ·{' '}
            {summary.needsRenewal > 0 ? (
              <span className="font-semibold text-amber-300">{summary.needsRenewal} to chase</span>
            ) : (
              'nothing to chase'
            )}
            {summary.unreachable > 0 && (
              <span className="text-rose-300"> · {summary.unreachable} with no usable phone number</span>
            )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* The two screens. A tab rather than a route: there is no deep link worth keeping. */}
          <div className="flex overflow-hidden rounded-xl border border-white/10" role="group" aria-label="View">
            {(
              [
                { id: 'accounts' as const, label: 'Accounts' },
                { id: 'dashboard' as const, label: 'Money' },
              ]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                aria-pressed={view === tab.id}
                className={`px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                  view === tab.id ? 'bg-sky-500/15 text-sky-200' : 'text-slate-300 hover:bg-white/[0.04] hover:text-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <Button onClick={() => void refresh()} loading={loading}>
            Refresh
          </Button>
          <Button onClick={() => setPaying(true)}>Add payment</Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New account
          </Button>
          <a href={OFFICIAL_SITE_URL} target="_blank" rel="noreferrer">
            <Button variant="outline" type="button" title="Open the public MyStockio site">
              Official site ↗
            </Button>
          </a>
          <Button
            variant="ghost"
            onClick={() => {
              closeSession()
              try {
                sessionStorage.removeItem(ADMIN_STORAGE.who)
              } catch {
                /* ignore */
              }
              setWho('')
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      {missingApi && (
        <div className="mb-3">
          <Notice tone="warning">
            <strong className="font-bold">This backend has no admin API yet.</strong> Creating an
            account works — that uses the ordinary signup route — but listing, amending, deleting and
            payments need the endpoints in <code>ADMIN-API-CONTRACT.md</code>. To try everything now,
            run the reference server with <code>npm run api</code> and point{' '}
            <code>src/lib/config.ts</code> at it.
          </Notice>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Notice tone="danger" onDismiss={() => setError('')}>
            {error}
          </Notice>
        </div>
      )}

      {view === 'dashboard' ? (
        <Dashboard
          payments={payments}
          accounts={accounts}
          loading={loading}
          onOpenReport={() => setReporting(true)}
          onAddPayment={() => setPaying(true)}
        />
      ) : (
        <>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="All" value={summary.total} onClick={() => setFilter('all')} />
        <Stat label="To chase" value={summary.needsRenewal} tone="warning" onClick={() => setFilter('needs-renewal')} />
        <Stat label="Expired" value={summary.expired} tone="danger" onClick={() => setFilter('expired')} />
        <Stat label="Expiring" value={summary.expiring} tone="warning" onClick={() => setFilter('expiring')} />
        <Stat label="Active" value={summary.active} tone="success" onClick={() => setFilter('active')} />
        <Stat label="Lifetime" value={summary.lifetime} tone="violet" onClick={() => setFilter('lifetime')} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search shop, owner, email or phone…"
          className="sm:w-80"
        />
        <select className="field w-auto" value={filter} onChange={(event) => setFilter(event.target.value as AccountFilter)}>
          {(Object.keys(FILTER_LABEL) as AccountFilter[]).map((key) => (
            <option key={key} value={key}>
              {FILTER_LABEL[key]}
            </option>
          ))}
        </select>
        <span className="text-[12.5px] text-slate-500">
          {shown.length} shown
          {summary.unknown > 0 && ` · ${summary.unknown} with no subscription data`}
        </span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="th">Shop</th>
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
            {shown.length === 0 ? (
              <tr>
                <td className="td text-center text-slate-500" colSpan={8}>
                  {loading ? 'Loading…' : accounts.length === 0 ? 'No accounts yet.' : 'Nothing matches that.'}
                </td>
              </tr>
            ) : (
              shown.map((account) => {
                const state = subscriptionState(account)
                const link = whatsappLink(account, reminderMessage(account, toneFor(account)))
                return (
                  <tr key={account.id} className="group hover:bg-slate-800/40">
                    <td className="td">
                      <button type="button" className="text-left font-semibold text-sky-300 hover:underline" onClick={() => setSelected(account)}>
                        {account.shopName || account.name || '(no name)'}
                      </button>
                      {account.name && account.shopName && (
                        <span className="block text-[11.5px] text-slate-500">{account.name}</span>
                      )}
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
                      {account.lastPaymentAt
                        ? `₹${formatAmount(account.lastPaymentAmount ?? 0)}`
                        : <span className="text-slate-600">—</span>}
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
            )}
          </tbody>
        </table>
      </div>
        </>
      )}

      {selected && <AccountDrawer account={selected} onClose={() => setSelected(null)} onChanged={applyChange} />}
      {creating && (
        <CreateAccountModal
          onClose={() => setCreating(false)}
          onCreated={(account) => {
            /* Straight into the list — a created account that needs a refresh to appear reads as a
               failure, and the operator retries and creates a duplicate. */
            setAccounts((current) => [account, ...current.filter((a) => a.id !== account.id)])
          }}
        />
      )}
      {paying && (
        <PaymentModal
          accounts={accounts}
          preselected={selected}
          onClose={() => setPaying(false)}
          onRecorded={(account) => {
            applyChange(account)
            /*
             * Re-read the ledger rather than appending a guess. The server assigns the id, the
             * timestamp and the recorded-by, and a dashboard built from a locally-invented row would
             * disagree with the report printed from the same screen a minute later.
             */
            void listPayments()
              .then(setPayments)
              .catch(() => {
                /* The entry is saved; the chart catching up can wait for Refresh. */
              })
          }}
        />
      )}
      {reporting && (
        <RevenueReport payments={payments} accounts={accounts} onClose={() => setReporting(false)} />
      )}
    </div>
  )
}

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { APP_NAME, CONSOLE_NAME, OFFICIAL_SITE_URL, logoUrl } from './assets/brand'
import { AccountDrawer } from './components/AccountDrawer'
import { AccountsTable } from './components/AccountsTable'
import { CreateAccountModal } from './components/CreateAccountModal'
import { Dashboard } from './components/Dashboard'
import { PaymentModal } from './components/PaymentModal'
import { RevenueReport } from './components/RevenueReport'
import { LoginScreen } from './components/LoginScreen'
import { Button, Input, Notice, Stat } from './components/ui'
import { type AccountFilter, FILTER_LABEL, summarise, visibleAccounts } from './lib/accounts'
import { ApiError, closeSession, isMissingAdminApi, listAccounts, listPayments } from './lib/api'
import { ADMIN_STORAGE } from './lib/config'
import { normalisePhone } from './lib/outreach'
import type { Payment } from './lib/revenue'
import type { AdminAccount } from './lib/subscription'

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
  /** Why the money ledger is empty, when it is empty because something failed. */
  const [ledgerError, setLedgerError] = useState('')

  /** Which screen: the customer table, or the money. */
  const [view, setView] = useState<'accounts' | 'dashboard'>('accounts')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [selected, setSelected] = useState<AdminAccount | null>(null)
  const [creating, setCreating] = useState(false)
  /** When the create form was opened from an owner row: the owner the new login belongs to. */
  const [staffFor, setStaffFor] = useState<AdminAccount | null>(null)
  const [paying, setPaying] = useState(false)
  const [reporting, setReporting] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError('')
    setMissingApi(false)
    setLedgerError('')
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
        /*
         * The ledger may fail on its own — but **not silently**.
         *
         * This used to swallow the error and settle to an empty array, which meant a payments route
         * that was missing, refusing or misbehaving produced a money screen reading ₹0 with no
         * indication anything had gone wrong. On a screen about money, a confident zero is worse
         * than an error: nobody investigates a number that looks like an answer.
         */
        listPayments().catch((caught: unknown) => {
          setLedgerError(caught instanceof ApiError ? caught.message : (caught as Error).message)
          return [] as Payment[]
        }),
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
  /*
   * The list follows the typing, it does not gate it.
   *
   * Filtering a few thousand rows and re-rendering the table is real work — measured at tens of
   * milliseconds, and over 200ms on a long list — and doing it inside the keystroke is what made
   * typing feel like wading. `useDeferredValue` splits the two: the character appears immediately
   * because that render only touches the input, and the table catches up in a second, interruptible
   * render that a further keystroke simply supersedes.
   *
   * So the cost of the list no longer lands on the person typing, however long the list gets.
   */
  const deferredQuery = useDeferredValue(query)
  const shown = useMemo(
    () => visibleAccounts(accounts, { query: deferredQuery, filter }),
    [accounts, deferredQuery, filter],
  )
  /** True while the table is a keystroke or two behind, so the count can say so instead of lying. */
  const catchingUp = deferredQuery !== query

  /*
   * Stable, because the table's rows are memoised on their props.
   *
   * An inline arrow here would be a new function on every render, every row would see a changed prop,
   * and every row would re-render — quietly undoing the memoisation a keystroke away.
   */
  const addStaffTo = useCallback((owner: AdminAccount) => {
    /* Straight into the create form as staff, already pointed at this owner. */
    setStaffFor(owner)
    setCreating(true)
  }, [])

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
      {/*
        ── No shader on this screen, deliberately ──────────────────────────────
        The WebGL background draws a full-screen quad thirty times a second, forever, and this is
        the screen with the long table, the search box and the forms — the one place where the
        browser needs its frames for something a person is waiting on.

        The CSS gradient underneath (`index.css`) keeps the same palette and the same slow drift for
        the price of one transform on a composited layer, which is close to free. So the decoration
        stays where it costs nothing and the console gets its frames back. The shader still greets
        you on the login screen, which has two fields and nothing to re-render.
      */}

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
            {summary.total} owner{summary.total === 1 ? '' : 's'}
            {summary.staff > 0 && ` · ${summary.staff} staff login${summary.staff === 1 ? '' : 's'}`} ·{' '}
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
          ledgerError={ledgerError}
          payments={payments}
          accounts={accounts}
          loading={loading}
          onOpenReport={() => setReporting(true)}
          onAddPayment={() => setPaying(true)}
        />
      ) : (
        <>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <Stat label="All" value={summary.total} onClick={() => setFilter('all')} />
        <Stat label="To chase" value={summary.needsRenewal} tone="warning" onClick={() => setFilter('needs-renewal')} />
        <Stat label="Expired" value={summary.expired} tone="danger" onClick={() => setFilter('expired')} />
        <Stat label="Expiring" value={summary.expiring} tone="warning" onClick={() => setFilter('expiring')} />
        <Stat label="Active" value={summary.active} tone="success" onClick={() => setFilter('active')} />
        <Stat label="Lifetime" value={summary.lifetime} tone="violet" onClick={() => setFilter('lifetime')} />
        {/* Staff sit apart from every other tile: they are logins, not customers, and hold no licence. */}
        <Stat label="Staff logins" value={summary.staff} tone="info" onClick={() => setFilter('staff')} />
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
          {/*
            While the table is a keystroke behind, the count says so. Showing the old number as
            though it were the answer to what was just typed is the one thing deferring must not do.
          */}
          {shown.length} shown
          {catchingUp && <span className="text-slate-600"> · filtering…</span>}
          {summary.unknown > 0 && ` · ${summary.unknown} with no subscription data`}
        </span>
      </div>

      <AccountsTable
        rows={shown}
        accounts={accounts}
        loading={loading}
        onSelect={setSelected}
        onAddStaff={addStaffTo}
      />
        </>
      )}

      {selected && (
        <AccountDrawer account={selected} accounts={accounts} onClose={() => setSelected(null)} onChanged={applyChange} />
      )}
      {creating && (
        <CreateAccountModal
          accounts={accounts}
          staffFor={staffFor}
          onClose={() => {
            setCreating(false)
            setStaffFor(null)
          }}
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

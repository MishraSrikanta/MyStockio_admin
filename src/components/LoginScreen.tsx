/**
 * The way in: an email and a password, checked **by the server**.
 *
 * ── What changed, and why it is the better arrangement ─────────────────────────
 * There was a list of ids and passwords compiled into this app, compared here in the browser. It is
 * gone. Whatever is typed goes to `POST api/v1/admin/login` and the server's answer decides
 * everything.
 *
 * That fixes the one flaw the old design could never fix. A credential in the bundle is readable by
 * anyone who can load the page — View Source, or one glance at the network tab — so the local
 * comparison only ever stopped somebody who was not looking. A password only the server knows cannot
 * be extracted from a page at all. Administrators are managed in the backend now, where they can be
 * added and revoked without a rebuild.
 *
 * It also means this screen **blocks on the request**, deliberately, where the old one could not. It
 * is no longer possible to be "signed in" without a token: the token *is* the sign-in.
 *
 * ── Reporting failures ─────────────────────────────────────────────────────────
 * The server's own sentence is shown as written. The three answers mean different things and lead to
 * different fixes, so they are not flattened into one message:
 *
 *   · **401** — those credentials are wrong. Retype them.
 *   · **403** — the account is real, but it is not an administrator. Retyping will never help; it
 *     needs promoting in the backend.
 *   · **network / timeout** — nothing was decided. The server is down or unreachable, which is not
 *     the same as being refused, and saying "wrong password" here would send somebody hunting for a
 *     password that was correct.
 */

import { useState } from 'react'
import { APP_NAME, CONSOLE_NAME, OFFICIAL_SITE_URL, logoUrl } from '@/assets/brand'
import { ApiError, signIn } from '@/lib/api'
import { ADMIN_STORAGE } from '@/lib/config'
import { ShaderBackground } from './ShaderBackground'
import { Button, Input } from './ui'

export function LoginScreen({ onIn }: { onIn: (who: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setHint('')
    setBusy(true)

    try {
      const account = await signIn(email, password)
      /*
       * Whatever the server calls them, for the header. Falling back to the typed email rather than
       * to a placeholder: a backend that returns only a token still leaves the screen able to say
       * who is signed in.
       */
      const who = account?.name || account?.shopName || account?.email || email.trim()
      try {
        sessionStorage.setItem(ADMIN_STORAGE.who, who)
      } catch {
        /* private browsing — the session lasts for this view only */
      }
      onIn(who)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) {
        setError('That account is not an administrator.')
        setHint('The password was accepted. An administrator has to be promoted in the backend — retyping it will not help.')
      } else if (caught instanceof ApiError && (caught.code === 'NETWORK' || caught.code === 'TIMEOUT')) {
        /* Not a refusal. Nothing was decided, and the credentials may be perfectly good. */
        setError(caught.message)
        setHint('Nothing was rejected — the server did not answer. Check that it is running, then try again.')
      } else {
        setError(caught instanceof ApiError ? caught.message : (caught as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <ShaderBackground />

      <form onSubmit={submit} className="card w-full max-w-sm overflow-hidden">
        {/* The brand rule sits flush to the card edge, which is why the padding starts below it. */}
        <div className="accent-rule rounded-none" />

        <div className="p-5">
          <div className="flex items-center gap-3">
            <img
              src={logoUrl}
              alt=""
              className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-white/10"
            />
            <div className="min-w-0">
              <h1 className="text-[18px] font-bold leading-tight tracking-tight text-slate-100">
                {APP_NAME}
              </h1>
              <p className="text-[12.5px] font-semibold text-sky-300">{CONSOLE_NAME}</p>
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-slate-400">
            Accounts, subscriptions, payments and renewal reminders.
          </p>

          <div className="mt-4 space-y-3">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setError('')
                setHint('')
              }}
              autoComplete="username"
              autoFocus
              placeholder="you@yourdomain.com"
            />
            <Input
              label="Password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                setError('')
                setHint('')
              }}
              autoComplete="current-password"
              error={error || undefined}
            />
            <label className="flex items-center gap-2 text-[12.5px] text-slate-400">
              <input
                type="checkbox"
                checked={show}
                onChange={(event) => setShow(event.target.checked)}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              Show password
            </label>
          </div>

          <Button
            type="submit"
            variant="primary"
            className="mt-4 w-full"
            loading={busy}
            disabled={!email || !password}
          >
            Sign in
          </Button>

          {/* The follow-up sentence, when the failure needs one. The error itself sits on the field. */}
          {hint && (
            <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-200">
              {hint}
            </p>
          )}

          <a
            href={OFFICIAL_SITE_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block text-center text-[13px] font-semibold text-sky-300 hover:underline"
          >
            Visit the official MyStockio site ↗
          </a>

          <p className="mt-3 text-[11.5px] leading-relaxed text-slate-500">
            Checked by the server. Administrators are managed in the backend — no password is stored
            in this app.
          </p>
        </div>
      </form>
    </div>
  )
}

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import {
  ApiError,
  fetchAccountSession,
  fetchSession,
  hasExplicitBrowserApiKey,
  loginWithPassword,
  setupDashboardPassword,
  setOnAuthExpired,
  signInWithAccount,
  type ApiAccountSession,
} from '../../api.js'
import { AccountProvider, type SignedInAccount } from '../../contexts/account-context.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { createQueryClient } from '../../queries/query-client.js'
import { createAppRouter } from '../../router/router.js'
import { Button } from '../ui/button.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'

const SESSION_RECHECK_MS = 60_000

/**
 * `account-login` is the named-account sign-in. `setup` and `login` are the
 * older shared-password screens, which apply only to an install that has no
 * accounts at all — and which the server refuses once any account exists.
 */
type AuthState = 'checking' | 'ready' | 'setup' | 'login' | 'account-login'

export function AuthGate() {
  const [authState, setAuthState] = useState<AuthState>(
    hasExplicitBrowserApiKey() ? 'ready' : 'checking',
  )
  const [account, setAccount] = useState<SignedInAccount | null>(null)
  const [accountsInUse, setAccountsInUse] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)

  // Lazy-initialize router + query client only when needed for rendering.
  //
  // Both are rebuilt whenever the person changes. The cache holds whatever the
  // PREVIOUS account was allowed to read — an administrator's provider settings,
  // for instance — and a cache that outlives a sign-out hands that straight to
  // whoever signs in next on the same tab. Keying it to the principal makes the
  // cache's lifetime the session's lifetime.
  const routerRef = useRef<ReturnType<typeof createAppRouter> | null>(null)
  const queryClientRef = useRef<ReturnType<typeof createQueryClient> | null>(null)
  const cachedForPrincipalRef = useRef<string | null>(null)
  const getRouter = () => {
    const principalKey = account ? `${account.name}:${account.role}` : 'no-accounts'
    if (!routerRef.current || cachedForPrincipalRef.current !== principalKey) {
      queryClientRef.current?.clear()
      const qc = createQueryClient()
      queryClientRef.current = qc
      routerRef.current = createAppRouter(qc)
      cachedForPrincipalRef.current = principalKey
    }
    return { queryClient: queryClientRef.current!, router: routerRef.current! }
  }

  const applyAccountSession = (session: ApiAccountSession): boolean => {
    if (!session.authRequired) return false
    setAccountsInUse(true)
    setAccount(session.user)
    setAuthState(session.user ? 'ready' : 'account-login')
    return true
  }

  // Initial session check.
  //
  // Both questions go out together rather than one after the other: asking the
  // account-aware one first and only then the older one would put a second
  // round trip in front of every page load, on an install where the answer to
  // the first is almost always "no accounts". The account answer WINS when it
  // says accounts are in use; otherwise the older shared-password answer
  // decides, exactly as it always did.
  useEffect(() => {
    if (hasExplicitBrowserApiKey()) return

    let cancelled = false
    void Promise.allSettled([fetchAccountSession(), fetchSession()])
      .then(([accountResult, legacyResult]) => {
        if (cancelled) return

        if (accountResult.status === 'fulfilled' && applyAccountSession(accountResult.value)) {
          return
        }

        if (legacyResult.status === 'rejected') {
          const err: unknown = legacyResult.reason
          setError(err instanceof Error ? err.message : 'Failed to reach the Canonry API')
          setAuthState('login')
          return
        }

        const session = legacyResult.value
        if (session.authenticated) {
          setAuthState('ready')
        } else {
          setAuthState(session.setupRequired ? 'setup' : 'login')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Periodic session re-check + auth expiry callback while authenticated.
  // Skipped in explicit-API-key mode — those users have no login form to fall
  // back to, so kicking them out of the dashboard would strand them.
  useEffect(() => {
    if (authState !== 'ready') return
    if (hasExplicitBrowserApiKey()) return

    // Periodic re-check. Only kick on a confirmed signed-out response —
    // transient network errors should not silently log the user out. A real
    // session loss will surface through the apiFetch 401 interceptor below the
    // next time any request fires.
    const interval = setInterval(() => {
      if (accountsInUse) {
        fetchAccountSession()
          .then((session) => {
            if (session.authRequired && !session.user) {
              setSessionExpired(true)
              setAccount(null)
              setAuthState('account-login')
            }
          })
          .catch(() => {
            // Leave the user where they are; the next real request will catch it.
          })
        return
      }
      fetchSession()
        .then((session) => {
          if (!session.authenticated) {
            setSessionExpired(true)
            setAuthState(session.setupRequired ? 'setup' : 'login')
          }
        })
        .catch(() => {
          // Network error or transient failure — leave the user on the
          // dashboard; the next real API call will catch a 401/403.
        })
    }, SESSION_RECHECK_MS)

    // Immediate auth expiry handler (triggered by apiFetch on 401/403)
    setOnAuthExpired(() => {
      setSessionExpired(true)
      setAccount(null)
      setAuthState(accountsInUse ? 'account-login' : 'login')
    })

    return () => {
      clearInterval(interval)
      setOnAuthExpired(null)
    }
  }, [authState, accountsInUse])

  const handleSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password.trim() || password.trim().length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const session = await setupDashboardPassword(password.trim())
      if (!session.authenticated) {
        setError('Setup failed')
        return
      }
      setPassword('')
      setConfirmPassword('')
      setSessionExpired(false)
      setAuthState('ready')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      const session = await loginWithPassword(password.trim())
      if (!session.authenticated) {
        setError('Incorrect password')
        return
      }
      setPassword('')
      setSessionExpired(false)
      setAuthState('ready')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAccountSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || !password) return

    setSubmitting(true)
    setError(null)
    try {
      const session = await signInWithAccount(name.trim(), password)
      if (!session.user) {
        setError('Incorrect name or password.')
        return
      }
      setPassword('')
      setSessionExpired(false)
      setAccount(session.user)
      setAuthState('ready')
    } catch (err) {
      // The server answers the same way for every failure, so whatever it says
      // is what the person is shown.
      setError(err instanceof ApiError ? err.message : 'Incorrect name or password.')
    } finally {
      setSubmitting(false)
    }
  }

  if (authState === 'ready') {
    const { queryClient, router } = getRouter()
    return (
      <AccountProvider account={account}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AccountProvider>
    )
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col items-center justify-center gap-5">
        {/* The first screen a client ever sees, often before they know what
            the product is. Plain markup rather than <BrandLockup>, which is
            built on router <Link>s — this gate renders before the router. */}
        <div data-testid="auth-brand" className="flex items-center gap-2.5">
          <img className="size-7" src="./favicon.svg" alt="" aria-hidden="true" />
          <span className="text-lg font-semibold tracking-tight text-heading">Canonry</span>
        </div>
        <Card className="surface-card w-full">
          {authState === 'checking' ? (
            <CardContent className="py-8">
              <p className="supporting-copy text-center">Connecting to Canonry…</p>
            </CardContent>
          ) : authState === 'account-login' ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard access</p>
                <CardTitle>Sign in to Canonry</CardTitle>
              </CardHeader>
              <CardContent>
                {sessionExpired ? (
                  <p className="mb-4 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm text-caution">
                    You were signed out — please sign in again.
                  </p>
                ) : null}
                <form className="space-y-4" onSubmit={asyncHandler(handleAccountSignIn)}>
                  <label className="block space-y-1.5" htmlFor="account-name">
                    <span className="text-xs font-medium text-secondary">Name</span>
                    <input
                      autoFocus
                      id="account-name"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="text"
                      autoComplete="username"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5" htmlFor="account-password">
                    <span className="text-xs font-medium text-secondary">Password</span>
                    <input
                      id="account-password"
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  {error ? <p className="text-sm text-negative-400">{error}</p> : null}
                  <Button type="submit" disabled={submitting || !name.trim() || !password}>
                    {submitting ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : authState === 'setup' ? (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">First-time setup</p>
                <CardTitle>Create a dashboard password</CardTitle>
                <CardDescription>
                  Choose a password to protect the Canonry dashboard.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={asyncHandler(handleSetup)}>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-secondary">Password</span>
                    <input
                      autoFocus
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="At least 8 characters"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-secondary">Confirm password</span>
                    <input
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      placeholder="Re-enter password"
                    />
                  </label>
                  {error ? <p className="text-sm text-negative-400">{error}</p> : null}
                  <Button type="submit" disabled={submitting || !password.trim() || !confirmPassword.trim()}>
                    {submitting ? 'Setting up…' : 'Create password & open dashboard'}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <p className="eyebrow eyebrow-soft">Dashboard access</p>
                <CardTitle>Sign in to Canonry</CardTitle>
                <CardDescription>
                  Enter your dashboard password to continue.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {sessionExpired ? (
                  <p className="mb-4 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm text-caution">
                    Your session expired — please sign in again.
                  </p>
                ) : null}
                <form className="space-y-4" onSubmit={asyncHandler(handleLogin)}>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-secondary">Password</span>
                    <input
                      autoFocus
                      className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading outline-none transition focus:border-mono-600"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Dashboard password"
                    />
                  </label>
                  {error ? <p className="text-sm text-negative-400">{error}</p> : null}
                  <Button type="submit" disabled={submitting || !password.trim()}>
                    {submitting ? 'Signing in…' : 'Open dashboard'}
                  </Button>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

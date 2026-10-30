/**
 * Password-reset completion (planning section 4, the other half of the
 * login page's "Forgot password?" option).
 *
 * The reset mail links here:
 *   /account/password/reset?token=<uidb36>-<key>
 * — that path comes from the backend's HEADLESS_FRONTEND_URLS (both reset
 * urlnames point at it), so it must match the SPA route exactly.
 *
 * The page checks the token on mount (GET auth/password/reset,
 * X-Password-Reset-Key) so an expired or malformed link is told to the
 * user immediately, then takes a new password and completes the reset
 * (POST auth/password/reset). The backend sets the password but does not
 * sign the user in, so the auth service auto-logs-in with the new
 * credentials (src/auth/authService.js, resetPassword); success leads to
 * Search.
 *
 * Routing note: this route is deliberately NOT wrapped in the
 * authenticated-redirect guard. The endpoint is public, a signed-in user
 * may legitimately need to finish a reset (two tabs, a stale session…),
 * and after a successful reset the store flips to authenticated anyway —
 * which makes the /login guard do the right thing afterwards.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { useAuth } from '../auth'

// Client-side mirror of the backend's MinimumLengthValidator (8 characters)
// — the backend re-validates and its messages win; this only catches the
// obvious before a round-trip (same convention as the signup page).
const MIN_PASSWORD_LENGTH = 8

function Field({ id, label, error, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** A form-level (non-field) result message from the backend. */
function FormMessage({ tone, message }) {
  if (!message) return null
  return (
    <p className={`form-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {message}
    </p>
  )
}

export default function ResetPasswordPage() {
  const { actions } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  // 'checking' (token being validated) | 'form' (take a new password) |
  // 'invalid' (the link is missing/invalid/expired) | 'done' (password
  // was changed; the follow-up sign-in needs the user)
  const [phase, setPhase] = useState('checking')
  const [email, setEmail] = useState(null)
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [note, setNote] = useState(null)
  const [saving, setSaving] = useState(false)

  // The link check on mount. It is a read-only GET, so StrictMode's
  // double-invoked effect is harmless (a duplicate check of the same
  // token); no in-flight guard needed. A tokenless link needs no request
  // at all — its invalid state is derived in the render below.
  // (`actions` is a stable module-level constant.)
  useEffect(() => {
    if (!token) return
    let cancelled = false
    actions
      .verifyResetLink(token)
      .then((result) => {
        if (cancelled) return
        if (result.ok && result.status === 'link_valid') {
          setEmail(result.user?.email ?? null)
          setPhase('form')
          return
        }
        if (result.status === 'link_invalid') {
          setFormError(result.error?.message ?? 'This reset link is no longer valid.')
          setPhase('invalid')
          return
        }
        // The check itself failed (usually: the backend is unreachable).
        // Don't block the form on it — the reset POST will tell the user
        // the same truth, and a transient blip shouldn't strand them.
        setNote('We couldn’t verify this link right now, but you can still try.')
        setPhase('form')
      })
    return () => {
      cancelled = true
    }
    // token comes from the URL; a changed link re-checks on purpose.
    // (`actions` is a stable module-level constant — including it is safe.)
  }, [token, actions])

  async function submitReset(event) {
    event.preventDefault()
    if (saving || !token) return

    if (!password) {
      setFieldErrors({ password: 'Choose a new password.' })
      setFormError(null)
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFieldErrors({
        password: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      })
      setFormError(null)
      return
    }
    setFieldErrors({})

    setSaving(true)
    try {
      const result = await actions.resetPassword({
        key: token,
        email: email ?? '',
        password,
      })

      if (result.ok && result.status === 'authenticated') {
        // Reset done and signed in — off to Search.
        navigate('/search', { replace: true })
        return
      }

      if (result.resetCompleted) {
        // The password WAS changed; the follow-up sign-in did not
        // complete (verification still pending, a rate limit, the
        // backend went away, …). Tell the user both facts and hand
        // them to the login page, where the new password works.
        setPhase('done')
        setFormError(null)
        setNote(
          result.status === 'verification_pending'
            ? 'Your password has been changed. This account still needs to verify its email — log in and enter the code we just emailed.'
            : 'Your password has been changed, but we could not sign you in automatically. Log in with your new password.'
        )
        return
      }

      // The reset itself failed (invalid/expired token, a rejected
      // password, a rate limit, the backend unreachable): stay on the
      // form with the backend's message — the user can fix and retry.
      setFormError(result.error?.message ?? null)
      setFieldErrors({})
      setNote(null) // the "couldn't verify" note, if any, is stale now
    } finally {
      setSaving(false)
    }
  }

  const backToLogin = (
    <p className="auth-switch">
      <Link to="/login">Back to log in</Link>
    </p>
  )

  // Once the reset is complete the token no longer matters, so that state
  // renders first.
  if (phase === 'done') {
    return (
      <main className="auth-page">
        <h1>Reset your password</h1>
        <FormMessage tone="note" message={note} />
        {backToLogin}
      </main>
    )
  }

  // A link that never carried a token is structurally invalid — derived
  // straight from the URL (no request, no state; the effect skips it).
  if (!token) {
    return (
      <main className="auth-page">
        <h1>Reset your password</h1>
        <FormMessage
          tone="error"
          message="This link is missing its reset token. Please request a new link from the log in page."
        />
        {backToLogin}
      </main>
    )
  }

  if (phase === 'checking') {
    return (
      <main className="auth-page">
        <h1>Reset your password</h1>
        <p className="auth-intro">Checking this link…</p>
      </main>
    )
  }

  if (phase === 'invalid') {
    return (
      <main className="auth-page">
        <h1>Reset your password</h1>
        <FormMessage tone="error" message={formError} />
        {backToLogin}
      </main>
    )
  }

  return (
    <main className="auth-page">
      <h1>Reset your password</h1>
      <p className="auth-intro">
        {email ? (
          <>
            Choose a new password for <strong>{email}</strong>.
          </>
        ) : (
          'Choose a new password.'
        )}
      </p>
      <form onSubmit={submitReset} noValidate>
        <Field id="password" label="New password" error={fieldErrors.password}>
          <input
            id="password"
            className="text-input"
            type="password"
            autoComplete="new-password"
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? 'password-error' : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <FormMessage tone="error" message={formError} />
        <FormMessage tone="note" message={note} />
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : 'Save new password'}
        </button>
      </form>
      {backToLogin}
    </main>
  )
}

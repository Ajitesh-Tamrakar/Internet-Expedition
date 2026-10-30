/**
 * The login page (planning section 4).
 *
 *  - Email + Password + "Login", a link to the signup page, and a
 *    "Forgot password?" option. The recovery option is presented because
 *    the backend supports the flow (allauth's password reset, mounted at
 *    the headless paths; docs/authentication.md — the reset mail link
 *    opens /account/password/reset, handled by ResetPasswordPage).
 *  - A successful login establishes the session (cookies — the SPA never
 *    holds a token) and leads the user to Search.
 *  - An account the backend reports as *unverified* (401 + pending
 *    verify_email — a fresh code was just emailed) is NOT treated as
 *    signed in: the page moves to the same verify step the signup page
 *    uses; entering the code completes the login.
 *  - "Forgot password?" swaps the form to a single email field; sending
 *    it asks the backend for a reset link (the 200 is
 *    enumeration-safe, so the confirmation is phrased "if an account
 *    exists, …").
 *
 * The page branches on the auth service's result `status` values
 * (src/auth/authService.js), never on HTTP codes.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth'

// Client-side mirror of the obvious rules (an @ in the email, a present
// password). The backend re-validates everything and its messages win —
// this only catches the empty/obviously-wrong before a round-trip. (No
// minimum length for login: the length validator applies when *setting*
// a password, not when presenting one.)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateDetails({ email, password }) {
  const errors = {}
  if (!email.trim()) errors.email = 'Email is required.'
  else if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address.'
  if (!password) errors.password = 'Password is required.'
  return errors
}

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

/** One step's shared input, wired to a field-error for a11y. */
function TextInput({ id, error, ...inputProps }) {
  return (
    <input
      id={id}
      className="text-input"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      {...inputProps}
    />
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

export default function LoginPage() {
  const { actions } = useAuth()
  const navigate = useNavigate()

  // 'login' (email+password or the forgot-password variant) | 'verify'
  // (reached only when a login attempt reported an unverified account).
  const [mode, setMode] = useState('login') // 'login' | 'forgot'
  const [step, setStep] = useState('credentials') // 'credentials' | 'verify'
  const [details, setDetails] = useState({ email: '', password: '' })
  const [code, setCode] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [note, setNote] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  const setDetail = (name) => (event) =>
    setDetails((current) => ({ ...current, [name]: event.target.value }))

  // ------------------------------------------------------------------ login

  async function submitLogin(event) {
    event.preventDefault()
    if (submitting) return

    const errors = validateDetails(details)
    setFieldErrors(errors)
    setFormError(null)
    if (Object.keys(errors).length > 0) return

    setSubmitting(true)
    try {
      const result = await actions.login({
        email: details.email.trim(),
        password: details.password,
      })

      if (result.ok && result.status === 'authenticated') {
        // The session is live — the auth guard would bounce this page to
        // Search anyway; go there deliberately.
        navigate('/search', { replace: true })
        return
      }

      if (result.status === 'verification_pending') {
        // The backend refused to authenticate an unverified account, but
        // it just emailed a fresh code — completing the login is one code
        // away, on this same page (the pending flow is resumable).
        setStep('verify')
        setCode('')
        setFieldErrors({})
        setFormError(null)
        setNote(null)
        return
      }

      if (result.status === 'already_authenticated') {
        // A live session already exists (409): confirm it with the
        // session endpoint (which also populates the store, so the Search
        // route's guard passes) and go.
        await actions.getSession()
        navigate('/search', { replace: true })
        return
      }

      // credentials_invalid / rate_limited / unauthenticated / error:
      // the backend's message (or a fallback) tells the user what
      // happened; they stay on the form and can fix the inputs.
      setFormError(result.error?.message ?? null)
    } finally {
      setSubmitting(false)
    }
  }

  // ------------------------------------------------------------------ verify

  async function completeVerification(event) {
    event?.preventDefault?.()
    if (verifying) return
    if (!/^\d{6}$/.test(code)) {
      setFieldErrors({ code: 'Enter the 6-digit code from the email.' })
      setFormError(null)
      return
    }
    setFieldErrors({})

    setVerifying(true)
    try {
      const result = await actions.verifyEmail(code)
      if (result.ok && result.status === 'authenticated') {
        // The login completes with the verified email; off to Search.
        navigate('/search', { replace: true })
        return
      }
      // invalid_code (retryable), flow_expired / session_gone /
      // no_pending_flow (the flow is dead — "start over" below), error.
      setFormError(result.error?.message ?? null)
      setFieldErrors({})
    } finally {
      setVerifying(false)
    }
  }

  async function resend() {
    if (resending || verifying) return

    setResending(true)
    setFormError(null)
    try {
      const result = await actions.resendVerification()
      if (result.ok && result.status === 'resent') {
        setNote(`A new code was sent to ${details.email}. The previous one no longer works.`)
      } else {
        // flow_expired (quota reached or flow over — the code field stays
        // usable: a recently emailed code may still verify), session_gone,
        // no_pending_flow, error.
        setFormError(result.error?.message ?? null)
        setNote(null)
      }
    } finally {
      setResending(false)
    }
  }

  /** Back to the login form — the recovery path for a dead/expired verification. */
  function startOver() {
    setStep('credentials')
    setCode('')
    setFieldErrors({})
    setFormError(null)
    setNote(null)
  }

  // ------------------------------------------------------------------ forgot

  async function sendResetLink(event) {
    event.preventDefault()
    if (sendingReset) return

    // Only the email matters in this mode (the password validator part of
    // validateDetails is irrelevant to a reset request).
    const email = details.email.trim()
    const errors = {}
    if (!email) errors.email = 'Email is required.'
    else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.'
    setFieldErrors(errors)
    setFormError(null)
    if (Object.keys(errors).length > 0) return

    setSendingReset(true)
    try {
      const result = await actions.requestPasswordReset({ email })
      if (result.ok && result.status === 'requested') {
        // Enumeration-safe: the backend answers the same 200 whether or
        // not the address is registered.
        setFormError(null)
        setNote(
          `If an account exists for ${email}, a password reset link is on its way. ` +
            'When it arrives, open it to choose a new password.'
        )
      } else {
        // validation / rate_limited / error.
        setFormError(result.error?.message ?? null)
        setNote(null)
      }
    } finally {
      setSendingReset(false)
    }
  }

  function backToLogin() {
    setMode('login')
    setStep('credentials')
    setDetails((current) => ({ ...current, password: '' }))
    setFieldErrors({})
    setFormError(null)
    setNote(null)
  }

  // ------------------------------------------------------------------ render

  if (mode === 'forgot') {
    return (
      <main className="auth-page">
        <h1>Reset your password</h1>
        <p className="auth-intro">
          Enter the email you sign in with and we’ll send you a link to choose a new
          password.
        </p>
        <form onSubmit={sendResetLink} noValidate>
          <Field id="email" label="Email" error={fieldErrors.email}>
            <TextInput
              id="email"
              type="email"
              autoComplete="email"
              value={details.email}
              onChange={setDetail('email')}
              error={fieldErrors.email}
            />
          </Field>
          <FormMessage tone="error" message={formError} />
          <FormMessage tone="note" message={note} />
          <button type="submit" className="btn" disabled={sendingReset}>
            {sendingReset ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
        <p className="auth-switch">
          <button type="button" className="link" onClick={backToLogin}>
            Back to log in
          </button>
        </p>
      </main>
    )
  }

  if (step === 'verify') {
    return (
      <main className="auth-page">
        <h1>Verify Email</h1>
        <p className="auth-intro">
          We sent a 6-digit code to <strong>{details.email}</strong>. Enter it below to
          sign in.
        </p>
        <form onSubmit={completeVerification} noValidate>
          <Field id="code" label="6-digit code" error={fieldErrors.code}>
            <TextInput
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="••••••"
              className="code-input"
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
              error={fieldErrors.code}
            />
          </Field>
          <FormMessage tone="error" message={formError} />
          <FormMessage tone="note" message={note} />
          <button type="submit" className="btn" disabled={verifying}>
            {verifying ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={resend}
            disabled={resending || verifying}
          >
            {resending ? 'Resending…' : 'Resend OTP'}
          </button>
        </form>
        {formError ? (
          <p className="auth-switch">
            <button type="button" className="link" onClick={startOver}>
              Start over
            </button>
          </p>
        ) : null}
        <p className="auth-switch">
          Don’t have an account? <Link to="/signup">Sign up</Link>
        </p>
      </main>
    )
  }

  return (
    <main className="auth-page">
      <h1>Log in</h1>
      <form onSubmit={submitLogin} noValidate>
        <Field id="email" label="Email" error={fieldErrors.email}>
          <TextInput
            id="email"
            type="email"
            autoComplete="email"
            value={details.email}
            onChange={setDetail('email')}
            error={fieldErrors.email}
          />
        </Field>
        <Field id="password" label="Password" error={fieldErrors.password}>
          <TextInput
            id="password"
            type="password"
            autoComplete="current-password"
            value={details.password}
            onChange={setDetail('password')}
            error={fieldErrors.password}
          />
        </Field>
        <FormMessage tone="error" message={formError} />
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Login'}
        </button>
        <p className="auth-switch">
          <button type="button" className="link" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
        </p>
      </form>
      <p className="auth-switch">
        Don’t have an account? <Link to="/signup">Sign up</Link>
      </p>
    </main>
  )
}

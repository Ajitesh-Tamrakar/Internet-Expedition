/**
 * The signup page (planning section 3): one page, two steps.
 *
 *  Step 1 — First name, Last name, Email, Password + "Send OTP" + a
 *           link to the login page.
 *  Step 2 — "Verify Email": the 6-digit code, "Sign up", "Resend OTP".
 *
 * The backend contract (docs/authentication.md): a successful signup
 * does NOT authenticate — the account is created unverified, a code is
 * emailed, and the response carries the pending flow. The page branches
 * on the auth service's result `status` values (src/auth/authService.js),
 * never on HTTP codes. A correct code completes the signup and the
 * session becomes authenticated, which leads the user to Search.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth'

// Client-side mirror of the backend's cheap rules (required fields, the
// 8-character minimum of MinimumLengthValidator, an @ in the email).
// The backend re-validates everything and its messages win — this only
// catches the obvious before a round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

function validateDetails({ firstName, lastName, email, password }) {
  const errors = {}
  if (!firstName.trim()) errors.firstName = 'First name is required.'
  if (!lastName.trim()) errors.lastName = 'Last name is required.'
  if (!email.trim()) errors.email = 'Email is required.'
  else if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address.'
  if (!password) errors.password = 'Password is required.'
  else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
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

export default function SignupPage() {
  const { actions } = useAuth()
  const navigate = useNavigate()

  const [step, setStep] = useState('details') // 'details' | 'verify'
  const [details, setDetails] = useState({ firstName: '', lastName: '', email: '', password: '' })
  const [code, setCode] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [note, setNote] = useState(null)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)

  const setDetail = (name) => (event) =>
    setDetails((current) => ({ ...current, [name]: event.target.value }))

  // ------------------------------------------------------------------ step 1

  async function sendOtp(event) {
    event.preventDefault()
    if (sending) return

    const errors = validateDetails(details)
    setFieldErrors(errors)
    setFormError(null)
    if (Object.keys(errors).length > 0) return

    setSending(true)
    try {
      const result = await actions.signup({
        email: details.email.trim(),
        password: details.password,
        firstName: details.firstName.trim(),
        lastName: details.lastName.trim(),
      })

      if (result.ok && result.status === 'verification_pending') {
        // A code is in the user's inbox — the pending flow is resumable.
        setStep('verify')
        setCode('')
        setFieldErrors({})
        setFormError(null)
        setNote(null)
        return
      }

      // account_exists / validation / rate_limited / already_authenticated /
      // error: the backend's message (or a fallback) tells the user what
      // happened; they stay on step 1 and can fix the inputs.
      setFormError(result.error?.message ?? null)
    } finally {
      setSending(false)
    }
  }

  // ------------------------------------------------------------------ step 2

  async function completeSignup(event) {
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
        // Signup complete; the session is live. The auth guard would
        // bounce this page to Search anyway — go there deliberately.
        navigate('/search', { replace: true })
        return
      }
      // invalid_code (retryable), flow_expired / session_gone (the flow is
      // dead — "start over" below is the way back), no_pending_flow, error.
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

  /** Back to step 1 — the recovery path for a dead/expired verification. */
  function startOver() {
    setStep('details')
    setCode('')
    setFieldErrors({})
    setFormError(null)
    setNote(null)
  }

  const switchToLogin = (
    <p className="auth-switch">
      Already have an account? <Link to="/login">Log in</Link>
    </p>
  )

  if (step === 'verify') {
    return (
      <main className="auth-page">
        <h1>Verify Email</h1>
        <p className="auth-intro">
          We sent a 6-digit code to <strong>{details.email}</strong>. Enter it below to
          finish creating your account.
        </p>
        <form onSubmit={completeSignup} noValidate>
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
            {verifying ? 'Signing up…' : 'Sign up'}
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
        {switchToLogin}
      </main>
    )
  }

  return (
    <main className="auth-page">
      <h1>Create your account</h1>
      <p className="auth-intro">
        We will email you a one-time code to confirm your address.
      </p>
      <form onSubmit={sendOtp} noValidate>
        <div className="field-row">
          <Field id="firstName" label="First name" error={fieldErrors.firstName}>
            <TextInput
              id="firstName"
              type="text"
              autoComplete="given-name"
              value={details.firstName}
              onChange={setDetail('firstName')}
              error={fieldErrors.firstName}
            />
          </Field>
          <Field id="lastName" label="Last name" error={fieldErrors.lastName}>
            <TextInput
              id="lastName"
              type="text"
              autoComplete="family-name"
              value={details.lastName}
              onChange={setDetail('lastName')}
              error={fieldErrors.lastName}
            />
          </Field>
        </div>
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
            autoComplete="new-password"
            value={details.password}
            onChange={setDetail('password')}
            error={fieldErrors.password}
          />
        </Field>
        <FormMessage tone="error" message={formError} />
        <button type="submit" className="btn" disabled={sending}>
          {sending ? 'Sending…' : 'Send OTP'}
        </button>
      </form>
      {switchToLogin}
    </main>
  )
}

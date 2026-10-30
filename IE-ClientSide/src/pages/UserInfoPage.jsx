/**
 * The user information page (planning section 5).
 *
 *  - Shows the current user's name and email, taken straight from the
 *    session data the auth layer keeps (the backend's `data.user`
 *    payload in src/auth/authStore.js — nothing on this page is a
 *    hardcoded identity).
 *  - **Sign out** ends the session through the backend (DELETE
 *    auth/session — docs/authentication.md: the server kills the session
 *    and clears both token cookies; the client's own state is cleared
 *    whatever the server answers) and returns the user to Login.
 *  - **Change password** — included because the backend supports the
 *    operation: allauth's stock headless ChangePasswordView, mounted by
 *    the project at POST account/password/change (bookmark/urls.py
 *    includes the whole allauth headless tree). Current + new password
 *    are submitted, and the auth service then auto-logs-in with the new
 *    password to restore the session (the backend mints no replacement
 *    tokens for an already-authenticated user, so the browser's token
 *    pair dies on a successful change — see changePassword in
 *    src/auth/authService.js). The user therefore *stays* on this page
 *    after a success; if the auto-login fails, the session is gone and
 *    the user is handed to the login page, which works with the new
 *    password.
 *
 * The page branches on the auth service's result `status` values (plus
 * the `passwordChanged` flag), never on HTTP codes.
 *
 * Routing: protected by RequireAuth (src/auth/guards.jsx). After sign-out
 * — or a failed change auto-login — the store flips to unauthenticated,
 * which the guard turns into a redirect to Login; the page also
 * navigates explicitly so the user isn't left watching the guard work.
 * (The top-level navigation that links here is section 7's job; the
 * back link below keeps the page reachable in the meantime.)
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth'

// Client-side mirror of the backend's MinimumLengthValidator (8
// characters, all four of Django's validators are on in
// bookmark/settings.py) — the backend re-validates and its messages win;
// this only catches the obvious before a round-trip (same convention as
// the signup and reset pages). The other validators (common/numeric/
// similar) are the backend's to enforce; its messages surface as-is.
const MIN_PASSWORD_LENGTH = 8

/**
 * The name to show, from the session's user payload (empty values are
 * omitted by allauth — fall back down the list rather than printing
 * "undefined" or blank names): first + last, else the username, else the
 * allauth display name.
 */
function displayName(user) {
  if (!user) return null
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return full || user.username || user.display || null
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

function validateChange({ currentPassword, newPassword }) {
  const errors = {}
  if (!currentPassword) errors.currentPassword = 'Enter your current password.'
  if (!newPassword) errors.newPassword = 'Choose a new password.'
  else if (newPassword.length < MIN_PASSWORD_LENGTH) {
    errors.newPassword = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return errors
}

export default function UserInfoPage() {
  const { user, actions } = useAuth()
  const navigate = useNavigate()

  const [showChange, setShowChange] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [note, setNote] = useState(null)
  const [changing, setChanging] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [loadingUser, setLoadingUser] = useState(false)

  // ------------------------------------------------------------------ sign out

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      await actions.logout()
      // logout() resolves ok in every case (it clears the client state
      // even when the backend is unreachable), so the store is
      // unauthenticated now and the /account guard would redirect on its
      // own; go deliberately so the page doesn't hang on the user.
    } finally {
      setSigningOut(false)
      navigate('/login', { replace: true })
    }
  }

  // ------------------------------------------------------------------ change

  /** Re-open the change form (clears any stale messages/fields first). */
  function openChange() {
    setCurrentPassword('')
    setNewPassword('')
    setFieldErrors({})
    setFormError(null)
    setNote(null)
    setShowChange(true)
  }

  function closeChange() {
    setShowChange(false)
    setFieldErrors({})
    setFormError(null)
    setNote(null)
  }

  async function submitChange(event) {
    event.preventDefault()
    if (changing) return

    const errors = validateChange({ currentPassword, newPassword })
    setFieldErrors(errors)
    setFormError(null)
    setNote(null)
    if (Object.keys(errors).length > 0) return

    setChanging(true)
    try {
      const result = await actions.changePassword({ currentPassword, newPassword })

      if (result.passwordChanged) {
        // The password WAS changed.
        if (result.ok && result.status === 'authenticated') {
          // The auto-login restored the session — the user stays signed
          // in and right here.
          setNote('Your password has been changed.')
          setCurrentPassword('')
          setNewPassword('')
          setFieldErrors({})
          setFormError(null)
          return
        }
        // Changed, but the follow-up auto-login did not complete (the
        // store is unauthenticated, so the route guard will take the
        // user to Login — say where to go first).
        setFormError(
          result.status === 'verification_pending'
            ? 'Your password has been changed. This account still needs to verify its email — enter the code we just emailed when you sign in.'
            : 'Your password has been changed, but we could not sign you in automatically. Sign in with your new password.'
        )
        setCurrentPassword('')
        setNewPassword('')
        navigate('/login', { replace: true })
        return
      }

      // The change itself failed; the session is whatever it was before.
      if (result.status === 'validation') {
        // Wrong current password / rejected new password: allauth's
        // errors[] carry `param` — map what it can to the fields, show
        // the rest form-level.
        const errors = {}
        for (const entry of result.error?.errors ?? []) {
          if (entry?.param === 'current_password') errors.currentPassword = entry.message
          else if (entry?.param === 'new_password') errors.newPassword = entry.message
        }
        setFieldErrors(errors)
        setFormError(
          Object.keys(errors).length > 0 ? null : result.error?.message ?? null
        )
        return
      }
      if (result.status === 'unauthenticated') {
        // The session died (the refresh recovery failed): the store is
        // unauthenticated and the guard redirects to Login; surface the
        // message for the moment the page is still up.
        setFormError(result.error?.message ?? null)
        return
      }
      // rate_limited / error / anything else.
      setFormError(result.error?.message ?? null)
    } finally {
      setChanging(false)
    }
  }

  // ------------------------------------------------------------------ render

  const name = displayName(user)

  return (
    <main className="account-page">
      <h1>Account</h1>

      {/* Who the user is — straight from the session's user payload. */}
      <section className="account-section" aria-label="Your details">
        {user ? (
          <>
            {name ? <p className="account-name">{name}</p> : null}
            {user.email ? <p className="account-email">{user.email}</p> : null}
          </>
        ) : (
          // Authenticated, but the session carried no usable user payload
          // (an edge of the session endpoint): degrade gracefully — offer
          // to re-fetch the session rather than rendering blanks.
          <>
            <p className="account-name">Your account</p>
            <FormMessage
              tone="note"
              message="We couldn’t load your account details."
            />
            <button
              type="button"
              className="btn btn-quiet"
              onClick={async () => {
                if (loadingUser) return
                setLoadingUser(true)
                // getSession() resolves to a result object in every case
                // (it never throws) — the store either re-authenticates
                // (and this section re-renders with the user) or flips
                // to unauthenticated (and the guard redirects to Login).
                await actions.getSession()
                setLoadingUser(false)
              }}
              disabled={loadingUser}
            >
              {loadingUser ? 'Loading…' : 'Try again'}
            </button>
          </>
        )}
      </section>

      {/* Change password — the backend supports it (see file header). */}
      <section className="account-section" aria-label="Password">
        {showChange ? (
          <form onSubmit={submitChange} noValidate>
            <h2>Change password</h2>
            <Field id="current-password" label="Current password" error={fieldErrors.currentPassword}>
              <TextInput
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                error={fieldErrors.currentPassword}
              />
            </Field>
            <Field id="new-password" label="New password" error={fieldErrors.newPassword}>
              <TextInput
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                error={fieldErrors.newPassword}
              />
            </Field>
            <FormMessage tone="error" message={formError} />
            <FormMessage tone="note" message={note} />
            <button type="submit" className="btn" disabled={changing}>
              {changing ? 'Changing…' : 'Change password'}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={closeChange}
              disabled={changing}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <h2>Password</h2>
            <button type="button" className="btn" onClick={openChange}>
              Change password
            </button>
          </>
        )}
      </section>

      <section className="account-section" aria-label="Session">
        <button type="button" className="btn" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </section>

      <p className="auth-switch">
        <Link to="/search">Back to Search</Link>
      </p>
    </main>
  )
}

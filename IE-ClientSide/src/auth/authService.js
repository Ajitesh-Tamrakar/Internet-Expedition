/**
 * The client's authentication API, on top of the low-level client
 * (src/api/client.js), following docs/authentication.md.
 *
 * Every operation resolves to one *result object* (it never throws for an
 * expected outcome):
 *
 *   { ok: true,  status, ...payload }
 *   { ok: false, status, error: ApiError }
 *
 * `status` is a stable string pages branch on (`ok` tells whether the
 * requested *action* completed):
 *
 *   'authenticated' (ok)         — session established (login, verify,
 *                                  or a restored session)
 *   'verification_pending'       — a code is waiting in the user's inbox;
 *                                  ok:true from signup (account created,
 *                                  verification is the expected next step),
 *                                  ok:false from login (login blocked
 *                                  until the code is entered)
 *   'resent' (ok)                — a fresh code was emailed
 *   'logged_out' (ok) | 'ok' (ok)
 *   'account_exists'             — signup for an already-registered email
 *   'already_authenticated'      — 409; a live session exists
 *   'credentials_invalid'        — 400 email_password_mismatch
 *   'invalid_code'               — 400 incorrect_code (an attempt used)
 *   'flow_expired'               — 409; the pending flow can't advance
 *                                  (see each operation for what survives)
 *   'session_gone'               — 410; the resumed session no longer
 *                                  exists (the stored token was dropped)
 *   'no_pending_flow'            — client-side guard: nothing to resume
 *   'requested' (ok)             — a password-reset email was requested
 *                                  (enumeration-safe 200)
 *   'link_valid' (ok)            — a reset link's token verified (the
 *                                  account it belongs to is in `user`)
 *   'link_invalid'               — a reset link is missing/invalid/expired
 *   'validation' | 'forbidden'   — request rejected before the flow
 *   'rate_limited' | 'unauthenticated' | 'error'
 *
 * Pages branch on `status` (plus `error.message` for display), not on
 * `ok` alone.
 *
 * The operations also maintain the session store (src/auth/authStore.js):
 * becoming authenticated / losing the session / starting and ending
 * pending email-verification flows.
 */

import { ApiError, AUTH_URL, request, toApiError } from '../api/client'
import { authStore } from './authStore'

const VERIFY_FLOW_ID = 'verify_email'

/** The `verify_email` flow from a 401 response's `data.flows`, if pending. */
function pendingVerifyFlow(body) {
  const flows = Array.isArray(body?.data?.flows) ? body.data.flows : []
  return flows.some((flow) => flow?.id === VERIFY_FLOW_ID && flow.is_pending)
}

/**
 * Run a request through the auth surface and map its failure into a
 * result object. `kind` selects the ok:false status for unexpected
 * HTTP-level failures; the caller handles the happy path first.
 */
async function perform(path, options) {
  return request(path, options)
}

function unexpected(result, kind, fallbackMessage = null) {
  const status =
    result.status === 429
      ? 'rate_limited'
      : kind === 'validation' && result.status === 400
        ? 'validation'
        : result.status === 403
          ? 'forbidden'
          : 'error'
  return {
    ok: false,
    status,
    error: toApiError(result, fallbackMessage),
  }
}

// ---------------------------------------------------------------------------
// Session initialization
// ---------------------------------------------------------------------------

let initInFlight = null

/**
 * Establish (or restore) the session on app start / page reload.
 *
 * Probes `GET auth/session`: the access cookie rides along, an expired
 * access token is refreshed (and the probe retried) by the client layer,
 * and a dead/absent session fails closed to unauthenticated — including
 * when the backend is unreachable (a user whose state is unknown is
 * treated as signed out, never as signed in).
 *
 * Idempotent while in flight; safe under React 19 StrictMode's
 * double-invoked effect.
 */
export function initSession() {
  if (initInFlight) return initInFlight
  initInFlight = (async () => {
    authStore.setLoading()
    // A reload mid-verification keeps its resumption handle: an
    // unverified user holds no cookies, so a failed probe must not wipe
    // the token — a 409/410 from verify/resend drops it when it's dead.
    const keepPendingFlowToken = Boolean(authStore.getSnapshot().sessionToken)
    try {
      const result = await request(AUTH_URL.session, { method: 'GET' })
      if (result.status === 200 && result.body?.data?.user) {
        const user = result.body.data.user
        const sessionToken = result.body?.meta?.session_token ?? null
        authStore.setAuthenticated(user, sessionToken)
        return { ok: true, status: 'authenticated', user }
      }
      // A 401 here means the refresh inside request() already failed:
      // the 7-day refresh cookie is gone or dead, so the session is over.
      authStore.setUnauthenticated({ keepSessionToken: keepPendingFlowToken })
      return {
        ok: false,
        status: 'unauthenticated',
        error: toApiError(result, 'Your session is no longer active. Please sign in again.'),
      }
    } catch (error) {
      // Backend unreachable — fail closed (but keep a pending-flow
      // token: the flow's state is unknown, not proven dead).
      authStore.setUnauthenticated({ keepSessionToken: keepPendingFlowToken })
      return { ok: false, status: 'error', error }
    } finally {
      initInFlight = null
    }
  })()
  return initInFlight
}

// ---------------------------------------------------------------------------
// Authenticated operations
// ---------------------------------------------------------------------------

/**
 * The current session. `GET auth/session` with the client's refresh
 * recovery: returns the user payload, or unauthenticated.
 */
export async function getSession() {
  let result
  try {
    result = await request(AUTH_URL.session, { method: 'GET' })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 200) {
    const user = result.body?.data?.user ?? null
    // A live session ends any pending verification flow: adopt the
    // response's (fresh) token if allauth exposed one, else clear ours.
    const sessionToken = result.body?.meta?.session_token ?? null
    authStore.setAuthenticated(user, sessionToken)
    return { ok: true, status: 'authenticated', user }
  }

  authStore.setUnauthenticated()
  return { ok: false, status: 'unauthenticated', error: toApiError(result) }
}

/**
 * Logout. Kills the server session (every outstanding access token dies
 * immediately — stateful validation) and the backend clears both token
 * cookies. The local state is cleared whatever the server answers: the
 * user asked to sign out, and an unreachable backend should not undo that.
 */
export async function logout() {
  try {
    await request(AUTH_URL.session, { method: 'DELETE', authenticated: false })
  } catch {
    /* unreachable backend — the local sign-out below still stands */
  }
  authStore.setUnauthenticated()
  return { ok: true, status: 'logged_out' }
}

// ---------------------------------------------------------------------------
// Public auth endpoints
// ---------------------------------------------------------------------------

/**
 * Register: `POST auth/signup` with email + password + first/last name.
 *
 * The backend creates the (unverified) user and emails a 6-digit code,
 * but issues no tokens until the email is verified, so a *successful*
 * signup is a 401 carrying the pending `verify_email` flow and the
 * `meta.session_token` resumption handle — the page then shows the
 * verify step.
 *
 * Outcomes:
 *  - 'verification_pending' — new account; enter the code (step 2).
 *  - 'account_exists' — that email is already registered. The upstream
 *    duplicate path (docs/authentication.md) re-issues the pending code
 *    *without emailing it*, invalidating the originally emailed code,
 *    and leaves the pending session unchanged (no token in the
 *    response), so the stored token is kept: a resend can still recover
 *    the flow, or the user signs in instead.
 *  - 'already_authenticated' (409), 'validation' (400), 'rate_limited'
 *    (429), 'error' (network/other).
 */
export async function signup({ email, password, firstName, lastName }) {
  const body = { email, password, first_name: firstName, last_name: lastName }

  let result
  try {
    result = await perform(AUTH_URL.signup, {
      method: 'POST',
      body,
      authenticated: false, // a 401 here is a flow signal, never a refresh trigger
    })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 401) {
    const sessionToken = result.body?.meta?.session_token ?? null
    if (pendingVerifyFlow(result.body) && sessionToken) {
      authStore.setPendingFlow(sessionToken)
      return { ok: true, status: 'verification_pending', email, sessionToken }
    }
    // Duplicate email: same 401 + pending flow, but *no* token in meta —
    // the session is unchanged, so whatever token is already stored stays.
    return {
      ok: false,
      status: 'account_exists',
      error: new ApiError({
        status: 401,
        message:
          'An account with this email already exists. If it still needs a verification code, use Resend, or sign in below.',
      }),
    }
  }

  if (result.status === 200) {
    // Not part of this backend's contract (email verification is
    // mandatory), but if it ever happened, honor it.
    const user = result.body?.data?.user ?? null
    if (result.body?.meta?.is_authenticated && user) {
      authStore.setAuthenticated(
        user,
        result.body?.meta?.session_token ?? null
      )
      return { ok: true, status: 'authenticated', user }
    }
  }

  if (result.status === 409) {
    return {
      ok: false,
      status: 'already_authenticated',
      error: toApiError(result, 'You are already signed in.'),
    }
  }
  if (result.status === 429) {
    return { ok: false, status: 'rate_limited', error: toApiError(result) }
  }
  return unexpected(result, 'validation')
}

/**
 * Login: `POST auth/login` with email + password.
 *
 * Any pending-flow token stored from an earlier flow is sent as
 * `X-Session-Token` so allauth can resume it (the self-healing path for
 * unverified accounts); a token whose session is gone 410s, and the
 * documented client behavior is to drop it and start over — so the login
 * is retried once without it.
 *
 * Outcomes:
 *  - 'authenticated' (200) — verified account; tokens are cookies.
 *  - 'verification_pending' (401) — unverified account; a fresh code was
 *    emailed, resume it to complete the login.
 *  - 'credentials_invalid' (400 email_password_mismatch) — identical for
 *    wrong password and unknown email (enumeration prevention).
 *  - 'already_authenticated' (409), 'rate_limited' (429), 'error'.
 */
export async function login({ email, password }) {
  const body = { email, password }
  const storedToken = authStore.getSnapshot().sessionToken

  let result
  try {
    result = await perform(AUTH_URL.login, {
      method: 'POST',
      body,
      authenticated: false,
      sessionToken: storedToken ?? undefined,
    })
    if (result.status === 410) {
      // The resumed session no longer exists: drop the token and retry
      // the login against a fresh session.
      authStore.clearSessionToken()
      result = await perform(AUTH_URL.login, {
        method: 'POST',
        body,
        authenticated: false,
      })
    }
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 200) {
    const user = result.body?.data?.user ?? null
    const sessionToken = result.body?.meta?.session_token ?? null
    authStore.setAuthenticated(user, sessionToken)
    return { ok: true, status: 'authenticated', user, sessionToken }
  }

  if (result.status === 401) {
    if (pendingVerifyFlow(result.body)) {
      // Unverified account: allauth re-issued a code email. Adopt the
      // response's token (the login transition cycles the session key);
      // fall back to whatever the store holds *now* — the 410 path above
      // may have cleared the earlier token, so re-read rather than
      // assuming `storedToken` is still live.
      const sessionToken =
        result.body?.meta?.session_token ??
        authStore.getSnapshot().sessionToken ??
        null
      authStore.setPendingFlow(sessionToken)
      return {
        ok: false,
        status: 'verification_pending',
        email,
        sessionToken,
        error: new ApiError({
          status: 401,
          message: 'This account still needs to verify its email address. Enter the code we just emailed you.',
        }),
      }
    }
    return { ok: false, status: 'unauthenticated', error: toApiError(result) }
  }

  if (result.status === 400) {
    return { ok: false, status: 'credentials_invalid', error: toApiError(result) }
  }
  if (result.status === 409) {
    return {
      ok: false,
      status: 'already_authenticated',
      error: toApiError(result, 'You are already signed in.'),
    }
  }
  if (result.status === 429) {
    return { ok: false, status: 'rate_limited', error: toApiError(result) }
  }
  return unexpected(result, 'validation')
}

/**
 * Confirm the emailed 6-digit code: `POST auth/email/verify`
 * `{"key": "<code>"}`, resumed with the stored `X-Session-Token`.
 *
 * On success the login completes: the user is fully authenticated, and
 * the session key cycled — the response's *new* token replaces the stored
 * one (the resumed token is now a 410).
 *
 * Outcomes:
 *  - 'authenticated' (200).
 *  - 'invalid_code' (400 incorrect_code) — each wrong code consumes one
 *    of the 3 allowed attempts.
 *  - 'flow_expired' (409) — attempts exhausted or the 15-minute window
 *    closed; the flow is dead and the stored token is cleared.
 *  - 'session_gone' (410) — the pending session vanished; token cleared.
 *  - 'no_pending_flow' — no token stored locally (client-side guard).
 */
export async function verifyEmail(code) {
  const storedToken = authStore.getSnapshot().sessionToken
  if (!storedToken) {
    return {
      ok: false,
      status: 'no_pending_flow',
      error: new ApiError({
        status: null,
        message: 'No email verification is in progress. Please start again.',
      }),
    }
  }

  let result
  try {
    result = await perform(AUTH_URL.verifyEmail, {
      method: 'POST',
      body: { key: code },
      authenticated: false,
      sessionToken: storedToken,
    })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 200) {
    const user = result.body?.data?.user ?? null
    const sessionToken = result.body?.meta?.session_token ?? null
    authStore.setAuthenticated(user, sessionToken)
    return { ok: true, status: 'authenticated', user, sessionToken }
  }

  if (result.status === 400) {
    const error = toApiError(result)
    return {
      ok: false,
      status: error.code === 'incorrect_code' ? 'invalid_code' : 'validation',
      error,
    }
  }

  if (result.status === 409) {
    // The pending flow is dead (aborted or expired) — the stored token
    // can no longer resume anything.
    authStore.clearSessionToken()
    return {
      ok: false,
      status: 'flow_expired',
      error: new ApiError({
        status: 409,
        message: 'This verification has expired or ran out of attempts. Please request a new code or sign in again.',
      }),
    }
  }

  if (result.status === 410) {
    authStore.clearSessionToken()
    return { ok: false, status: 'session_gone', error: toApiError(result) }
  }

  return unexpected(result, 'validation')
}

/**
 * Re-issue the verification code: `POST auth/email/verify/resend`
 * (no body), resumed with the stored `X-Session-Token`. A fresh code is
 * emailed and the previous one dies.
 *
 * Outcomes:
 *  - 'resent' (200).
 *  - 'flow_expired' (409) — the flow is over (aborted/expired) *or* the
 *    3-resend quota is reached. The stored token is deliberately *kept*
 *    in the quota case: the last emailed code may still verify, so the
 *    page should keep the code field usable and only note that no
 *    further resends are possible.
 */
export async function resendVerification() {
  const storedToken = authStore.getSnapshot().sessionToken
  if (!storedToken) {
    return {
      ok: false,
      status: 'no_pending_flow',
      error: new ApiError({
        status: null,
        message: 'No email verification is in progress. Please start again.',
      }),
    }
  }

  let result
  try {
    result = await perform(AUTH_URL.resendVerification, {
      method: 'POST',
      authenticated: false,
      sessionToken: storedToken,
    })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 200) {
    return { ok: true, status: 'resent' }
  }

  if (result.status === 409) {
    return {
      ok: false,
      status: 'flow_expired',
      error: new ApiError({
        status: 409,
        message:
          'You can’t request another code right now. If you have a recent code, you can still try it.',
      }),
    }
  }

  if (result.status === 410) {
    authStore.clearSessionToken()
    return { ok: false, status: 'session_gone', error: toApiError(result) }
  }

  return unexpected(result, 'validation')
}

// ---------------------------------------------------------------------------
// Password recovery (link-based)
//
// The backend's recovery flow (allauth, mounted at the same headless
// paths; settings.HEADLESS_FRONTEND_URLS points its mail link at the
// frontend):
//
//   1. POST auth/password/request  {"email"}        → 200, mails a link
//   2. the link opens /account/password/reset?token=… in the SPA
//   3. GET  auth/password/reset (X-Password-Reset-Key: token) → link check
//   4. POST auth/password/reset    {"key", "password"}        → done
//
// Step 4 is the one with teeth: the backend sets the password but does
// NOT sign the user in (LOGIN_ON_PASSWORD_RESET is off —
// docs/authentication.md), so a *successful* reset answers 401 with the
// login flow and no tokens. resetPassword() then calls login() with the
// new credentials itself (auto-login); the page only ever sees the
// settled outcome.
// ---------------------------------------------------------------------------

/**
 * Request a password-reset email: `POST auth/password/request`
 * `{"email"}`.
 *
 * Enumeration-safe on the backend: the 200 is the same answer for a
 * registered and an unregistered address, so callers must phrase the
 * confirmation as "if an account exists, …". The mail carries a link to
 * the frontend's `/account/password/reset?token=…` route (ResetPasswordPage).
 *
 * Outcomes:
 *  - 'requested' (200) — the mail went out (or the "no such account"
 *    mail did); the page shows the enumeration-safe confirmation.
 *  - 'validation' (400) — e.g. a malformed email address.
 *  - 'rate_limited' (429), 'error' (network/other).
 */
export async function requestPasswordReset({ email }) {
  let result
  try {
    result = await request(AUTH_URL.requestPasswordReset, {
      method: 'POST',
      body: { email },
      authenticated: false, // public endpoint; a 401 is not a refresh trigger
    })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 200) {
    return { ok: true, status: 'requested', email }
  }
  if (result.status === 400) {
    return { ok: false, status: 'validation', error: toApiError(result) }
  }
  if (result.status === 429) {
    return { ok: false, status: 'rate_limited', error: toApiError(result) }
  }
  return unexpected(result, 'validation')
}

/**
 * Check a reset link: `GET auth/password/reset` with the token as the
 * `X-Password-Reset-Key` header.
 *
 * The emailed link lands on `/account/password/reset?token=…`; that page
 * calls this on mount so the user is told immediately whether the link
 * is still good (and which account it is for) instead of finding out
 * only after typing a new password.
 *
 * Outcomes:
 *  - 'link_valid' (200) — the token is live; `user` is the account it
 *    belongs to.
 *  - 'link_invalid' (400) — the token is missing, malformed, or expired.
 *  - 'error' (network/other).
 */
export async function verifyResetLink(token) {
  let result
  try {
    result = await request(AUTH_URL.resetPassword, {
      method: 'GET',
      authenticated: false, // public endpoint (see the section note)
      headers: { 'X-Password-Reset-Key': token },
    })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  if (result.status === 200) {
    return { ok: true, status: 'link_valid', user: result.body?.data?.user ?? null }
  }
  if (result.status === 400) {
    return { ok: false, status: 'link_invalid', error: toApiError(result) }
  }
  return unexpected(result, 'validation')
}

/**
 * Complete a password reset: `POST auth/password/reset`
 * `{"key": <token>, "password"}`.
 *
 * `email` is the address the user signed up with (from the link check);
 * it is what the follow-up auto-login needs — see the section note for
 * why the reset itself does not produce a session.
 *
 * Outcomes:
 *  - 'authenticated' (ok) — the password was set AND the follow-up login
 *    signed the user in (either the backend did it itself, or the
 *    auto-login did).
 *  - `resetCompleted: true` on every result in which the password was
 *    actually set, so a page can say "your password has been changed"
 *    even when the follow-up login then failed:
 *    - 'verification_pending' — the account must verify its email first
 *      (a fresh code was emailed; resume it from the login page);
 *    - 'credentials_invalid' / 'rate_limited' / 'error' — the auto-login
 *      hit a wall; the user logs in manually with the new password.
 *  - without `resetCompleted` the reset itself failed and no login was
 *    attempted: 'link_invalid' (400 invalid token), 'validation' (400
 *    rejected password), 'flow_expired' (409), 'rate_limited' (429),
 *    'error' (network/other).
 */
export async function resetPassword({ key, email, password }) {
  let result
  try {
    result = await request(AUTH_URL.resetPassword, {
      method: 'POST',
      body: { key, password },
      authenticated: false, // public endpoint (see the section note)
    })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }

  // A 200 with a live session is what LOGIN_ON_PASSWORD_RESET=True would
  // produce; honor it if it ever happens.
  if (result.status === 200 && result.body?.meta?.is_authenticated) {
    const user = result.body?.data?.user ?? null
    authStore.setAuthenticated(user, result.body?.meta?.session_token ?? null)
    return { ok: true, status: 'authenticated', user, resetCompleted: true }
  }

  // The usual case: the password is set, the answer is a 401 (login
  // available, no session) — or, defensively, a 200 without one.
  const completed = result.status === 401 || result.status === 200
  if (completed) {
    // Auto-login with the new credentials. login() itself resumes any
    // stored pending-flow token (self-healing for a never-verified
    // account) and maps every outcome.
    const loginResult = await login({ email, password })
    return { ...loginResult, resetCompleted: true }
  }

  if (result.status === 400) {
    const error = toApiError(result)
    return {
      ok: false,
      status: error.code === 'invalid_password_reset' ? 'link_invalid' : 'validation',
      error,
    }
  }
  if (result.status === 409) {
    return {
      ok: false,
      status: 'flow_expired',
      error: toApiError(result, 'This password reset has already been used or expired.'),
    }
  }
  if (result.status === 429) {
    return { ok: false, status: 'rate_limited', error: toApiError(result) }
  }
  return unexpected(result, 'validation')
}

/**
 * Frontend configuration: `GET config` — login methods, whether signup
 * is open, etc. Public, no session required.
 */
export async function getAuthConfig() {
  let result
  try {
    result = await request(AUTH_URL.config, { method: 'GET', authenticated: false })
  } catch (error) {
    return { ok: false, status: 'error', error }
  }
  if (result.status === 200) {
    return { ok: true, status: 'ok', config: result.body?.data ?? {} }
  }
  return { ok: false, status: 'error', error: toApiError(result) }
}

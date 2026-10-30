/**
 * Low-level API client for the Internet Expedition backend.
 *
 * Implements the SPA side of the token contract in docs/authentication.md:
 *
 *  - The SPA never holds a token in JavaScript. The access token rides
 *    an HttpOnly `access_token` cookie (path `/api/`) that the backend's
 *    bridge middleware turns into the Authorization header, so every
 *    request is a plain fetch with `credentials: 'include'`.
 *  - On a 401 from a request that *expects* an authenticated session, the
 *    client refreshes once (the refresh cookie does the work — the
 *    browser cannot read it, so the refresh request has an empty body)
 *    and retries the original request exactly once.
 *  - A failed refresh means the session is gone: the client flips to
 *    unauthenticated and the 401 is returned to the caller. The original
 *    request is retried at most once and the refresh never re-enters this
 *    wrapper, so there is no retry loop.
 *
 * `credentials: 'include'` note: in production the SPA is served
 * same-origin by the backend (WhiteNoise), where it is a no-op. In
 * development the Vite dev server (localhost:5173) is a *different
 * origin* than the backend (localhost:8080) but the same *site*, so the
 * cookies cross the hop — and the backend's CORS allowlist
 * (bookmark/settings.py) already lists the Vite origins with credentials.
 */

import { authStore } from '../auth/authStore'

// The backend's headless allauth app-client API (docs/authentication.md,
// "Base URL"). The two core-variant endpoints (signup with first/last
// name, refresh with cookie fallback) are mounted at the same paths.
export const AUTH_URL = {
  signup: '/api/auth/app/v1/auth/signup',
  login: '/api/auth/app/v1/auth/login',
  verifyEmail: '/api/auth/app/v1/auth/email/verify',
  resendVerification: '/api/auth/app/v1/auth/email/verify/resend',
  session: '/api/auth/app/v1/auth/session',
  refresh: '/api/auth/app/v1/tokens/refresh',
  config: '/api/auth/app/v1/config',
  requestPasswordReset: '/api/auth/app/v1/auth/password/request',
  resetPassword: '/api/auth/app/v1/auth/password/reset',
  // Allauth's stock headless ChangePasswordView — the project mounts the
  // whole allauth headless URL tree (bookmark/urls.py, "password
  // reset/change"), which puts this under the `account/` prefix, not
  // `auth/` (that prefix is where reset lives). Authenticated; body is
  // {current_password, new_password}.
  changePassword: '/api/auth/app/v1/account/password/change',
}

// Same-origin in production; the backend's default dev port otherwise.
// Override either with VITE_API_BASE_URL (an empty string = same-origin).
const DEFAULT_DEV_BACKEND = 'http://localhost:8080'

export const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.DEV ? DEFAULT_DEV_BACKEND : '')
).replace(/\/+$/, '')

/**
 * A failed API call, in the one shape pages present to users.
 *
 * `message` is always safe to display; `code`/`param`/`errors` carry the
 * backend's detail (allauth's `errors[]` entries) for field-level display;
 * `network` marks a request that never reached the backend.
 */
export class ApiError extends Error {
  constructor({ status = null, message, code = null, param = null, errors = [], network = false }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.param = param
    this.errors = errors
    this.network = network
  }
}

const FALLBACK_MESSAGES = {
  400: 'Something went wrong. Please check your details and try again.',
  401: 'Your session is no longer active. Please sign in again.',
  403: 'This action is not allowed.',
  404: 'That page could not be found.',
  409: 'That is not possible right now. Please try again.',
  410: 'That session is no longer valid. Please start again.',
  429: 'Too many attempts. Please wait a moment and try again.',
}

const NETWORK_MESSAGE =
  "Can't reach the server. Check your connection and try again."

function fallbackMessage(status) {
  if (status == null) return NETWORK_MESSAGE
  if (status >= 500) return 'The server hit a problem. Please try again shortly.'
  return FALLBACK_MESSAGES[status] ?? 'Something went wrong. Please try again.'
}

/**
 * Normalize a transport result into an ApiError. Prefers the first of
 * allauth's human-readable `errors[].message` entries; falls back to a
 * status-based (or the given) message.
 */
export function toApiError(result, fallback = null) {
  const errors = Array.isArray(result.body?.errors) ? result.body.errors : []
  const first = errors.find((entry) => typeof entry?.message === 'string')
  return new ApiError({
    status: result.status,
    message: first?.message ?? fallback ?? fallbackMessage(result.status),
    code: first?.code ?? null,
    param: first?.param ?? null,
    errors,
  })
}

/**
 * One HTTP request. Returns `{ status, body }` — `body` is the parsed
 * JSON object, or `null` when the response was not parseable JSON.
 * Throws ApiError (network) only when the request never completed.
 */
async function transport(path, { method = 'GET', body, sessionToken, headers: extraHeaders } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (sessionToken) headers['X-Session-Token'] = sessionToken

  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      // Cookies (HttpOnly access/refresh tokens) must ride along. Same-site
      // in dev (localhost:5173 -> :8080), same-origin in production.
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError({ status: null, message: NETWORK_MESSAGE, network: true })
  }

  const type = response.headers.get('Content-Type') ?? ''
  let parsed = null
  if (type.includes('application/json')) {
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
  }
  return { status: response.status, body: parsed }
}

let refreshInFlight = null

/**
 * Exchange the (rotating) refresh cookie for a fresh access token.
 *
 * Empty body on purpose: a browser cannot read its own HttpOnly cookie,
 * and the backend's RefreshTokenView falls back to the cookie when the
 * body has no `refresh_token` (docs/authentication.md, "Tokens"). On
 * success the browser's cookie jar updates in place — the rotated refresh
 * cookie and the mirrored access cookie — so no token ever reaches
 * JavaScript.
 *
 * Single-flight: concurrent 401s share one in-flight refresh, so ten
 * racing requests trigger exactly one rotation; the *next* expiry (15
 * minutes later) starts a fresh one. Resolves `true`/`false`, never throws.
 */
export function refreshTokens() {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const result = await transport(AUTH_URL.refresh, { method: 'POST' })
      return result.status === 200
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * Perform an API request with the SPA's session behavior.
 *
 * `authenticated: true` (the default) opts into the 401 -> refresh ->
 * retry-once recovery for requests that require a session (the session
 * probe, and every future protected endpoint such as captures/search).
 * The public auth endpoints (signup/login/verify/...) pass
 * `authenticated: false`: their 401s are *flow signals* (pending email
 * verification), not expired sessions, and must never trigger a refresh.
 *
 * `sessionToken` (optional) is sent as the `X-Session-Token` header to
 * resume a pending multi-stage flow — see the auth service.
 *
 * Returns `{ status, body }`. Throws ApiError when the request never
 * completed (network failure, or the retry after a successful refresh
 * fails to reach the backend).
 */
export async function request(path, options = {}) {
  const { authenticated = true, ...transportOptions } = options

  let result = await transport(path, transportOptions)

  if (authenticated && result.status === 401) {
    const refreshed = await refreshTokens()
    if (!refreshed) {
      // The refresh said no: the session is gone server-side. Flip the
      // client state and hand the 401 back — the caller presents it.
      //
      // Token lifecycle: a token held while *authenticated* belongs to
      // the session that just died — wipe it. A token held while
      // unauthenticated is a *pending-flow* handle (a separate
      // lifecycle): it dies with the flow, and the flow handlers
      // (verify 409/410, resend 409, login 410) clear it. A dead
      // session must not wipe a still-resumable flow — a reload
      // mid-verification must survive its own failed probe.
      const notYetSignedIn =
        authStore.getSnapshot().status !== authStore.STATUS.AUTHENTICATED
      authStore.setUnauthenticated({ keepSessionToken: notYetSignedIn })
      return result
    }
    // The new access cookie is in the jar; the retry rides it.
    result = await transport(path, transportOptions)
  }

  return result
}

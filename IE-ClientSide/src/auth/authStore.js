/**
 * The SPA's session state.
 *
 * The SPA never holds a token in JavaScript (see docs/authentication.md,
 * "SPA usage"): the access and refresh tokens live in the backend's HttpOnly
 * cookies, and the browser's cookie jar *is* the persistence layer. What the
 * client does keep is:
 *
 *  - the current user payload (from the auth responses / session endpoint),
 *  - the session's status, and
 *  - the pending-flow `session_token` (allauth's resumption handle for
 *    signup -> email-verify and login -> email-verify; the flow is resumed
 *    by sending it back as the `X-Session-Token` header). The backend docs
 *    say the SPA must keep it "exactly as it keeps the access token" — i.e.
 *    as part of the live browser session, never in durable storage.
 *    `sessionStorage` is the faithful analogue of the access cookie: it
 *    survives a page reload, and it dies with the tab, the same way the
 *    server-side session it references expires.
 *
 * The store is a tiny external store (subscribe/getSnapshot) so React
 * components can bind it with `useSyncExternalStore` (see useAuth.js), and
 * plain modules (the API client) can read and write it without React.
 */

export const STATUS = Object.freeze({
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  UNAUTHENTICATED: 'unauthenticated',
})

const SESSION_TOKEN_STORAGE_KEY = 'ie.auth.sessionToken'

function readStoredSessionToken() {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY)
  } catch {
    // No window (unit tests) or storage unavailable — in-memory only.
    return null
  }
}

function writeStoredSessionToken(sessionToken) {
  try {
    if (sessionToken) {
      window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, sessionToken)
    } else {
      window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
    }
  } catch {
    /* storage unavailable — the in-memory copy keeps working */
  }
}

let state = {
  status: STATUS.LOADING,
  user: null,
  sessionToken: readStoredSessionToken(),
}

const listeners = new Set()

function setState(next) {
  const changed =
    next.status !== state.status ||
    next.user !== state.user ||
    next.sessionToken !== state.sessionToken
  state = next
  writeStoredSessionToken(next.sessionToken)
  if (changed) {
    // Copy: a listener may unsubscribe mid-emit.
    for (const listener of [...listeners]) listener()
  }
}

export const authStore = {
  STATUS,

  subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getSnapshot() {
    return state
  },

  /** App start / reload: a session probe is being made. */
  setLoading() {
    setState({
      status: STATUS.LOADING,
      user: null,
      sessionToken: state.sessionToken,
    })
  },

  /**
   * The user became fully authenticated (login / verify success).
   * `sessionToken` is the *new* `meta.session_token` from the response —
   * the login transition cycles the session key, so an earlier token is
   * dead (410) once this has run. Pass `null` to clear.
   */
  setAuthenticated(user, sessionToken) {
    setState({
      status: STATUS.AUTHENTICATED,
      user: user ?? null,
      sessionToken: sessionToken ?? null,
    })
  },

  /**
   * The session is gone (failed refresh, explicit logout, dead probe).
   *
   * `keepSessionToken` retains a stored pending-flow token: used at app
   * start, where a reload mid-verification must not lose the resumption
   * handle (an unverified user holds no cookies, so the probe fails, but
   * the flow may still be alive server-side — a later 409/410 from
   * verify/resend drops the token, as documented there). Logout and the
   * like wipe unconditionally.
   */
  setUnauthenticated({ keepSessionToken = false } = {}) {
    setState({
      status: STATUS.UNAUTHENTICATED,
      user: null,
      sessionToken: keepSessionToken ? state.sessionToken : null,
    })
  },

  /**
   * A pending email-verification flow started (signup, or login of an
   * unverified account). The session status itself is unchanged — the
   * user is not authenticated until the code is verified.
   */
  setPendingFlow(sessionToken) {
    setState({ ...state, sessionToken: sessionToken ?? null })
  },

  /** The pending flow is dead (expired, attempts exhausted, 410). */
  clearSessionToken() {
    setState({ ...state, sessionToken: null })
  },
}

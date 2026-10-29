/**
 * Tests for the authentication service (src/auth/authService.js) against
 * the documented backend contract (docs/authentication.md, and the
 * backend's own test suite in core/tests.py — the shapes below are its
 * exact allauth headless responses).
 *
 * Covers the section-2 acceptance criteria: session initialization and
 * reload recovery, pending signup/verification flows (session token +
 * resend), login outcomes, logout, and predictable failure shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authStore } from './authStore'
import {
  getSession,
  initSession,
  login,
  logout,
  resendVerification,
  signup,
  verifyEmail,
} from './authService'
import { AUTH_URL } from '../api/client'

const USER = {
  id: 1,
  username: 'ada',
  display: 'ada',
  email: 'ada@example.com',
  has_usable_password: true,
  first_name: 'Ada',
  last_name: 'Lovelace',
}

function jsonResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) =>
        String(name).toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
  }
}

/**
 * A scriptable fake backend: pass `routes` as a list of
 * `[urlSuffix, (callNumber, options) => response]` entries.
 */
function mockBackend(routes) {
  const calls = []
  const counts = {}
  const fetchMock = vi.fn((url, options) => {
    const entry = routes.find(([suffix]) => url.endsWith(suffix))
    if (!entry) throw new Error(`unmocked URL: ${url}`)
    const [, handler] = entry
    counts[url] = (counts[url] ?? 0) + 1
    calls.push({ url, options, n: counts[url] })
    return Promise.resolve(handler(counts[url], options))
  })
  return { fetchMock, calls, counts }
}

function callFor(calls, urlSuffix) {
  return calls.filter((call) => call.url.endsWith(urlSuffix))
}

beforeEach(() => {
  authStore.setUnauthenticated()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Session initialization
// ---------------------------------------------------------------------------

describe('initSession()', () => {
  it('restores an active session from the session probe', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.session, () =>
        jsonResponse(200, { status: 200, data: { user: USER, methods: [] }, meta: { is_authenticated: true } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await initSession()

    expect(result.ok).toBe(true)
    expect(result.status).toBe('authenticated')
    expect(authStore.getSnapshot()).toMatchObject({
      status: 'authenticated',
      user: { email: 'ada@example.com' },
    })
  })

  it('recovers an expired access session on reload: refresh, then retry the probe', async () => {
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.refresh, () =>
        jsonResponse(200, { status: 200, data: { access_token: 'at-2' } })],
      [AUTH_URL.session, (n) =>
        jsonResponse(n === 1 ? 401 : 200, n === 1 ? { status: 401 } : { status: 200, data: { user: USER }, meta: { is_authenticated: true } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await initSession()

    expect(result.status).toBe('authenticated')
    // probe -> 401 -> refresh -> probe again
    expect(callFor(calls, '/auth/session')).toHaveLength(2)
    expect(callFor(calls, '/tokens/refresh')).toHaveLength(1)
    expect(authStore.getSnapshot().status).toBe('authenticated')
  })

  it('a dead session (failed refresh) fails closed to unauthenticated', async () => {
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.refresh, () => jsonResponse(400, { status: 400 })],
      [AUTH_URL.session, () => jsonResponse(401, { status: 401 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await initSession()

    expect(result.ok).toBe(false)
    expect(result.status).toBe('unauthenticated')
    // exactly one probe and one failed refresh — no loop
    expect(callFor(calls, '/auth/session')).toHaveLength(1)
    expect(callFor(calls, '/tokens/refresh')).toHaveLength(1)
    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe('unauthenticated')
    expect(snapshot.user).toBeNull()
  })

  it('an unreachable backend fails closed without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('failed to fetch'))))

    const result = await initSession()

    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
    expect(result.error.network).toBe(true)
    expect(authStore.getSnapshot().status).toBe('unauthenticated')
  })

  it('a reload mid-verification keeps the pending-flow token even though the probe fails', async () => {
    // The user signed up, moved to the verify step, and reloaded. They
    // hold no cookies (unverified users get none), so the probe 401s and
    // the refresh 400s — but the stored token must survive so the verify
    // step can resume the flow.
    authStore.setUnauthenticated()
    authStore.setPendingFlow('st-mid-flow')
    const { fetchMock } = mockBackend([
      [AUTH_URL.refresh, () => jsonResponse(400, { status: 400 })],
      [AUTH_URL.session, () => jsonResponse(401, { status: 401 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    await initSession()

    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe('unauthenticated')
    expect(snapshot.sessionToken).toBe('st-mid-flow') // kept, not wiped
  })

  it('is idempotent while in flight (StrictMode double-invoke)', async () => {
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.refresh, () => jsonResponse(200, { status: 200, data: { access_token: 'x' } })],
      [AUTH_URL.session, (n) =>
        jsonResponse(n === 1 ? 401 : 200, n === 1 ? { status: 401 } : { status: 200, data: { user: USER } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const [r1, r2] = await Promise.all([initSession(), initSession()])

    expect(r1).toBe(r2) // same in-flight promise
    expect(callFor(calls, '/auth/session')).toHaveLength(2) // one probe + one retry, not two sequences
    expect(callFor(calls, '/tokens/refresh')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

describe('signup()', () => {
  const pendingBody = {
    status: 401,
    data: {
      flows: [
        { id: 'login' },
        { id: 'signup' },
        { id: 'verify_email', is_pending: true },
      ],
    },
    meta: { is_authenticated: false, session_token: 'st-signup' },
  }

  it('sends email/password/first_name/last_name', async () => {
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.signup, () => jsonResponse(401, pendingBody)],
    ])
    vi.stubGlobal('fetch', fetchMock)

    await signup({ email: 'ada@example.com', password: 'p', firstName: 'Ada', lastName: 'Lovelace' })

    const { url, options } = calls[0]
    expect(url.endsWith('/auth/signup')).toBe(true)
    expect(JSON.parse(options.body)).toEqual({
      email: 'ada@example.com',
      password: 'p',
      first_name: 'Ada',
      last_name: 'Lovelace',
    })
  })

  it('a new account (401 + pending verify_email + token) becomes a pending flow', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.signup, () => jsonResponse(401, pendingBody)],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await signup({ email: 'ada@example.com', password: 'p', firstName: 'A', lastName: 'L' })

    expect(result.ok).toBe(true)
    expect(result.status).toBe('verification_pending')
    expect(result.email).toBe('ada@example.com')
    expect(result.sessionToken).toBe('st-signup')
    // the page is still unauthenticated, but the flow token is resumable
    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe('unauthenticated')
    expect(snapshot.sessionToken).toBe('st-signup')
  })

  it('a duplicate email (401, no session_token in meta) reports account_exists and keeps the stored token', async () => {
    authStore.setPendingFlow('st-earlier')
    const { fetchMock } = mockBackend([
      [AUTH_URL.signup, () => jsonResponse(401, { ...pendingBody, meta: { is_authenticated: false } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await signup({ email: 'ada@example.com', password: 'p', firstName: 'A', lastName: 'L' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('account_exists')
    expect(result.error.message).toMatch(/already exists/i)
    expect(authStore.getSnapshot().sessionToken).toBe('st-earlier') // unchanged
  })

  it('a validation failure (400) surfaces the backend message', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.signup, () =>
        jsonResponse(400, {
          status: 400,
          errors: [{ message: 'Password is too short.', param: 'password', code: 'password_too_short' }],
        })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await signup({ email: 'a@b.c', password: 'x', firstName: 'A', lastName: 'L' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('validation')
    expect(result.error.message).toBe('Password is too short.')
    expect(result.error.param).toBe('password')
  })

  it('a 409 while already signed in reports already_authenticated', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.signup, () => jsonResponse(409, { status: 409 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await signup({ email: 'a@b.c', password: 'x', firstName: 'A', lastName: 'L' })

    expect(result.status).toBe('already_authenticated')
    expect(result.error.message).toBe('You are already signed in.')
  })

  it('a network failure yields a result object, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('failed to fetch'))))

    const result = await signup({ email: 'a@b.c', password: 'x', firstName: 'A', lastName: 'L' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
    expect(result.error.network).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe('login()', () => {
  it('a verified account (200) becomes authenticated, with the new session token', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.login, () =>
        jsonResponse(200, { status: 200, data: { user: USER, methods: [] }, meta: { is_authenticated: true, session_token: 'st-live', access_token: 'at-1' } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await login({ email: 'ada@example.com', password: 'p' })

    expect(result.ok).toBe(true)
    expect(result.status).toBe('authenticated')
    expect(result.user.email).toBe('ada@example.com')
    // the SPA ignores the body token — it is in a cookie — but the flow token is kept
    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe('authenticated')
    expect(snapshot.user).toBe(USER)
    expect(snapshot.sessionToken).toBe('st-live')
  })

  it('wrong password and unknown email both yield credentials_invalid (400 email_password_mismatch)', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.login, () =>
        jsonResponse(400, {
          status: 400,
          errors: [
            {
              message: 'The email address and/or password you specified are not correct.',
              code: 'email_password_mismatch',
              param: 'password',
            },
          ],
        })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await login({ email: 'ada@example.com', password: 'nope' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('credentials_invalid')
    expect(result.error.code).toBe('email_password_mismatch')
    // the session is unchanged by a failed login
    expect(authStore.getSnapshot().status).toBe('unauthenticated')
  })

  it('an unverified account (401 + pending verify_email) starts a recoverable flow', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.login, () =>
        jsonResponse(401, {
          status: 401,
          data: { flows: [{ id: 'login' }, { id: 'verify_email', is_pending: true }] },
          meta: { is_authenticated: false, session_token: 'st-verify' },
        })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await login({ email: 'ada@example.com', password: 'p' })

    expect(result.ok).toBe(false) // login did not complete
    expect(result.status).toBe('verification_pending')
    expect(authStore.getSnapshot().sessionToken).toBe('st-verify')
    // and the pending token is resumed on the follow-up verify
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        expect(url.endsWith('/auth/email/verify')).toBe(true)
        expect(options.headers['X-Session-Token']).toBe('st-verify')
        return jsonResponse(200, {
          status: 200,
          data: { user: USER },
          meta: { is_authenticated: true, session_token: 'st-verified' },
        })
      })
    )
    const verified = await verifyEmail('123456')
    expect(verified.status).toBe('authenticated')
  })

  it('resumes a pending-flow token, and on 410 drops it and retries the login once', async () => {
    authStore.setPendingFlow('st-dead')
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.login, (n) =>
        jsonResponse(
          n === 1 ? 410 : 200,
          n === 1 ? { status: 410 } : { status: 200, data: { user: USER }, meta: { is_authenticated: true, session_token: 'st-fresh' } }
        )],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await login({ email: 'ada@example.com', password: 'p' })

    expect(result.status).toBe('authenticated')
    const loginCalls = callFor(calls, '/auth/login')
    expect(loginCalls).toHaveLength(2)
    expect(loginCalls[0].options.headers['X-Session-Token']).toBe('st-dead')
    expect(loginCalls[1].options.headers['X-Session-Token']).toBeUndefined()
    expect(authStore.getSnapshot().sessionToken).toBe('st-fresh')
  })

  it('a 409 (already signed in) reports already_authenticated', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.login, () => jsonResponse(409, { status: 409 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await login({ email: 'ada@example.com', password: 'p' })
    expect(result.status).toBe('already_authenticated')
  })
})

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

describe('verifyEmail()', () => {
  function pending(code) {
    authStore.setPendingFlow('st-pending')
    return { code }
  }

  it('a correct code completes the flow and swaps in the new session token', async () => {
    pending()
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.verifyEmail, () =>
        jsonResponse(200, {
          status: 200,
          data: { user: USER, methods: [] },
          meta: { is_authenticated: true, session_token: 'st-rotated' },
        })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyEmail('123456')

    expect(result.ok).toBe(true)
    expect(result.status).toBe('authenticated')
    expect(result.user.last_name).toBe('Lovelace')
    // the resumed token is dead after the login transition; the rotated one is kept
    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe('authenticated')
    expect(snapshot.sessionToken).toBe('st-rotated')
    // the old token was the one sent
    expect(calls[0].options.headers['X-Session-Token']).toBe('st-pending')
    expect(JSON.parse(calls[0].options.body)).toEqual({ key: '123456' })
  })

  it('a wrong code (400 incorrect_code) reports invalid_code and keeps the flow alive', async () => {
    pending()
    const { fetchMock } = mockBackend([
      [AUTH_URL.verifyEmail, () =>
        jsonResponse(400, {
          status: 400,
          errors: [{ message: 'Incorrect code.', code: 'incorrect_code', param: 'key' }],
        })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyEmail('999999')

    expect(result.ok).toBe(false)
    expect(result.status).toBe('invalid_code')
    expect(result.error.message).toBe('Incorrect code.')
    // the pending flow (and its token) survives a wrong attempt
    expect(authStore.getSnapshot().sessionToken).toBe('st-pending')
    expect(authStore.getSnapshot().status).toBe('unauthenticated')
  })

  it('an aborted/expired flow (409) reports flow_expired and drops the token', async () => {
    pending()
    const { fetchMock } = mockBackend([
      [AUTH_URL.verifyEmail, () => jsonResponse(409, { status: 409 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyEmail('123456')

    expect(result.status).toBe('flow_expired')
    expect(result.error.message).toMatch(/expired|attempts/i)
    expect(authStore.getSnapshot().sessionToken).toBeNull()
  })

  it('a vanished session (410) drops the stored token', async () => {
    pending()
    const { fetchMock } = mockBackend([
      [AUTH_URL.verifyEmail, () => jsonResponse(410, { status: 410 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyEmail('123456')

    expect(result.status).toBe('session_gone')
    expect(authStore.getSnapshot().sessionToken).toBeNull()
  })

  it('with no pending token stored it reports no_pending_flow and makes no request', async () => {
    const { fetchMock } = mockBackend([])
    vi.stubGlobal('fetch', fetchMock)

    const result = await verifyEmail('123456')

    expect(result.status).toBe('no_pending_flow')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('resendVerification()', () => {
  it('a 200 re-issues the code (resent)', async () => {
    authStore.setPendingFlow('st-pending')
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.resendVerification, () => jsonResponse(200, { status: 200 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await resendVerification()

    expect(result.ok).toBe(true)
    expect(result.status).toBe('resent')
    // no body, and the pending token is resumed
    const { url, options } = calls[0]
    expect(url.endsWith('/auth/email/verify/resend')).toBe(true)
    expect(options.body).toBeUndefined()
    expect(options.headers['X-Session-Token']).toBe('st-pending')
    expect(authStore.getSnapshot().sessionToken).toBe('st-pending')
  })

  it('a 409 (quota reached or flow over) keeps the token — the last emailed code may still verify', async () => {
    authStore.setPendingFlow('st-pending')
    const { fetchMock } = mockBackend([
      [AUTH_URL.resendVerification, () => jsonResponse(409, { status: 409 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await resendVerification()

    expect(result.ok).toBe(false)
    expect(result.status).toBe('flow_expired')
    expect(result.error.message).toMatch(/can’t request another code/i)
    expect(authStore.getSnapshot().sessionToken).toBe('st-pending') // deliberately kept
  })

  it('with no pending token stored it reports no_pending_flow and makes no request', async () => {
    const { fetchMock } = mockBackend([])
    vi.stubGlobal('fetch', fetchMock)

    const result = await resendVerification()

    expect(result.status).toBe('no_pending_flow')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Session + logout
// ---------------------------------------------------------------------------

describe('getSession()', () => {
  it('returns the user from a live session', async () => {
    const { fetchMock } = mockBackend([
      [AUTH_URL.session, () =>
        jsonResponse(200, { status: 200, data: { user: USER }, meta: { is_authenticated: true } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await getSession()

    expect(result.ok).toBe(true)
    expect(result.user.first_name).toBe('Ada')
  })

  it('a dead session (401 after a failed refresh) is unauthenticated', async () => {
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.refresh, () => jsonResponse(400, { status: 400 })],
      [AUTH_URL.session, () => jsonResponse(401, { status: 401 })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await getSession()

    expect(result.ok).toBe(false)
    expect(result.status).toBe('unauthenticated')
    expect(callFor(calls, '/tokens/refresh')).toHaveLength(1)
    expect(authStore.getSnapshot().status).toBe('unauthenticated')
  })
})

describe('logout()', () => {
  it('DELETEs the session and clears the client state (the response is a 401 by contract)', async () => {
    authStore.setAuthenticated(USER, 'st-live')
    const { fetchMock, calls } = mockBackend([
      [AUTH_URL.session, () => jsonResponse(401, { status: 401, meta: { is_authenticated: false } })],
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await logout()

    expect(result.ok).toBe(true)
    expect(result.status).toBe('logged_out')
    const { url, options } = calls[0]
    expect(url.endsWith('/auth/session')).toBe(true)
    expect(options.method).toBe('DELETE')
    // a live session token is not sent on logout: the access cookie is the credential
    expect(options.headers['X-Session-Token']).toBeUndefined()

    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe('unauthenticated')
    expect(snapshot.user).toBeNull()
    expect(snapshot.sessionToken).toBeNull()
  })

  it('clears the local state even when the backend is unreachable', async () => {
    authStore.setAuthenticated(USER, 'st-live')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('failed to fetch'))))

    const result = await logout()

    expect(result.ok).toBe(true)
    expect(result.status).toBe('logged_out')
    expect(authStore.getSnapshot().status).toBe('unauthenticated')
  })
})

/**
 * Tests for the low-level API client (src/api/client.js) against the
 * documented backend contract (docs/authentication.md):
 *
 *  - the 401 -> refresh -> retry-once recovery,
 *  - single-flight refresh (concurrent 401s, one rotation),
 *  - failed refresh -> unauthenticated, no retry loop,
 *  - public auth endpoints (authenticated: false) never trigger a refresh,
 *  - network failures surface as ApiError without touching session state.
 *
 * The fetch global is mocked; the shapes below are the backend's exact
 * allauth headless response shapes (verified against core/tests.py).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, API_BASE, AUTH_URL, refreshTokens, request, toApiError } from './client'
import { authStore } from '../auth/authStore'

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

let fetchMock

beforeEach(() => {
  authStore.setUnauthenticated()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API_BASE', () => {
  it('is same-origin (relative) in tests and production builds', () => {
    expect(API_BASE).toBe('')
  })
})

describe('request() — basics', () => {
  it('sends the JSON body with Content-Type and credentials: include', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 200, data: { x: 1 } }))

    const result = await request('/captures/', {
      method: 'POST',
      body: { a: 1 },
      authenticated: false,
    })

    expect(result).toEqual({ status: 200, body: { status: 200, data: { x: 1 } } })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/captures/')
    expect(options.method).toBe('POST')
    expect(options.credentials).toBe('include')
    expect(options.headers['Content-Type']).toBe('application/json')
    expect(options.headers['Accept']).toBe('application/json')
    expect(JSON.parse(options.body)).toEqual({ a: 1 })
  })

  it('sends no body and no Content-Type when the body is absent (simple request — no CORS preflight)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 200 }))

    await request(AUTH_URL.refresh, { method: 'POST', authenticated: false })

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(AUTH_URL.refresh)
    expect(options.body).toBeUndefined()
    expect(options.headers['Content-Type']).toBeUndefined()
  })

  it('sends the pending-flow token as X-Session-Token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 200 }))

    await request(AUTH_URL.verifyEmail, {
      method: 'POST',
      body: { key: '123456' },
      sessionToken: 'st-abc',
      authenticated: false,
    })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-Session-Token']).toBe('st-abc')
  })

  it('does not parse non-JSON responses into a body', async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html>server error</html>',
    })

    const result = await request('/captures/', { method: 'GET', authenticated: false })
    expect(result).toEqual({ status: 500, body: null })
  })
})

describe('request() — 401 recovery', () => {
  it('refreshes once and retries the original request exactly once', async () => {
    authStore.setAuthenticated({ id: 1 }, null)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { access_token: 'new-at' } })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { user: { id: 1 } } })
      )

    const result = await request(AUTH_URL.session, { method: 'GET' })

    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [refreshUrl, refreshOptions] = fetchMock.mock.calls[1]
    expect(refreshUrl).toBe(AUTH_URL.refresh)
    expect(refreshOptions.method).toBe('POST')
    expect(refreshOptions.body).toBeUndefined() // the refresh cookie does the work
    // the retry is the original request, on the (now fresh) cookie
    expect(fetchMock.mock.calls[2][0]).toBe(AUTH_URL.session)
    // state survives a successful refresh
    expect(authStore.getSnapshot().status).toBe(authStore.STATUS.AUTHENTICATED)
  })

  it('a failed refresh returns the 401 without a retry and flips the client unauthenticated', async () => {
    authStore.setAuthenticated({ id: 1 }, 'pending-tok')
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(400, { status: 400 }))

    const result = await request('/captures/', { method: 'GET' })

    expect(result.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2) // no third (retried) call

    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe(authStore.STATUS.UNAUTHENTICATED)
    expect(snapshot.user).toBeNull()
    expect(snapshot.sessionToken).toBeNull()
  })

  it('a failed refresh while unauthenticated keeps a pending-flow token (it is a separate lifecycle)', async () => {
    authStore.setUnauthenticated()
    authStore.setPendingFlow('st-mid-flow')
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(400, { status: 400 }))

    const result = await request('/captures/', { method: 'GET' })

    expect(result.status).toBe(401)
    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe(authStore.STATUS.UNAUTHENTICATED)
    expect(snapshot.sessionToken).toBe('st-mid-flow') // kept: the flow may still be resumable
  })

  it('does not refresh at all for public auth endpoints (authenticated: false)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, {
        status: 401,
        data: { flows: [{ id: 'verify_email', is_pending: true }] },
        meta: { is_authenticated: false, session_token: 'st-1' },
      })
    )

    const result = await request(AUTH_URL.signup, {
      method: 'POST',
      body: { email: 'a@b.c' },
      authenticated: false,
    })

    expect(result.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no refresh call
  })

  it('a 401 after a *successful* refresh is returned as-is (no second refresh)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { status: 401 })) // original
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { access_token: 'x' } })
      ) // refresh ok
      .mockResolvedValueOnce(jsonResponse(401, { status: 401 })) // retried: still 401

    const result = await request('/captures/', { method: 'GET' })

    expect(result.status).toBe(401)
    const refreshCalls = fetchMock.mock.calls.filter(
      ([url]) => url === AUTH_URL.refresh
    )
    expect(refreshCalls).toHaveLength(1) // no loop
  })
})

describe('refreshTokens() — single-flight', () => {
  it('concurrent 401s share exactly one in-flight refresh', async () => {
    authStore.setAuthenticated({ id: 1 }, null)
    const counters = { refresh: 0, a: 0, b: 0 }
    fetchMock.mockImplementation(async (url) => {
      if (url === AUTH_URL.refresh) {
        counters.refresh += 1
        return jsonResponse(200, { status: 200, data: { access_token: 'x' } })
      }
      // each original URL: first call 401, retry 200
      const key = url === '/a' ? 'a' : 'b'
      counters[key] += 1
      return jsonResponse(counters[key] === 1 ? 401 : 200, { status: counters[key] === 1 ? 401 : 200 })
    })

    const [ra, rb] = await Promise.all([
      request('/a', { method: 'GET' }),
      request('/b', { method: 'GET' }),
    ])

    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    expect(counters.refresh).toBe(1) // one rotation for two racing 401s
    expect(counters.a).toBe(2)
    expect(counters.b).toBe(2)
  })

  it('a later expiry starts a fresh refresh (the single-flight slot is released)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { status: 200, data: { access_token: 'x' } })
    )

    expect(await refreshTokens()).toBe(true)
    expect(await refreshTokens()).toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resolves false (never throws) when the refresh request fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { status: 400 }))
    expect(await refreshTokens()).toBe(false)
  })

  it('resolves false on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'))
    expect(await refreshTokens()).toBe(false)
  })
})

describe('request() — network failures', () => {
  it('throws ApiError (network) without touching session state', async () => {
    authStore.setAuthenticated({ id: 1 }, 'tok')
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'))

    await expect(request('/captures/', { method: 'GET' })).rejects.toMatchObject({
      name: 'ApiError',
      network: true,
      status: null,
    })

    const snapshot = authStore.getSnapshot()
    expect(snapshot.status).toBe(authStore.STATUS.AUTHENTICATED) // a blip is not a logout
    expect(snapshot.user).toEqual({ id: 1 })
    expect(snapshot.sessionToken).toBe('tok')
  })

  it('propagates a network failure on the post-refresh retry', async () => {
    authStore.setAuthenticated({ id: 1 }, null)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 200, data: { access_token: 'x' } })
      )
      .mockRejectedValueOnce(new TypeError('failed to fetch'))

    await expect(request('/captures/', { method: 'GET' })).rejects.toBeInstanceOf(
      ApiError
    )
    expect(authStore.getSnapshot().status).toBe(authStore.STATUS.AUTHENTICATED)
  })
})

describe('toApiError()', () => {
  it('prefers the human-readable allauth error message and carries code/param', () => {
    const error = toApiError({
      status: 400,
      body: {
        status: 400,
        errors: [
          { message: 'Incorrect code.', code: 'incorrect_code', param: 'key' },
        ],
      },
    })
    expect(error.message).toBe('Incorrect code.')
    expect(error.code).toBe('incorrect_code')
    expect(error.param).toBe('key')
    expect(error.status).toBe(400)
    expect(error.errors).toHaveLength(1)
    expect(error.network).toBe(false)
  })

  it('falls back to a status-based message when the body has none', () => {
    expect(toApiError({ status: 500, body: null }).message).toMatch(/server hit a problem/i)
    expect(toApiError({ status: 409, body: null }).message).toMatch(/not possible right now/i)
  })

  it('accepts a caller-supplied fallback message', () => {
    const error = toApiError({ status: 409, body: null }, 'You are already signed in.')
    expect(error.message).toBe('You are already signed in.')
  })
})

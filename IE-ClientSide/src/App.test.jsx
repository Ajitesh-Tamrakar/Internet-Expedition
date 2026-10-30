// @vitest-environment jsdom
/**
 * End-to-end integration tests (planning section 7): the whole App —
 * routes, route guards, the nav layout, the real auth service, the real
 * API client, and the real session store — run against a *fake backend*.
 * The only thing stubbed is the global `fetch`, and the fake throws on
 * any request it was not told to answer, so every promise of the
 * navigation contract is exercised exactly as it would run in the
 * browser:
 *
 *  - reloading (any entry route) restores the session through the
 *    documented flow (GET auth/session, refresh on an expired access
 *    token) and lands the user where the session says they belong;
 *  - a logged-in visitor on Login/Signup is redirected to Search;
 *  - a logged-out visitor on a protected page is sent to Login;
 *  - the nav connects Search and Account;
 *  - signing out leads to Login and protected pages stay inaccessible;
 *  - a fresh login / signup-verification ends on Search.
 *
 * The response bodies are the backend's exact allauth headless shapes
 * (docs/authentication.md; the backend's core/tests.py asserts them).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import App from './App'
import { AUTH_URL } from './api/client'
import { authStore } from './auth/authStore'

// ---------------------------------------------------------------------------
// The fake backend
// ---------------------------------------------------------------------------

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

function liveSession() {
  return jsonResponse(200, {
    status: 200,
    data: { user: USER, methods: [] },
    meta: { is_authenticated: true, session_token: 'st-live' },
  })
}

/** 401 with the available flows — allauth's unauthenticated session answer. */
function deadSession() {
  return jsonResponse(401, {
    status: 401,
    data: { flows: [{ id: 'login' }] },
    meta: { is_authenticated: false },
  })
}

function refreshOk() {
  return jsonResponse(200, { status: 200, data: { access_token: 'fresh-at' } })
}

function refreshDead() {
  return jsonResponse(400, { status: 400 })
}

let fetchMock

function installBackend(handler) {
  fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // The store is a module singleton, and the pending-flow token persists
  // in sessionStorage (jsdom keeps it for the whole test file) — reset
  // both so every test starts from a clean browser.
  //
  // A *fresh page load* is the store's initial state: LOADING (no settled
  // verdict yet — the boot probe decides). Reset to exactly that, not to
  // unauthenticated: the guards act on the first render, and a pre-settled
  // "unauthenticated" would let them redirect *before* the probe runs —
  // a state a real reload never has.
  window.sessionStorage.clear()
  authStore.setUnauthenticated() // wipes the in-memory pending-flow token
  authStore.setLoading()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Session restoration on boot — the reload contract
// ---------------------------------------------------------------------------

describe('session restoration on boot (reload)', () => {
  it('restores a live session and sends / to Search', async () => {
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && url === AUTH_URL.session) return liveSession()
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
    // Boot makes exactly one request — the session probe — and the
    // protected-page chrome (the nav) is present.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(AUTH_URL.session)
    expect(screen.getByRole('link', { name: /internet expedition/i })).toBeInTheDocument()
  })

  it('restores a live session on a deep-linked reload (/search straight)', async () => {
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && url === AUTH_URL.session) return liveSession()
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/search')

    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
  })

  it('sends a dead session to Login (and public pages carry no signed-in chrome)', async () => {
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && url === AUTH_URL.session) return deadSession()
      if (method === 'POST' && url === AUTH_URL.refresh) return refreshDead()
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/')

    expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /internet expedition/i })
    ).not.toBeInTheDocument()
  })

  it('recovers an expired access session via refresh (401 -> refresh -> retried 200) and lands on Search', async () => {
    let sessionProbes = 0
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && url === AUTH_URL.session) {
        sessionProbes += 1
        return sessionProbes === 1 ? deadSession() : liveSession()
      }
      if (method === 'POST' && url === AUTH_URL.refresh) return refreshOk()
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
    // The documented recovery sequence, in order, and nothing else.
    expect(
      fetchMock.mock.calls.map(([url, options = {}]) => `${options.method ?? 'GET'} ${url}`)
    ).toEqual([
      `GET ${AUTH_URL.session}`,
      `POST ${AUTH_URL.refresh}`,
      `GET ${AUTH_URL.session}`,
    ])
  })
})

// ---------------------------------------------------------------------------
// The redirect contract — public vs protected, per the session state
// ---------------------------------------------------------------------------

describe('the redirect contract', () => {
  it.each(['/login', '/signup'])(
    'bounces a logged-in visitor on %s to Search',
    async (path) => {
      installBackend(async (url, options = {}) => {
        const method = options.method ?? 'GET'
        if (method === 'GET' && url === AUTH_URL.session) return liveSession()
        throw new Error(`unexpected ${method} ${url}`)
      })
      renderApp(path)

      expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
    }
  )

  it.each(['/search', '/account'])(
    'sends a logged-out visitor on %s to Login',
    async (path) => {
      installBackend(async (url, options = {}) => {
        const method = options.method ?? 'GET'
        if (method === 'GET' && url === AUTH_URL.session) return deadSession()
        if (method === 'POST' && url === AUTH_URL.refresh) return refreshDead()
        throw new Error(`unexpected ${method} ${url}`)
      })
      renderApp(path)

      expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument()
    }
  )
})

// ---------------------------------------------------------------------------
// The navigation between protected pages
// ---------------------------------------------------------------------------

describe('the top navigation', () => {
  it('connects Search and Account: the nav links move between them on the live session', async () => {
    const user = userEvent.setup()
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (method === 'GET' && url === AUTH_URL.session) return liveSession()
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/search')
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /^account$/i }))
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    // The session (and the user data) carried over the navigation.
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /^search$/i }))
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

describe('sign out', () => {
  it('leads to Login, and protected pages stay inaccessible afterwards', async () => {
    const user = userEvent.setup()
    let signedIn = true
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (url === AUTH_URL.session) {
        if (method === 'GET') return signedIn ? liveSession() : deadSession()
        if (method === 'DELETE') {
          signedIn = false // the backend kills the session + cookies
          return jsonResponse(401, { status: 401 })
        }
      }
      if (method === 'POST' && url === AUTH_URL.refresh) return refreshDead()
      throw new Error(`unexpected ${method} ${url}`)
    })

    renderApp('/account')
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^sign out$/i }))
    expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument()

    // Fresh app on a protected route (the user is on Login after the
    // sign-out navigation; the store is unauthenticated and the boot
    // probe confirms the session is dead) — they must not get in.
    cleanup()
    renderApp('/search')
    expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// The success paths end on Search
// ---------------------------------------------------------------------------

describe('the signed-in success paths', () => {
  it('a successful login from /login leads to Search', async () => {
    const user = userEvent.setup()
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (url === AUTH_URL.session && method === 'GET') return deadSession()
      // No refresh cookie on a fresh load: the probe's 401 triggers a
      // refresh, and the backend says no (the session never existed).
      if (url === AUTH_URL.refresh && method === 'POST') return refreshDead()
      if (url === AUTH_URL.login && method === 'POST') {
        return jsonResponse(200, {
          status: 200,
          data: { user: USER, methods: [] },
          meta: { is_authenticated: true, session_token: 'st-live', access_token: 'eyJat' },
        })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/login')
    await screen.findByRole('heading', { name: /log in/i })

    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2-secret')
    await user.click(screen.getByRole('button', { name: /^login$/i }))

    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
  })

  it('a fresh signup (Send OTP -> verify code) leads to Search', async () => {
    const user = userEvent.setup()
    installBackend(async (url, options = {}) => {
      const method = options.method ?? 'GET'
      if (url === AUTH_URL.session && method === 'GET') return deadSession()
      // No refresh cookie on a fresh load: the probe's 401 triggers a
      // refresh, and the backend says no (the session never existed).
      if (url === AUTH_URL.refresh && method === 'POST') return refreshDead()
      if (url === AUTH_URL.signup && method === 'POST') {
        // Signup succeeds as a 401 carrying the pending verify_email flow
        // (no tokens until the email is verified — docs/authentication.md).
        return jsonResponse(401, {
          status: 401,
          data: {
            flows: [
              { id: 'login' },
              { id: 'signup' },
              { id: 'verify_email', is_pending: true },
            ],
          },
          meta: { is_authenticated: false, session_token: 'st-verify' },
        })
      }
      if (url === AUTH_URL.verifyEmail && method === 'POST') {
        return jsonResponse(200, {
          status: 200,
          data: { user: USER, methods: [] },
          meta: { is_authenticated: true, session_token: 'st-live', access_token: 'eyJat' },
        })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    renderApp('/signup')
    await screen.findByRole('heading', { name: /create your account/i })

    await user.type(screen.getByLabelText(/^first name$/i), 'Ada')
    await user.type(screen.getByLabelText(/^last name$/i), 'Lovelace')
    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2-secret')
    await user.click(screen.getByRole('button', { name: /^send otp$/i }))

    await screen.findByRole('heading', { name: /verify email/i })
    await user.type(screen.getByLabelText(/6-digit code/i), '123456')
    await user.click(screen.getByRole('button', { name: /^sign up$/i }))

    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
    // The documented sequence, in order, and nothing else (the boot
    // probe and its refresh are the app's own startup, not the flow's).
    expect(
      fetchMock.mock.calls.map(([url, options = {}]) => `${options.method ?? 'GET'} ${url}`)
    ).toEqual([
      `GET ${AUTH_URL.session}`,
      `POST ${AUTH_URL.refresh}`,
      `POST ${AUTH_URL.signup}`,
      `POST ${AUTH_URL.verifyEmail}`,
    ])
  })
})

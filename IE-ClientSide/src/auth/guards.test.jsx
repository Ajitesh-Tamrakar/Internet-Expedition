// @vitest-environment jsdom
/**
 * Tests for the route guards (src/auth/guards.jsx): protected pages
 * reject unauthenticated visitors, public auth pages bounce a live
 * session to Search, and both wait out the initial session probe
 * instead of flashing a wrong destination.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { RedirectIfAuthenticated, RequireAuth } from './guards'

const snapshot = vi.hoisted(() => ({
  current: {
    status: 'unauthenticated',
    user: null,
    sessionToken: null,
    isAuthenticated: false,
    isAuthLoading: false,
  },
}))

vi.mock('./useAuth', () => ({
  useAuth: () => snapshot.current,
}))

function setAuth({ isAuthenticated, loading = false }) {
  snapshot.current = {
    status: isAuthenticated ? 'authenticated' : 'unauthenticated',
    user: isAuthenticated ? { id: 1, email: 'ada@example.com' } : null,
    sessionToken: null,
    isAuthenticated,
    isAuthLoading: loading,
  }
}

/**
 * The guard under test is attached to the route the test renders
 * (`/login` for the redirect guard, `/search` for the require guard);
 * the other routes are bare markers for navigation assertions.
 */
function renderTree(initialPath, guard) {
  const loginRoute =
    guard === 'redirect' ? (
      <RedirectIfAuthenticated>
        <div>LOGIN_MARKER</div>
      </RedirectIfAuthenticated>
    ) : (
      <div>LOGIN_MARKER</div>
    )
  const searchRoute =
    guard === 'require' ? (
      <RequireAuth>
        <div>SEARCH_CHILD</div>
      </RequireAuth>
    ) : (
      <div>SEARCH_CHILD</div>
    )
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={loginRoute} />
        <Route path="/signup" element={<div>SIGNUP_MARKER</div>} />
        <Route path="/search" element={searchRoute} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('RequireAuth (protected pages)', () => {
  it('shows a loading screen while the session probe is in flight', () => {
    setAuth({ isAuthenticated: false, loading: true })
    renderTree('/search', 'require')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('SEARCH_CHILD')).not.toBeInTheDocument()
    expect(screen.queryByText('LOGIN_MARKER')).not.toBeInTheDocument()
  })

  it('redirects an unauthenticated visitor to Login', () => {
    setAuth({ isAuthenticated: false })
    renderTree('/search', 'require')
    expect(screen.getByText('LOGIN_MARKER')).toBeInTheDocument()
    expect(screen.queryByText('SEARCH_CHILD')).not.toBeInTheDocument()
  })

  it('renders the page for an authenticated user', () => {
    setAuth({ isAuthenticated: true })
    renderTree('/search', 'require')
    expect(screen.getByText('SEARCH_CHILD')).toBeInTheDocument()
  })
})

describe('RedirectIfAuthenticated (public auth pages)', () => {
  it('shows a loading screen while the session probe is in flight', () => {
    setAuth({ isAuthenticated: true, loading: true })
    renderTree('/login', 'redirect')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('LOGIN_MARKER')).not.toBeInTheDocument()
  })

  it('renders the page for a logged-out user', () => {
    setAuth({ isAuthenticated: false })
    renderTree('/login', 'redirect')
    expect(screen.getByText('LOGIN_MARKER')).toBeInTheDocument()
  })

  it('bounces a logged-in user to Search', () => {
    setAuth({ isAuthenticated: true })
    renderTree('/login', 'redirect')
    expect(screen.getByText('SEARCH_CHILD')).toBeInTheDocument()
    expect(screen.queryByText('LOGIN_MARKER')).not.toBeInTheDocument()
  })
})

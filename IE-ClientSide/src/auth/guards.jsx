/**
 * Route guards, bound to the session store (planning section 3 — the
 * minimal scaffolding the pages need; section 7 finishes the
 * end-to-end navigation integration).
 *
 * Both wait out the initial session probe (isAuthLoading) before
 * deciding, so an authenticated user reloading on a public page is
 * never briefly shown it.
 */

import { Navigate } from 'react-router-dom'

import { useAuth } from './useAuth'

export function LoadingScreen() {
  return (
    <main className="app-shell">
      <p>Loading…</p>
    </main>
  )
}

/** Protected pages (Search): no live session → Login. */
export function RequireAuth({ children }) {
  const { isAuthenticated, isAuthLoading } = useAuth()
  if (isAuthLoading) return <LoadingScreen />
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return children
}

/** Public pages (Login, Signup): a live session → Search. */
export function RedirectIfAuthenticated({ children }) {
  const { isAuthenticated, isAuthLoading } = useAuth()
  if (isAuthLoading) return <LoadingScreen />
  if (isAuthenticated) return <Navigate to="/search" replace />
  return children
}

import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

import { initSession, useAuth } from './auth'
import { LoadingScreen, RedirectIfAuthenticated, RequireAuth } from './auth/guards'
import LoginPage from './pages/LoginPage'
import SearchPage from './pages/SearchPage'
import SignupPage from './pages/SignupPage'

/**
 * `/` — send the user where their session says they belong. A logged-in
 * user lands on Search; everyone else on Login. (Section 7 makes the
 * full navigation contract explicit; this is its core.)
 */
function RootRedirect() {
  const { isAuthenticated, isAuthLoading } = useAuth()
  if (isAuthLoading) return <LoadingScreen />
  return <Navigate to={isAuthenticated ? '/search' : '/login'} replace />
}

export default function App() {
  // Establish or restore the session when the app loads (section 2):
  // GET auth/session with the access cookie, an expired access token is
  // refreshed and the probe retried, a dead session fails closed to
  // unauthenticated. Idempotent; safe under StrictMode.
  useEffect(() => {
    initSession()
  }, [])

  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route
        path="/login"
        element={
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/signup"
        element={
          <RedirectIfAuthenticated>
            <SignupPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/search"
        element={
          <RequireAuth>
            <SearchPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

import { initSession, useAuth } from './auth'
import { LoadingScreen, RedirectIfAuthenticated, RequireAuth } from './auth/guards'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import SearchPage from './pages/SearchPage'
import SignupPage from './pages/SignupPage'
import UserInfoPage from './pages/UserInfoPage'

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
      {/*
       * The password-reset mail links here (?token=…). Deliberately NOT
       * wrapped in the authenticated-redirect guard: the endpoint is
       * public and a signed-in user may still need to finish a reset —
       * the store flips after a successful one, which takes care of the
       * /login redirect afterwards. (Path must match the backend's
       * HEADLESS_FRONTEND_URLS entries in bookmark/settings.py.)
       */}
      <Route path="/account/password/reset" element={<ResetPasswordPage />} />
      {/*
       * The user information page (section 5): the signed-in user's
       * name/email plus sign-out and change-password. Protected — the
       * reset route above is a sibling pattern, not a parent, so the two
       * coexist. (The navigation that links here lands in section 7.)
       */}
      <Route
        path="/account"
        element={
          <RequireAuth>
            <UserInfoPage />
          </RequireAuth>
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

import { useEffect } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'

import { initSession, useAuth } from './auth'
import { LoadingScreen, RedirectIfAuthenticated, RequireAuth } from './auth/guards'
import Nav from './components/Nav'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import SearchPage from './pages/SearchPage'
import SignupPage from './pages/SignupPage'
import UserInfoPage from './pages/UserInfoPage'

/**
 * `/` — send the user where their session says they belong. A logged-in
 * user lands on Search; everyone else on Login.
 */
function RootRedirect() {
  const { isAuthenticated, isAuthLoading } = useAuth()
  if (isAuthLoading) return <LoadingScreen />
  return <Navigate to={isAuthenticated ? '/search' : '/login'} replace />
}

/**
 * The chrome of the signed-in part of the app (planning section 7): the
 * top navigation and the page it wraps. It is mounted inside
 * RequireAuth (on the route below), so a logged-out visitor never sees
 * the nav at all — the guard redirects to Login *instead of* rendering
 * this. Protected access is a routing decision, not hidden UI.
 *
 * The nav is the intended connection between Search and Account (and
 * the brand's "/" link routes through RootRedirect, i.e. also to
 * Search); the other edges of the navigation graph are the pages'
 * own: Login/Signup → Search on success, Account → Login on sign-out.
 */
function ProtectedLayout() {
  return (
    <div className="protected">
      <Nav />
      <div className="protected-content">
        <Outlet />
      </div>
    </div>
  )
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
       * The protected pages (section 7): Search and the user information
       * page share the RequireAuth-gated nav layout — one guard covers
       * both (and any future protected route added under this layout):
       * a logged-out visitor is redirected to Login before the nav is
       * ever rendered, a live session gets the page plus the navigation.
       * The reset route above stays outside: it is public by contract.
       */}
      <Route
        element={
          <RequireAuth>
            <ProtectedLayout />
          </RequireAuth>
        }
      >
        <Route path="/search" element={<SearchPage />} />
        <Route path="/account" element={<UserInfoPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

import { useSyncExternalStore } from 'react'

import { authStore } from './authStore'
import {
  getAuthConfig,
  getSession,
  initSession,
  login,
  logout,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signup,
  verifyEmail,
  verifyResetLink,
} from './authService'

// Stable references so the hook's return value doesn't churn between
// renders (the snapshot changes do the re-rendering).
const actions = Object.freeze({
  initSession,
  getSession,
  login,
  signup,
  verifyEmail,
  resendVerification,
  logout,
  requestPasswordReset,
  verifyResetLink,
  resetPassword,
  getAuthConfig,
})

/**
 * The session state for components, bound with `useSyncExternalStore`.
 *
 *   const { status, user, isAuthenticated, isAuthLoading, actions } = useAuth()
 *
 * `status` is one of 'loading' (initial probe in flight) |
 * 'authenticated' | 'unauthenticated'. `user` is the backend's user
 * payload (`{id, username, email, display, has_usable_password,
 * first_name, last_name}`; empty values omitted) while authenticated,
 * else `null`.
 *
 * The token itself is never in this state — it lives in HttpOnly cookies
 * (docs/authentication.md, "SPA usage"). `sessionToken` is the
 * pending-flow resumption handle, for flows that still need it.
 */
export function useAuth() {
  const snapshot = useSyncExternalStore(authStore.subscribe, authStore.getSnapshot)

  return {
    status: snapshot.status,
    user: snapshot.user,
    sessionToken: snapshot.sessionToken,
    isAuthenticated: snapshot.status === authStore.STATUS.AUTHENTICATED,
    isAuthLoading: snapshot.status === authStore.STATUS.LOADING,
    actions,
  }
}

// The client's authentication surface (planning section 2).
//
//   import { useAuth, initSession } from './auth'
//
// Everything else in the app talks to the backend through these; the
// token contract (docs/authentication.md) is implemented exactly once,
// in src/api/client.js + this folder.

export { STATUS, authStore } from './authStore'
export { useAuth } from './useAuth'
export {
  getAuthConfig,
  getSession,
  initSession,
  login,
  logout,
  resendVerification,
  signup,
  verifyEmail,
} from './authService'

import { useEffect } from 'react'

import { initSession } from './auth'

// Minimal application shell. The application pages (Section 3 onward of
// the client implementation plan) are mounted here; until then this is a
// neutral placeholder so the dev server has something visible.

export default function App() {
  // Establish or restore the session when the app loads (section 2):
  // GET auth/session with the access cookie, an expired access token is
  // refreshed and the probe retried, a dead session fails closed to
  // unauthenticated. Idempotent; safe under StrictMode.
  useEffect(() => {
    initSession()
  }, [])

  return (
    <main className="app-shell">
      <h1>Internet Expedition</h1>
    </main>
  )
}

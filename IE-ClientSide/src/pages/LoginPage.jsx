/**
 * Login — placeholder (planning section 4). The sign-in form, the
 * unverified-account verification handoff, and error handling land in
 * section 4 on top of the auth service, which already supports every
 * outcome the page needs.
 */

import { Link } from 'react-router-dom'

export default function LoginPage() {
  return (
    <main className="auth-page">
      <h1>Log in</h1>
      <p className="auth-switch">
        Don’t have an account? <Link to="/signup">Sign up</Link>
      </p>
    </main>
  )
}

/**
 * The top navigation (planning section 7) — the persistent chrome of
 * the signed-in part of the app: the brand and the links between the
 * two protected pages (Search and Account).
 *
 * This is the "intended navigation" the plan's pages connect through:
 *
 *   Login ──(success)──▶ Search ◀──▶ Account   (this nav)
 *   Signup ─(verification)──▶ Search           Sign out (on Account) ─▶ Login
 *
 * The public pages (Login, Signup) carry no nav: a not-signed-in user
 * has no signed-in destination to navigate to — their inter-page links
 * ("Sign up" / "Log in") live on the pages themselves. That the nav
 * appears only on the protected layout is a routing decision (the
 * RequireAuth-gated layout in src/App.jsx), not a matter of hiding
 * elements — section 7's acceptance contract.
 *
 * NavLink marks the page the user is on, so the two links double as a
 * location indicator as well as a way between the pages.
 */

import { Link, NavLink } from 'react-router-dom'

function linkClass({ isActive }) {
  return `nav-link${isActive ? ' active' : ''}`
}

export default function Nav() {
  return (
    <header className="nav">
      <Link className="nav-brand" to="/">
        Internet Expedition
      </Link>
      <nav className="nav-links" aria-label="Main">
        <NavLink className={linkClass} to="/search">
          Search
        </NavLink>
        <NavLink className={linkClass} to="/account">
          Account
        </NavLink>
      </nav>
    </header>
  )
}

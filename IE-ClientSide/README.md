# Internet Expedition — Client

React + Vite client for the Internet Expedition SaaS backend (the `bookmark/`
and `core/` Django app in the repository root). In deployment the production
build is served same-origin by the backend; in development it runs as a
standalone Vite app.

The client speaks the backend's headless allauth API under `/api/auth/app/v1/`
— see `docs/authentication.md` at the repository root for the contract. The
client implementation plan is
`planning_docs/internet_expedition_client_implementation_plan.md` in the
repository root.

## Commands

- `npm install` — install dependencies (npm; `package-lock.json` is the source of truth)
- `npm run dev` — start the Vite dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the production build locally
- `npm run lint` — lint with oxlint
- `npm test` — run the client test suite (vitest)

## The API base URL

`src/api/client.js` resolves the backend base as:

```js
VITE_API_BASE_URL ?? (dev ? 'http://localhost:8080' : '')
```

- **Production** — empty (same-origin): the build is served by the backend,
  so every request is same-origin and the token cookies ride along with no
  special configuration.
- **Development** — `http://localhost:8080` (the backend's default
  `PORT`): a different origin but the same *site*, so the HttpOnly token
  cookies cross the hop with `credentials: 'include'`; the backend's CORS
  allowlist already lists the Vite origins with credentials.
- Point either at something else with `VITE_API_BASE_URL` (empty string =
  same-origin).

## Authentication (plan section 2)

The client never holds a token in JavaScript. The access and refresh tokens
live in the backend's HttpOnly cookies; the browser's cookie jar *is* the
persistence layer. The layers:

- `src/api/client.js` — the transport: JSON fetch with
  `credentials: 'include'`, the 401 → refresh → retry-once recovery, and a
  **single-flight** refresh (concurrent 401s share one rotation; a failed
  refresh flips the client unauthenticated — no retry loop).
- `src/auth/authStore.js` — the session state (`loading` / `authenticated` /
  `unauthenticated` + user payload + the pending-flow `session_token`, the
  latter kept in `sessionStorage`: it survives a reload like the cookies,
  and dies with the tab, as the server-side session it references does).
- `src/auth/authService.js` — the typed operations, each resolving to one
  result object (`{ ok, status, ... }` / `{ ok: false, status, error }`):
  `initSession`, `getSession`, `login`, `signup`, `verifyEmail`,
  `resendVerification`, `logout`, `getAuthConfig`.
- `src/auth/useAuth.js` — `useSyncExternalStore` binding for components.

```js
import { useAuth } from './auth'

const { status, user, isAuthenticated, isAuthLoading, actions } = useAuth()
// actions.login({ email, password }) -> { ok, status: 'authenticated' | ... }
```

The token lifecycle the client implements (from `docs/authentication.md`):

- **Startup / reload** — `initSession()` probes `GET auth/session`; an
  expired access cookie is refreshed (and the probe retried), a dead session
  fails closed to unauthenticated.
- **401 recovery** — any request expecting a session that gets a 401
  triggers exactly one shared refresh, then retries once; a failed refresh
  ends the session client-side.
- **Pending email-verification flows** — signup (and login of an unverified
  account) returns a 401 with the `meta.session_token`; the client stores it
  (key presence = a flow is pending) and sends it back as
  `X-Session-Token` for `verifyEmail` / `resendVerification`. The token
  rotates on success and is dropped on 410.
- **Logout** — `DELETE auth/session` (the backend clears both cookies and
  kills outstanding tokens); the local state is cleared whatever the server
  answers.

## Pages and navigation (plan sections 3–7)

| Route | Access | Page |
|---|---|---|
| `/` | — | Redirects by session state: Search if signed in, Login otherwise |
| `/login` | public (logged-in users are redirected to Search) | Email + password, unverified-account verification, forgot-password |
| `/signup` | public (logged-in users are redirected to Search) | Two-step: details → 6-digit code |
| `/account/password/reset?token=…` | public (always reachable) | The link-based reset from the recovery mail |
| `/search` | protected | The (placeholder) search page, under the nav |
| `/account` | protected | The user's name/email, change password, sign out |

Protected pages share a `RequireAuth`-gated layout: the top navigation
(brand, Search, Account — `src/components/Nav.jsx`) plus the page. A
logged-out visitor is redirected to Login *instead of* the layout
rendering, so protected access is a routing decision, not hidden UI; the
public pages carry no nav at all. The navigation graph:

```
Login ──(success)──▶ Search ◀──▶ Account (top nav)
Signup ─(verify code)──▶ Search     Account ─(sign out)──▶ Login
```

Session state follows the documented backend flow on every reload
(`src/App.test.jsx` exercises the whole app against a fake backend:
restore, redirect, sign-out, and refresh-recovery scenarios).

## Tests

`npm test` runs the layer against the documented backend contract
(mocked `fetch`; the response shapes are the backend's exact allauth
headless responses, as asserted by the backend's own test suite in
`core/tests.py`): session initialization and reload recovery, refresh
rotation and single-flight, pending-flow resumption and the duplicate-email
and resend-quota corners, and logout. On top of the per-layer tests,
`src/App.test.jsx` runs the *whole app* (routes, guards, nav, real auth
stack) against the same fake backend — the section-7 end-to-end contract:
reload restoration, the public/protected redirect rules, sign-out, and the
navigation between the signed-in pages. The build is verified with
`npm run build`.

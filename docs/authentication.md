# Authentication — django-allauth (headless API)

The auth system is **django-allauth 65.21.0** (PyPI; the project's official
source is `codeberg.org/allauth/django-allauth` — the old GitHub mirror is a
legacy copy frozen at this release). dj-rest-auth, Simple JWT, and the custom
`OneTimeToken` email-OTP system are gone (model deleted in migration `0007`;
nothing else in the user table changed).

Allauth's *headless* API is used in **app-client** mode
(`HEADLESS_CLIENTS = ("app",)`): JSON in, JSON out, no templates, no browser
session cookie, no CSRF token. Both the React SPA and the extension speak this
one contract. (The SPA uses the refresh cookie + Bearer token; the extension
derives its access token from that same cookie via the refresh endpoint.)

> **Version note.** docs.allauth.org serves two lines: *latest* (the 65.x
> releases — what we run) and *dev* (unreleased 66.x). All setting names and
> behaviors below are from the **installed 65.21.0 package source**, not the
> dev docs. Don't "modernize" to a 66.x setting name.

## Base URL

```
/api/auth/app/v1/
```

`/api/auth/` is `settings.AUTH_API_PREFIX` (see `bookmark/urls.py`); allauth's
headless app client adds `app/v1/`.

## Endpoint map

| Method & path | Auth | Purpose |
|---|---|---|
| `POST auth/signup` | — | Register: email + password + first/last name |
| `POST auth/login` | — | Email + password login |
| `POST auth/email/verify` | pending flow | Confirm the 6-digit code |
| `POST auth/email/verify/resend` | pending flow | Re-issue the code |
| `GET  auth/session` | Bearer | Current session (user payload, flows, tokens) |
| `DELETE auth/session` | Bearer | Logout (kills tokens, clears cookie) |
| `POST tokens/refresh` | refresh token (body **or** cookie) | New access token; rotates refresh |
| `GET  config` | — | Frontend config (login methods, flags) |

All responses have the allauth headless shape:

```json
{ "status": <http>, "data": {...}, "meta": {...}, "errors": [...] }
```

(`data`/`meta`/`errors` are present only when non-empty. These are plain
Django `JsonResponse`s — not DRF — which is why the tests parse
`response.content` rather than `response.data`.)

## Registration

### `POST /api/auth/app/v1/auth/signup`

```json
{"email": "ada@example.com", "password": "…",
 "first_name": "Ada", "last_name": "Lovelace"}
```

first/last come from `core.auth.inputs.CoreSignupInput` (stock allauth signup
doesn't take them; `ACCOUNT_SIGNUP_FIELDS` drives everything else).

**200-class outcome — signup succeeds but email is unverified → `401`:**

```json
{
  "status": 401,
  "data": {
    "flows": [
      {"id": "login"},
      {"id": "signup"},
      {"id": "verify_email", "is_pending": true}
    ]
  },
  "meta": {"is_authenticated": false, "session_token": "<32-char key>"}
}
```

- The user row is created (email **unverified**, password set, first/last
  stored). No tokens are issued until the email is verified.
- One email is sent containing the 6-digit code
  (`ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = True`,
  `ALLAUTH_USER_CODE_FORMAT = {"numeric": true, "length": 6}`).
- `meta.session_token` is the resumption handle for the pending flow (see
  [Flow resumption](#flow-resumption-x-session-token)).

**Duplicate email** (a user with that address already exists, requested with
the pending flow resumed): `401` with the same `flows`, **no**
`session_token` in `meta` (the session is unchanged — the client already has
its key), and one enumeration email that carries **no code**. Note the
upstream quirk: allauth's duplicate path re-issues the pending code in the
session state without emailing it, so the *original* code is now invalid
(verify → `400 incorrect_code`). The tests in `core/tests.py` document this
exactly; a product decision (e.g. surfacing a "use your first email / request
a reset") is needed before relying on this path.

While an authenticated Bearer token is presented, signup → `409`.

### `POST /api/auth/app/v1/auth/email/verify`

```json
{"key": "123456"}
```

- Wrong code → `400`:
  `{"status": 400, "errors": [{"message": "Incorrect code.", "code": "incorrect_code", "param": "key"}]}`.
  Each wrong attempt is counted (`ACCOUNT_EMAIL_VERIFICATION_BY_CODE_MAX_ATTEMPTS = 3`);
  the 3rd wrong code **aborts** the pending flow → subsequent verify/resend → `409`.
- Code window `ACCOUNT_EMAIL_VERIFICATION_BY_CODE_TIMEOUT = 900s`; an expired
  code behaves like an aborted flow → `409`.
- Correct code → `200` — the user is now fully authenticated:

```json
{
  "status": 200,
  "data": {
    "user": {"id": 1, "display": "ada", "email": "ada@example.com",
              "has_usable_password": true, "username": "ada",
              "first_name": "Ada", "last_name": "Lovelace"},
    "methods": []
  },
  "meta": {
    "is_authenticated": true,
    "session_token": "<new key>",
    "access_token": "eyJ…"
  }
}
```

plus a `Set-Cookie: refresh_token=…` (see [Refresh token cookie](#refresh-token-cookie)).
The refresh token that allauth emitted in `meta` is **removed from the body**
by `core.auth.middleware`. The email address is now marked verified
(`EmailAddress.verified = True`), and the pending login completes — which
cycles the Django session key, so the **old** `session_token` from signup is
dead (`410` if reused) and the new one is the live handle.

The `user` payload's first/last fields come from
`core.auth.adapter.CoreHeadlessAdapter` (stock allauth omits them).

### `POST /api/auth/app/v1/auth/email/verify/resend`

No body. `200` and a fresh code email (old code dies; the window restarts).
`409` when the flow is aborted/expired or the resend quota is reached
(`ACCOUNT_EMAIL_VERIFICATION_SUPPORTS_RESEND = 3`).

## Login

### `POST /api/auth/app/v1/auth/login`

```json
{"email": "ada@example.com", "password": "…"}
```

- Verified user → `200` with the same shape as the verify success above
  (`meta.access_token` + refresh cookie; `data.user`, `data.methods`).
- Wrong password / unknown email → `400`
  `{"code": "email_password_mismatch", "param": "password",
    "message": "The email address and/or password you specified are not correct."}`
  — identical for both (enumeration prevention), and no email is sent for an
  unknown address.
- Unverified user → `401` with `verify_email` pending in `data.flows`,
  `meta.session_token`, **no access/refresh token**, and a fresh code email
  (self-healing: verify with it and the login completes).
- `X-Session-Token` referencing a dead session → `410` (Gone).

## Session

### `GET /api/auth/app/v1/auth/session` (Bearer)

`200` → `data.user` + `data.flows` (reauth flows), `meta.is_authenticated: true`.
Unauthenticated → `401` with the available `flows` (same shape as signup).

### `DELETE /api/auth/app/v1/auth/session` (Bearer)

Logout: Django session flushed, refresh cookie **cleared** (`Set-Cookie` with
empty value, `Max-Age=0`, same path/attributes), response `401`. Because of
[stateful validation](#token-lifecycle), every outstanding access token for
that session dies immediately.

## Tokens

### `POST /api/auth/app/v1/tokens/refresh`

Body `{"refresh_token": "…"}` — **or no body**: a browser can't read its own
HttpOnly cookie, so `core.auth.views.RefreshTokenView` falls back to the
`refresh_token` cookie when the body is empty (the body value wins when
present, keeping the native-app contract intact).

- Valid → `200` `{"data": {"access_token": "eyJ…"}}` + `Set-Cookie` with the
  **rotated** refresh token. `HEADLESS_JWT_ROTATE_REFRESH_TOKEN = True`: the
  old refresh token is invalidated server-side (it's tracked per-session as
  `jti → exp`).
- Stale (already rotated), garbage, or a token whose session is gone
  (logout/expiry) → `400`.

## Token lifecycle

allauth's JWT strategy (`allauth.headless.tokens.strategies.jwt.JWTTokenStrategy`,
selected via `HEADLESS_TOKEN_STRATEGY`) is **session-backed**:

- The access token is an HS256 JWT (claims: `sub`, `iat`, `exp`, `jti`,
  `token_use: "access"`, `sid`). `sid` is the Django session key encrypted
  with AES-CTR keyed on `SHA256(SECRET_KEY)` — it lets a token resolve its
  session without the sessionid cookie.
- `HEADLESS_JWT_STATEFUL_VALIDATION_ENABLED = True`: every access-token
  validation does one session lookup (`sid` → session → user) and fails if
  the session is gone. **Logout (or session expiry) kills outstanding access
  tokens instantly** instead of letting them run out their 15-minute life.
  Cost: one session lookup per authenticated request — the `django.contrib.sessions`
  app and a working session backend are hard requirements.
- Expiry: access `HEADLESS_JWT_ACCESS_TOKEN_EXPIRES_IN = 900` (15 min),
  refresh `HEADLESS_JWT_REFRESH_TOKEN_EXPIRES_IN = 604800` (7 days).
- Signing: `HEADLESS_JWT_ALGORITHM = "HS256"`; with
  `HEADLESS_JWT_PRIVATE_KEY` unset, allauth signs with Django's `SECRET_KEY`
  (its documented fallback for symmetric algorithms — same trust model the
  old Simple JWT setup had). Set `HEADLESS_JWT_PRIVATE_KEY` to move to an
  asymmetric key without code changes.

Client flow: `login/verify` → keep `access_token` (JS-readable) + the browser
keeps the HttpOnly refresh cookie → on 401, `POST tokens/refresh` with an
**empty body** (the browser attaches the cookie) → new access token → retry.

## Flow resumption (`X-Session-Token`)

App-client requests run against a fresh Django session; multi-stage flows
resume by sending back the `meta.session_token` from the previous response as
the `X-Session-Token` header. Rules of thumb:

- After every response that advances a flow, use the **new**
  `meta.session_token` (login cycles the session key — older tokens 410).
- The session token and access token can both be presented; the strategy
  prefers `X-Session-Token` and falls back to the Bearer `sid`.
- A token whose session no longer exists → `410 Gone` — the client should
  drop it and start over.

## Refresh token cookie

`core/auth/cookies.py` + `core/auth/middleware.py` (the one thing allauth
doesn't do itself): the middleware moves `refresh_token` from the response
body (`meta` on auth responses, `data` on refresh) into a cookie and removes
it from JSON, and clears it on logout.

- `HttpOnly` is a fixed invariant (never configurable) — the refresh token
  is a long-lived credential and must never reach JavaScript.
- `access_token` and `session_token` deliberately stay in the body.
- Attributes (all `AUTH_REFRESH_COOKIE_*` env-tunable in `bookmark/settings.py`):

| Attribute | Setting | Default |
|---|---|---|
| name | `AUTH_REFRESH_COOKIE_NAME` | `refresh_token` |
| path | `AUTH_REFRESH_COOKIE_PATH` | `/api/auth/app/v1/tokens/` |
| domain | `AUTH_REFRESH_COOKIE_DOMAIN` | (host-only) |
| Secure | `AUTH_REFRESH_COOKIE_SECURE` | `not DEBUG` |
| SameSite | `AUTH_REFRESH_COOKIE_SAMESITE` | `Lax` |

The path is scoped to the refresh endpoint on purpose — the cookie is
attached nowhere else. **Deployment:** `Secure` is on (DEBUG off), and the
extension's cross-origin derive call needs `SameSite=None` — but only
*after* the CORS allowlist is tightened (B0/M4 order: with `Secure`+`None`,
`CORS_ALLOW_ALL_ORIGINS=True` would let any site steal the token).

## Configuration (settings)

| Setting | Value | Meaning |
|---|---|---|
| `HEADLESS_CLIENTS` | `("app",)` | Only the app client is served (no `browser/` routes) |
| `HEADLESS_ONLY` | `True` | No headed (template) allauth views exist; internal link-based flows raise controlled errors instead of redirecting. (65.21.0 name — **no** `ALLAUTH_` prefix.) |
| `HEADLESS_FRONTEND_URLS` | 5 relative-path entries | Every urlname allauth may link **must** have an entry — with `HEADLESS_ONLY`, a missing one raises `ImproperlyConfigured` (500) mid-flow. Relative paths resolve against the request origin (dev/tests); set `FRONTEND_URL` in deployment to point link-based mails (password reset) at the real frontend. |
| `HEADLESS_TOKEN_STRATEGY` | the built-in JWT strategy | (module path) |
| `HEADLESS_JWT_*` | see [lifecycle](#token-lifecycle) | |
| `AUTHENTICATION_BACKENDS` | ModelBackend + **allauth's** `AuthenticationBackend` | Without the allauth backend, email credentials never match a user (Django's `ModelBackend` only matches the username field) — every login fails `email_password_mismatch`. |
| `ACCOUNT_LOGIN_METHODS` | `{"email"}` | Email is the only credential type |
| `ACCOUNT_SIGNUP_FIELDS` | email*, password1*, first_name*, last_name* | |
| `ACCOUNT_EMAIL_VERIFICATION` | `mandatory` | Unverified accounts never authenticate |
| `ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED` | `True` | Code instead of link |
| `ALLAUTH_USER_CODE_FORMAT` | numeric, 6, no dash | |
| `EMAIL_VERIFICATION_MAX_RESEND_COUNT` | 3 | (via `EMAIL_VERIFICATION_SUPPORTS_RESEND = 3`) |
| `EMAIL_UNKNOWN_ACCOUNTS` | `True` | "No account with this email" mail on login failure |
| `EMAIL_RATE_LIMITS` | `3/1m, 100/24h, 10/24h-unknown` | Per-address confirmation-mail throttling |
| `AUTH_API_PREFIX` | `/api/auth/` | Where the headless API is mounted |
| `REST_FRAMEWORK DEFAULT_AUTHENTICATION_CLASSES` | allauth `JWTTokenAuthentication` | The DRF side of the token contract |
| MIDDLEWARE | + `core.auth.middleware.RefreshCookieMiddleware` | The cookie translation (after allauth's `AccountMiddleware`) |

## Migrations & requirements

- `0007_delete_onetimetoken` — removes the old OTP model. No other user-table
  changes; existing users carry over (email logins keep working; unverified
  users verify on next login via the self-healing flow above).
- `requirements.txt`: `django-allauth==65.21.0`, `PyJWT==2.15.0`,
  `cryptography==50.0.2` (allauth's JWT strategy needs both at runtime);
  dj-rest-auth / django-allauth's old pins / djangorestframework-simplejwt
  removed.

## Env vars (deployment)

| Var | Default | Notes |
|---|---|---|
| `HEADLESS_JWT_ALGORITHM` | `HS256` | |
| `HEADLESS_JWT_PRIVATE_KEY` | *(unset → SECRET_KEY)* | Set to move to RS/ES keys |
| `HEADLESS_JWT_ACCESS_TOKEN_EXPIRES_IN` | `900` | seconds |
| `HEADLESS_JWT_REFRESH_TOKEN_EXPIRES_IN` | `604800` | seconds |
| `HEADLESS_JWT_STATEFUL_VALIDATION_ENABLED` | `True` | |
| `AUTH_REFRESH_COOKIE_*` | see [cookie](#refresh-token-cookie) | `AUTH_REFRESH_COOKIE_SAMESITE=Strict` is set in the dev `.env` (B0/M4) |
| `FRONTEND_URL` | *(empty → relative paths)* | Must be set where link-based mails are user-visible |

## Tests

```
venv/bin/python manage.py test core.tests.SignupTests core.tests.EmailVerificationTests \
  core.tests.LoginTests core.tests.AccessTokenTests core.tests.RefreshTokenTests \
  core.tests.LogoutTests core.tests.ConfigTests --noinput
```

(in `core/tests.py`, replacing the old email-OTP section; fully offline —
mail in the outbox, tokens parsed/`HS256`-re-signed locally, cookie asserts
against the actual `Set-Cookie`.)

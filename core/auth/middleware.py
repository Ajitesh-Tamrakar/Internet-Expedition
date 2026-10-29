"""Refresh-token cookie middleware for the allauth headless app client.

allauth's headless API is shaped for native apps: when a user becomes
fully authenticated it returns ``access_token`` + ``refresh_token`` in
the JSON ``meta``; ``tokens/refresh`` returns the (rotated) pair in
``data``. A web client must not expose the refresh token to JavaScript,
and a browser cannot read its own HttpOnly cookies to submit them in a
body.

This module owns that translation, for the headless *app* client
only (everything under ``<AUTH_API_PREFIX>app/``):

* response: ``meta.refresh_token`` / ``data.refresh_token`` is moved
  into the HttpOnly cookie and removed from the body;
* response: a freshly minted ``access_token`` is *also mirrored* into
  an HttpOnly cookie — the body copy stays (non-browser clients read
  it); the browser never needs to hold it in JavaScript;
* logout (``DELETE .../auth/session``) clears both cookies.

Left untouched on purpose:

* ``access_token`` stays in ``meta``/``data`` — the extension and other
  non-browser clients read it from the JSON and keep it in their own
  storage (the SPA simply ignores the body copy);
* ``session_token`` stays in ``meta`` — it is part of allauth's
  app-client contract: allauth runs each app-client request against a
  fresh session, so multi-stage flows (signup → email verify) resume by
  sending the value back as the ``X-Session-Token`` header. The SPA must
  keep it exactly as it keeps the access token; it expires with the
  server-side session.

CSRF: the app-client views are ``csrf_exempt`` inside allauth, so
cookie-carried requests carry no CSRF token; the cross-origin controls
are the cookies' SameSite/Secure attributes and the CORS allowlist
(see ``bookmark.settings``). The access cookie is consumed by every API
endpoint via :class:`AccessTokenBridgeMiddleware` — its ``Path=/api/``
plus ``SameSite=Lax`` is what keeps third-party sites from attaching it
to cross-site requests.
"""
import json

from django.conf import settings
from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin

from core.auth.cookies import (
    clear_access_cookie,
    clear_refresh_cookie,
    set_access_cookie,
    set_refresh_cookie,
)


def _app_prefix() -> str:
    # <mount>app/v1/...  (the app-client subtree of the headless API)
    return f"{settings.AUTH_API_PREFIX}app/"


def _logout_path() -> str:
    return f"{settings.AUTH_API_PREFIX}app/v1/auth/session"


class RefreshCookieMiddleware(MiddlewareMixin):
    def process_response(self, request, response):
        if not request.path.startswith(_app_prefix()):
            return response
        if not isinstance(response, JsonResponse):
            return response
        if not response.get("Content-Type", "").startswith("application/json"):
            return response

        try:
            payload = json.loads(response.content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return response
        if not isinstance(payload, dict):
            return response

        # The refresh token arrives in ``meta`` when the user becomes
        # authenticated (login/verify responses) and in ``data`` from
        # ``tokens/refresh`` (allauth's RefreshTokenResponse). Both are
        # moved into the cookie and removed from the body; the
        # ``access_token`` stays in the body in both places.
        sources = []
        meta = payload.get("meta")
        if isinstance(meta, dict):
            sources.append(meta)
        data = payload.get("data")
        if isinstance(data, dict):
            sources.append(data)

        changed = False
        refresh_token = None
        for source in sources:
            refresh_token = source.pop("refresh_token", None)
            if refresh_token:
                set_refresh_cookie(response, refresh_token)
                changed = True

        # Mirror the access token into a cookie for browser clients.
        # allauth only exposes a *new* access token when one is actually
        # minted (the login/verify transition, and every refresh), so
        # the cookie's 15-minute clock tracks the token's; the body
        # copy is left in place for non-browser clients.
        access_token = None
        for source in sources:
            token = source.get("access_token")
            if isinstance(token, str) and token:
                access_token = token
        if access_token:
            set_access_cookie(response, access_token)

        if request.method == "DELETE" and request.path == _logout_path():
            clear_refresh_cookie(response)
            clear_access_cookie(response)
            changed = True

        if not changed:
            return response

        response.content = json.dumps(payload).encode("utf-8")
        response["Content-Length"] = str(len(response.content))
        return response


class AccessTokenBridgeMiddleware(MiddlewareMixin):
    """Read side of the access-token cookie: cookie -> header.

    A browser cannot read its own HttpOnly cookies to build an
    ``Authorization`` header, so when a request carries the access
    cookie but no header, the header is synthesized from the cookie.
    Everything downstream — allauth's JWT strategy (it reads
    ``META["HTTP_AUTHORIZATION"]``) and DRF's ``JWTTokenAuthentication``
    — then behaves exactly as if the client had sent the token explicitly.

    Two deliberate rules:

    * a present ``Authorization`` header always wins — even a stale or
      garbage one. Not falling back to the cookie when a header is
      present would let a client that believes it is authenticated
      silently authenticate as someone else's session.
    * a missing/empty cookie is a no-op: the cookie is ``Path=/api/``,
      so it only ever rides API requests.
    """

    def process_request(self, request):
        if request.META.get("HTTP_AUTHORIZATION"):
            return None
        token = request.COOKIES.get(settings.AUTH_ACCESS_COOKIE_NAME)
        if token:
            request.META["HTTP_AUTHORIZATION"] = f"Bearer {token}"
        return None

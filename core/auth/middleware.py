"""Refresh-token cookie middleware for the allauth headless app client.

allauth's headless API is shaped for native apps: when a user becomes
fully authenticated it returns ``access_token`` + ``refresh_token`` in
the JSON ``meta``; ``tokens/refresh`` returns the (rotated) pair in
``data``. A web client must not expose the refresh token to JavaScript,
and a browser cannot read its own HttpOnly cookies to submit them in a
body.

This middleware owns that translation, for the headless *app* client
only (everything under ``<AUTH_API_PREFIX>app/``):

* response: ``meta.refresh_token`` / ``data.refresh_token`` is moved
  into the HttpOnly cookie and removed from the body;
* logout (``DELETE .../auth/session``) clears the cookie.

Left untouched on purpose:

* ``access_token`` stays in ``meta`` — short-lived, and the client needs
  it in JS to call protected APIs;
* ``session_token`` stays in ``meta`` — it is part of allauth's
  app-client contract: allauth runs each app-client request against a
  fresh session, so multi-stage flows (signup → email verify) resume by
  sending the value back as the ``X-Session-Token`` header. The SPA must
  keep it exactly as it keeps the access token; it expires with the
  server-side session.

CSRF: the app-client views are ``csrf_exempt`` inside allauth, so a
cookie-carried refresh POST carries no CSRF token; the cross-origin
controls are the cookie's SameSite/Secure attributes and the CORS
allowlist (see ``bookmark.settings``).
"""
import json

from django.conf import settings
from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin

from core.auth.cookies import clear_refresh_cookie, set_refresh_cookie


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
        # authenticated (signup/login/verify responses) and in ``data``
        # from ``tokens/refresh`` (allauth's RefreshTokenResponse).
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

        if request.method == "DELETE" and request.path == _logout_path():
            clear_refresh_cookie(response)
            changed = True

        if not changed:
            return response

        response.content = json.dumps(payload).encode("utf-8")
        response["Content-Length"] = str(len(response.content))
        return response

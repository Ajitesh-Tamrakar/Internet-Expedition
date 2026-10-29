"""Customized allauth headless views (mounted in place of the stock ones).

Two endpoints need a tweak; everything else is the stock allauth URL tree
(see ``allauth.headless.urls``):

* signup — accepts ``first_name``/``last_name`` (stock signup does not).
* tokens/refresh — also accepts the refresh token from the HttpOnly cookie
  (a browser cannot read that cookie to put it in the JSON body; allauth's
  stock view only reads the body).
"""
from django.conf import settings

from allauth.headless.account import views as allauth_account_views
from allauth.headless.tokens import views as allauth_token_views

from core.auth.inputs import CoreSignupInput


class CoreSignupView(allauth_account_views.SignupView):
    """Stock headless signup + first/last name collection."""

    input_class = {"POST": CoreSignupInput}


class RefreshTokenView(allauth_token_views.RefreshTokenView):
    """Stock refresh flow, with the refresh token also read from the
    HttpOnly cookie.

    The body value wins when present (the stock, native-app-shaped
    contract); the cookie is the fallback that makes the endpoint usable
    from a browser, where the token is invisible to JavaScript.
    """

    def handle_input(self, data):
        # allauth's RefreshTokenInput has no init kwargs, so the cookie
        # fallback is merged into the parsed body instead. An empty/absent
        # body value (what a browser sends — it cannot read its own
        # HttpOnly cookie) falls back to the cookie.
        if not (data or {}).get("refresh_token"):
            cookie_token = self.request.COOKIES.get(
                settings.AUTH_REFRESH_COOKIE_NAME
            )
            if cookie_token:
                data = dict(data or {})
                data["refresh_token"] = cookie_token
        return super().handle_input(data)

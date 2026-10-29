"""HttpOnly token-cookie helpers.

The refresh token is a long-lived credential: whoever holds it can mint
access tokens. It therefore never appears in a JSON response body or a
request body written by JavaScript — it lives in a cookie that only the
browser sends.

The access token is short-lived (15 min) and *also* mirrored into a
cookie so the SPA never holds it in JavaScript; its body copy stays for
non-browser clients (the extension). ``HttpOnly`` is a fixed invariant on
both; the other attributes come from the AUTH_REFRESH_COOKIE_* /
AUTH_ACCESS_COOKIE_* blocks in ``bookmark.settings``.
"""
from django.conf import settings


def refresh_cookie_kwargs() -> dict:
    """Attributes shared by set and delete (delete must match set)."""
    return {
        "max_age": settings.HEADLESS_JWT_REFRESH_TOKEN_EXPIRES_IN,
        "path": settings.AUTH_REFRESH_COOKIE_PATH,
        "domain": settings.AUTH_REFRESH_COOKIE_DOMAIN or None,
        "secure": settings.AUTH_REFRESH_COOKIE_SECURE,
        "httponly": True,
        "samesite": settings.AUTH_REFRESH_COOKIE_SAMESITE,
    }


def set_refresh_cookie(response, token: str) -> None:
    response.set_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        token,
        **refresh_cookie_kwargs(),
    )


def clear_refresh_cookie(response) -> None:
    # Django 5.2's delete_cookie() derives ``secure`` from the cookie name
    # and drops httponly, which would not match a Secure-set cookie. An
    # empty value with max_age=0 expires the cookie on the next round
    # trip while matching every attribute the set used.
    kwargs = refresh_cookie_kwargs()
    kwargs["max_age"] = 0
    response.set_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        "",
        expires=0,
        **kwargs,
    )


def access_cookie_kwargs() -> dict:
    """Attributes for the access-token cookie (mirror of the refresh one)."""
    return {
        # The cookie dies in step with the token it carries.
        "max_age": settings.HEADLESS_JWT_ACCESS_TOKEN_EXPIRES_IN,
        # Every API endpoint, unlike the refresh cookie's single door.
        "path": settings.AUTH_ACCESS_COOKIE_PATH,
        "domain": settings.AUTH_ACCESS_COOKIE_DOMAIN or None,
        "secure": settings.AUTH_ACCESS_COOKIE_SECURE,
        "httponly": True,
        "samesite": settings.AUTH_ACCESS_COOKIE_SAMESITE,
    }


def set_access_cookie(response, token: str) -> None:
    response.set_cookie(
        settings.AUTH_ACCESS_COOKIE_NAME,
        token,
        **access_cookie_kwargs(),
    )


def clear_access_cookie(response) -> None:
    kwargs = access_cookie_kwargs()
    kwargs["max_age"] = 0
    response.set_cookie(
        settings.AUTH_ACCESS_COOKIE_NAME,
        "",
        expires=0,
        **kwargs,
    )

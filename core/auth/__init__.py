"""Authentication integration around django-allauth (headless API + JWT).

The authentication system is allauth itself — nothing here implements
password hashing, OTP, or token signing. This package holds only the
smallest integration layer allauth does not provide on its own:

* ``inputs.CoreSignupInput`` — first/last name on signup (the stock
  headless signup form only knows email/username/phone/password).
* ``views.CoreSignupView`` / ``views.RefreshTokenView`` — mount the
  customized endpoints in place of the stock ones.
* ``middleware.RefreshCookieMiddleware`` + ``cookies`` — the refresh
  token travels as an HttpOnly cookie, never in a JSON body.
"""

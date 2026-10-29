from django.contrib import admin
from django.urls import path, include

from allauth.headless.constants import Client

from core.auth.views import CoreSignupView, RefreshTokenView

# Allauth headless API (the whole authentication surface):
#
#   POST {AUTH_API_PREFIX}app/v1/auth/signup            (core variant)
#   POST {AUTH_API_PREFIX}app/v1/auth/login
#   POST {AUTH_API_PREFIX}app/v1/auth/email/verify      {"key": "<6-digit code>"}
#   POST {AUTH_API_PREFIX}app/v1/auth/email/verify/resend
#   GET  {AUTH_API_PREFIX}app/v1/auth/session           current user / tokens
#   DELETE {AUTH_API_PREFIX}app/v1/auth/session         logout
#   POST {AUTH_API_PREFIX}app/v1/tokens/refresh         (core variant)
#   GET  {AUTH_API_PREFIX}app/v1/config
#   ... (account/email, password reset/change — see docs/authentication.md)
#
# The two core variants are declared BEFORE the stock include so they win
# the URL match (signup: first/last name; refresh: cookie support).
# Everything else below is allauth's own URL tree, untouched.
urlpatterns = [
    path('admin/', admin.site.urls),
    path(
        'api/auth/app/v1/auth/signup',
        CoreSignupView.as_api_view(client=Client.APP),
    ),
    path(
        'api/auth/app/v1/tokens/refresh',
        RefreshTokenView.as_api_view(client=Client.APP),
    ),
    path('api/auth/', include('allauth.headless.urls')),
    path('', include('core.api.urls')),
]

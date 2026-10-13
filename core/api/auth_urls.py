"""Authentication API: passwordless email-OTP login.

The dj-rest-auth password login and password-reset routes are intentionally
not mounted - accounts have unusable passwords. What dj-rest-auth still
provides here is the JWT-compatible user detail, logout, and refresh views;
everything code-related is the custom views in core.api.auth_views.
"""
from django.urls import path
from rest_framework_simplejwt.views import TokenVerifyView

from dj_rest_auth.jwt_auth import get_refresh_view
from dj_rest_auth.views import LogoutView, UserDetailsView

from core.api.auth_views import (
    ConfirmCodeView,
    RegisterView,
    RequestLoginCodeView,
    ResendLoginCodeView,
)

urlpatterns = [
    # Passwordless OTP
    path("registration/", RegisterView.as_view(), name="otp_register"),
    path("login/request/", RequestLoginCodeView.as_view(), name="otp_request"),
    path("login/confirm/", ConfirmCodeView.as_view(), name="otp_confirm"),
    path("login/resend/", ResendLoginCodeView.as_view(), name="otp_resend"),
    # dj-rest-auth (JWT-compatible)
    path("logout/", LogoutView.as_view(), name="rest_logout"),
    path("user/", UserDetailsView.as_view(), name="rest_user_details"),
    # JWT lifecycle
    path("token/refresh/", get_refresh_view().as_view(), name="token_refresh"),
    path("token/verify/", TokenVerifyView.as_view(), name="token_verify"),
]

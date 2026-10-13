"""Passwordless, email-OTP authentication endpoints.

Flow:
    POST /api/auth/registration/   {"email"}            -> create account + code
    POST /api/auth/login/request/  {"email"}            -> email a code
    POST /api/auth/login/resend/   {"email"}            -> email a code (quota)
    POST /api/auth/login/confirm/  {"email", "code"}    -> verify + return JWT

The confirm step is shared by signup verification and login: a confirmed
code proves control of the address, so it also marks the email verified.
The JWT is minted with dj-rest-auth's jwt_encode(); the access token goes
in the response body (the client keeps it in localStorage) and the refresh
token in an HttpOnly cookie (see dj_rest_auth.jwt_auth + REST_AUTH
JWT_AUTH_* in settings), so it is invisible to JavaScript.

Security:
  * Every endpoint is throttled per IP (see REST_FRAMEWORK throttle rates).
  * request/resend always answer 200 whether or not the account exists
    (anti-enumeration); mail goes out only for real, active accounts.
  * confirm answers with a single generic error for unknown account, wrong
    code, expired code, or exhausted attempts.
"""
import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from allauth.account.adapter import get_adapter
from allauth.account.models import EmailAddress

from core import otp
from core.api.auth_serializers import (
    ConfirmCodeSerializer,
    RegisterSerializer,
    RequestCodeSerializer,
    UserSerializer,
)
from core.models import OneTimeToken
from dj_rest_auth.app_settings import api_settings as rest_auth_settings
from dj_rest_auth.jwt_auth import set_jwt_refresh_cookie
from dj_rest_auth.utils import jwt_encode

User = get_user_model()

logger = logging.getLogger(__name__)

# One message for every failure - never reveal *why* it failed.
INVALID = {"detail": "Invalid or expired code. Please try again."}


class _OtpThrottle(AnonRateThrottle):
    scope = "otp"


class _OtpConfirmThrottle(AnonRateThrottle):
    scope = "otp_confirm"


def _jwt_payload(user) -> dict:
    access, refresh = jwt_encode(user)
    return {
        "user": UserSerializer(user).data,
        "access": str(access),
        "refresh": str(refresh),
    }


class _DuplicateEmail(Exception):
    """Internal signal from the register transaction: 409, not an error."""


class RegisterView(APIView):
    """Create a passwordless account and email a verification code.

    Account creation and code issuance happen in one transaction: if the
    mail provider refuses the message, the account is rolled back too, so a
    failed send never leaves behind an account the user cannot verify.
    """

    permission_classes = [AllowAny]
    throttle_classes = [_OtpThrottle]
    serializer_class = RegisterSerializer

    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].lower()

        try:
            with transaction.atomic():
                if otp.get_user_by_email(email):
                    raise _DuplicateEmail()
                # The default User model requires a username; derive one from
                # the email the way allauth does for email-based accounts.
                username = get_adapter().generate_unique_username([email])
                user = User.objects.create_user(
                    username=username, email=email, password=None  # unusable
                )
                user.is_active = True
                user.save(update_fields=["is_active"])
                EmailAddress.objects.create(
                    user=user, email=email, primary=True, verified=False
                )
                otp.issue_code(user=user, purpose=OneTimeToken.Purpose.SIGNUP)
        except _DuplicateEmail:
            return Response(
                {"detail": "An account with that email already exists."},
                status=status.HTTP_409_CONFLICT,
            )
        except Exception:
            return Response(
                {"detail": "Could not send the verification email. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(
            {"detail": f"A verification code has been sent to {email}."},
            status=status.HTTP_202_ACCEPTED,
        )


class RequestLoginCodeView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [_OtpThrottle]
    serializer_class = RequestCodeSerializer

    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].lower()
        user = otp.get_user_by_email(email)
        # Mail goes out only for real, active accounts - but the answer is
        # always 200, so the endpoint reveals nothing about existence.
        if user is not None and user.is_active and otp.can_resend(user=user):
            otp.issue_code(user=user, purpose=OneTimeToken.Purpose.LOGIN)
        return Response(
            {
                "detail": (
                    "If an account exists for that address, a sign-in code "
                    "has been sent."
                )
            }
        )


class ResendLoginCodeView(RequestLoginCodeView):
    """Alias of request with its own name/route for client clarity; the
    resend quota (OTP_MAX_RESENDS per TTL window) is enforced in the
    service layer."""


class ConfirmCodeView(APIView):
    """Verify the emailed code and return the JWT pair.

    Shared by signup verification and login: on success the email is marked
    verified (allauth) and the account is issued an access + refresh token.
    """

    permission_classes = [AllowAny]
    throttle_classes = [_OtpConfirmThrottle]
    serializer_class = ConfirmCodeSerializer

    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].lower()
        code = serializer.validated_data["code"]

        user = otp.get_user_by_email(email)
        if user is None or not user.is_active:
            return Response(INVALID, status=status.HTTP_400_BAD_REQUEST)

        if not otp.verify_code(user=user, code=code):
            return Response(INVALID, status=status.HTTP_400_BAD_REQUEST)

        # Side effect, never a login blocker: a hiccup here must not 500 the
        # response (the code above has already done its job).
        try:
            otp.mark_email_verified(user, email)
        except Exception:
            logger.exception("mark_email_verified failed; continuing login")

        response = Response(_jwt_payload(user), status=status.HTTP_200_OK)
        # Deliver the refresh token as an HttpOnly cookie (no-op unless a
        # JWT_AUTH_REFRESH_COOKIE name is configured) and keep the body
        # free of it - the client never needs to see it.
        if rest_auth_settings.JWT_AUTH_REFRESH_COOKIE:
            set_jwt_refresh_cookie(response, response.data["refresh"])
            del response.data["refresh"]
        return response

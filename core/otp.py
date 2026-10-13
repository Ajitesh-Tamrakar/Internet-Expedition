"""Stateless, email-based OTP service for passwordless authentication.

Kept free of DRF/HTTP so the same logic is testable and reusable (e.g. from
a management command or, later, an SMS channel).

Security posture:
  * The code is never stored in the clear - only a salted SHA-256 hash, so a
    database leak does not expose live codes.
  * Codes expire (OTP_CODE_TTL_SECONDS) and are single-use.
  * Wrong entries are counted; exceeding OTP_MAX_ATTEMPTS invalidates the
    code. Resends within the TTL window are capped (OTP_MAX_RESENDS).
  * Code generation and email delivery reuse django-allauth (adapter), which
    respects ACCOUNT_LOGIN_BY_CODE_FORMAT and the project's SMTP settings.
    allauth's AccountMiddleware (see bookmark.settings MIDDLEWARE) supplies
    the request context its mail helpers need.
"""
import hashlib
import secrets
import string
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone
from django.utils.crypto import get_random_string

from allauth.account.adapter import get_adapter
from allauth.account.models import EmailAddress

from core.models import OneTimeToken

User = get_user_model()

CODE_TTL = timedelta(seconds=getattr(settings, "OTP_CODE_TTL_SECONDS", 300))
MAX_ATTEMPTS = getattr(settings, "OTP_MAX_ATTEMPTS", 5)
MAX_RESENDS = getattr(settings, "OTP_MAX_RESENDS", 3)
EMAIL = OneTimeToken.Channel.EMAIL


def _canonicalize(code: str) -> str:
    """Normalize a code the way allauth does (strip punctuation/whitespace,
    lowercase) so a user who drops dashes still matches the stored hash."""
    return code.translate(
        str.maketrans("", "", string.punctuation + string.whitespace)
    ).lower()


def _hash(salt: str, code: str) -> str:
    return hashlib.sha256(f"{salt}:{_canonicalize(code)}".encode("utf-8")).hexdigest()


def get_user_by_email(email: str) -> "User | None":
    """Resolve a user from allauth's EmailAddress (source of truth), falling
    back to the user's own email field. Case-insensitive.

    Ordered so the resolution is deterministic when several rows share an
    address (verified + primary wins, then the oldest row): without an
    explicit order, `.first()` could return a different account on each
    call, and a code issued to one account would never verify on another.
    """
    email = (email or "").lower()
    email_address = (
        EmailAddress.objects.filter(email__iexact=email)
        .select_related("user")
        .order_by("-verified", "-primary", "id")
        .first()
    )
    if email_address:
        return email_address.user
    return User.objects.filter(email__iexact=email).order_by("id").first()


def issue_code(*, user, purpose: str = OneTimeToken.Purpose.LOGIN) -> OneTimeToken:
    """Create a fresh login/signup code for `user` and email it.

    Any previously issued, unexpired tokens for the same channel are retired
    first, so there is at most one live code per user.
    """
    OneTimeToken.objects.filter(
        user=user, channel=EMAIL, consumed_at__isnull=True
    ).update(consumed_at=timezone.now())

    code = get_adapter().generate_login_code()
    salt = get_random_string(32)
    token = OneTimeToken.objects.create(
        user=user,
        channel=EMAIL,
        purpose=purpose,
        salt=salt,
        code_hash=_hash(salt, code),
        expires_at=timezone.now() + CODE_TTL,
    )
    _send_code_email(user, code)
    return token


def _send_code_email(user, code: str) -> None:
    email = user.email or EmailAddress.get_primary(user).email
    get_adapter().send_mail(
        "account/email/otp_code",
        email,
        {
            "code": code,
            "email": email,
            "minutes": int(CODE_TTL.total_seconds() // 60),
        },
    )


def verify_code(*, user, code: str) -> bool:
    """Check `code` against the user's most recent live token.

    Returns True exactly once (the token is consumed on success). Every
    call consumes an attempt; exceeding MAX_ATTEMPTS invalidates the token.
    """
    token = (
        OneTimeToken.objects.filter(
            user=user, channel=EMAIL, consumed_at__isnull=True
        )
        .order_by("-created_at")
        .first()
    )
    if token is None:
        return False

    now = timezone.now()
    if token.expires_at <= now:
        token.invalidate()
        return False

    token.attempts += 1
    if token.attempts > MAX_ATTEMPTS:
        token.invalidate()
        return False

    if secrets.compare_digest(_hash(token.salt, code), token.code_hash):
        token.consumed_at = now
        token.save(update_fields=["consumed_at", "attempts"])
        return True

    token.save(update_fields=["attempts"])
    return False


def can_resend(*, user) -> bool:
    """Resend quota: at most MAX_RESENDS codes within one TTL window."""
    recent = OneTimeToken.objects.filter(
        user=user, channel=EMAIL, created_at__gte=timezone.now() - CODE_TTL
    ).count()
    return recent < MAX_RESENDS


def mark_email_verified(user, email: str) -> None:
    """A confirmed code proves control of the address: mark it verified and
    primary (which also keeps user.email in sync).

    Defensive by design - this is a side effect of a successful login, never
    a reason for it to fail. allauth keeps a partial unique constraint on
    (user, email) among *verified* rows; if duplicate rows for the same
    address exist (e.g. leftovers of an older signup flow), we collapse them
    before flipping verified=True so the constraint cannot trip.
    """
    email = (email or "").lower()
    rows = list(
        EmailAddress.objects.filter(user=user, email__iexact=email)
        .order_by("-verified", "-primary", "id")
    )
    if not rows:
        return
    target = rows[0]
    for dup in rows[1:]:
        dup.delete()
    if not target.verified:
        target.verified = True
        target.save(update_fields=["verified"])
    target.set_as_primary(conditional=True)

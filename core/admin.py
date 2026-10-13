from django.contrib import admin

from core.models import OneTimeToken


@admin.register(OneTimeToken)
class OneTimeTokenAdmin(admin.ModelAdmin):
    """Read-only: staff can inspect codes' state but never create or edit
    them (that would be a privilege escalation vector)."""

    list_display = (
        "user",
        "channel",
        "purpose",
        "created_at",
        "expires_at",
        "consumed_at",
        "attempts",
    )
    list_filter = ("channel", "purpose")
    search_fields = ("user__email",)
    readonly_fields = (
        "id",
        "user",
        "channel",
        "purpose",
        "salt",
        "code_hash",
        "expires_at",
        "attempts",
        "consumed_at",
        "created_at",
    )
    actions = None

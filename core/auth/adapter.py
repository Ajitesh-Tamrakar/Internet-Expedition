"""Headless adapter: user payloads carry first/last name.

The stock ``DefaultHeadlessAdapter`` serializes users as
``{id, username, email, display, has_usable_password}`` — no names. The
registration flow collects first/last name (see ``core.auth.inputs``);
this adapter exposes them in the same user payloads the stock one
produces, via the documented ``get_user_dataclass`` /
``user_as_dataclass`` extension points (fields default to "" so the
stock constructor keeps working; ``serialize_user`` drops empty values).
"""
import dataclasses

from allauth.headless.adapter import DefaultHeadlessAdapter


def _name_field(attr: str):
    return (
        attr,
        str,
        dataclasses.field(
            default="",
            metadata={"description": f"The user's {attr.replace('_', ' ')}.", "example": "Jane"},
        ),
    )


class CoreHeadlessAdapter(DefaultHeadlessAdapter):
    def get_user_dataclass(self):
        Base = super().get_user_dataclass()
        return dataclasses.make_dataclass(
            "User",
            [_name_field("first_name"), _name_field("last_name")],
            bases=(Base,),
        )

    def user_as_dataclass(self, user):
        dc = super().user_as_dataclass(user)
        dc.first_name = getattr(user, "first_name", "") or ""
        dc.last_name = getattr(user, "last_name", "") or ""
        return dc

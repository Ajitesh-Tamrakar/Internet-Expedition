"""Signup input with first/last name.

allauth's headless ``SignupInput`` is built on ``BaseSignupForm`` and only
declares fields for the ``ACCOUNT_SIGNUP_FIELDS`` entries it explicitly
handles (email, email2, username, phone) plus ``password`` — the stock
form never creates ``first_name``/``last_name`` fields, even though the
account adapter's ``save_user()`` happily persists them when present in
``cleaned_data``. Declaring the two fields on a subclass is therefore the
smallest supported extension point: the rest of the signup flow
(validation, duplicate handling, password hashing, email setup) is
untouched stock allauth.
"""
from allauth.headless.account.inputs import SignupInput
from allauth.headless.internal.restkit import inputs


class CoreSignupInput(SignupInput):
    first_name = inputs.CharField(max_length=150)
    last_name = inputs.CharField(max_length=150)

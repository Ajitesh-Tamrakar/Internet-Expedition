from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()


class RequestCodeSerializer(serializers.Serializer):
    email = serializers.EmailField()


class ConfirmCodeSerializer(serializers.Serializer):
    email = serializers.EmailField()
    code = serializers.CharField(max_length=64)


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()


class UserSerializer(serializers.ModelSerializer):
    """Clean user payload for the JWT response and /user/ - it never
    exposes the (unusable) password hash."""

    email = serializers.EmailField()

    class Meta:
        model = User
        fields = ("id", "username", "email", "first_name", "last_name", "date_joined")

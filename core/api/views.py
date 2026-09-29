from rest_framework.permissions import IsAuthenticated
from yaml import serializer
from core.models import Capture
from core.api.serializers import CaptureSerializer
from rest_framework.viewsets import ModelViewSet

class CaptureViewSet(ModelViewSet):
    http_method_names = ['post']
    permission_classes = [IsAuthenticated]
    queryset = Capture.objects.all()
    serializer_class = CaptureSerializer
    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

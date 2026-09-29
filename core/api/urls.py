from django.urls import path
from rest_framework.routers import DefaultRouter
from core.api.views import CaptureViewSet

router = DefaultRouter()
router.register('captures', CaptureViewSet, basename='capture')

urlpatterns  = router.urls
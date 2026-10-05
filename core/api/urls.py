from rest_framework.routers import DefaultRouter
from core.api.views import CaptureViewSet, MultiModelContextExtraction

router = DefaultRouter()
router.register('captures', CaptureViewSet, basename='capture')
router.register('capture-context', MultiModelContextExtraction, basename='capture-context')

urlpatterns  = router.urls

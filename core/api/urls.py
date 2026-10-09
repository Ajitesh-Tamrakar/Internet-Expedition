from rest_framework.routers import DefaultRouter, SimpleRouter
from core.api.views import CaptureViewSet, MultiModelContextExtraction


class ContextRouter(DefaultRouter):
    """DefaultRouter that also maps POST on the base detail route.

    DRF's stock routers only accept GET/PUT/PATCH/DELETE on detail
    routes, but the API contract requires:

        POST /capture-context/<capture_id>/

    (for POST the URL slot carries the Capture id, while GET/PATCH/
    DELETE use it as the capture_context_id). The contract also allows
    the ?capture_id= query form for GET/PATCH/DELETE, which targets the
    *collection* route — but the stock list route only maps
    GET/POST. The router's routes are declared in `SimpleRouter.routes`,
    so we rebuild that list:

      * base detail route:  + "post" -> create
      * base list route:    + "patch" -> partial_update,
                                 + "delete" -> destroy

    (When those hit the collection route without a matching id in the
    URL/query, get_context() rejects them with 400.)
    """

    routes = [
        route._replace(mapping={**route.mapping, "post": "create"})
        if route.name == "{basename}-detail"
        else route._replace(
            mapping={
                **route.mapping,
                "patch": "partial_update",
                "delete": "destroy",
            }
        )
        if route.name == "{basename}-list"
        else route
        for route in SimpleRouter.routes
    ]


router = DefaultRouter()
router.register('captures', CaptureViewSet, basename='capture')

context_router = ContextRouter()
context_router.register('capture-context', MultiModelContextExtraction, basename='capture-context')

urlpatterns = router.urls + context_router.urls

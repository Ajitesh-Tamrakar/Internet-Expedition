from django.urls import path, include
from rest_framework_simplejwt.views import TokenRefreshView
urlpatterns = [
    path('', include('dj_rest_auth.urls')),
    path('registration/', include('dj_rest_auth.registration.urls')),
    # path('token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
]
# from gemini import GeminiProvider
# from core.models import Capture
#
#
# class MultiModelContextExtraction:
#
#     def __init__(self, id):
#         self.capture_id = id
#
#
#     def extractor(self):
#         provider = GeminiProvider()
#
#         capture_obj  = Capture.objects.get(capture_id= self.capture_id)
#
#         if capture_obj.text != None:
#             provider.summarize_text(capture_obj.text)
#         elif capture_obj.image_sources != None:
#             for img in capture_obj.image_sources:
#                 provider.describe_image(img)
#         elif capture_obj.screenshot != None:
#             provider.describe_image(capture_obj.screenshot)
#         elif capture_obj.video_sources != None:
#             for video in capture_obj.video_sources:
#                 provider.describe_video(video)
#
#
#
#         return None

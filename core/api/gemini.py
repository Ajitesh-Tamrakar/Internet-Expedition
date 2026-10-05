from django.conf import settings
from google import genai


class GeminiProvider:

    def __init__(self):
        self.client = genai.Client(
            api_key=settings.GEMINI_API_KEY
        )

    def summarize_text(self, text: str) -> str:
        response = self.client.models.generate_content(
            model="gemini-3.5-flash-lite",
            contents=text,
        )

        return response.text   #type: ignore

    def describe_image(self, image_path: str) -> str:
        uploaded_file = self.client.files.upload(
            file=image_path
        )

        response = self.client.models.generate_content(
            model="gemini-3.5-flash-lite",
            contents=[
                "Describe this image in detail.",
                uploaded_file,
            ],
        )

        return response.text  #type: ignore

    def describe_video(self, video_path: str) -> str:
        uploaded_file = self.client.files.upload(
            file=video_path
        )

        response = self.client.models.generate_content(
            model="gemini-3.5-flash-lite",
            contents=[
                "Describe this video in detail.",
                uploaded_file,
            ],
        )

        return response.text #type: ignore

    def generate_embedding(self, text: str) -> list[float]:
        response = self.client.models.embed_content(
            model="gemini-embedding-2",
            contents=text,
        )

        return response.embeddings[0].values  #type: ignore


    def transcribe_audio(self, audio_path: str) -> str:
        uploaded_file = self.client.files.upload(
            file=audio_path
        )

        response = self.client.models.generate_content(
            model="gemini-3.5-flash-lite",
            contents=[
                "Transcribe this audio.",
                uploaded_file,
            ],
        )

        return response.text  #type: ignore

import uuid

from django.core.management.base import BaseCommand

from core.embedding_builder import build_capture_embeddings
from core.models import Capture, CaptureContext


class Command(BaseCommand):
    help = "Build the CaptureEmbedding rows for a capture's context (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--capture",
            required=True,
            help="Capture id (UUID) whose context should be (re)embedded.",
        )

    def handle(self, *args, **options):
        try:
            capture_id = uuid.UUID(options["capture"])
        except ValueError:
            self.stderr.write(
                self.style.ERROR(f"Not a valid capture UUID: {options['capture']!r}")
            )
            return

        capture = Capture.objects.filter(capture_id=capture_id).first()
        if capture is None:
            self.stderr.write(self.style.ERROR(f"No capture with id {capture_id}."))
            return

        context = CaptureContext.objects.filter(capture_id=capture).first()
        if context is None:
            self.stderr.write(
                self.style.ERROR(
                    f"No CaptureContext for capture {capture_id} — "
                    "run context extraction first."
                )
            )
            return

        result = build_capture_embeddings(context)
        self.stdout.write(
            self.style.SUCCESS(
                f"Built {result['rows']} embedding row(s) across "
                f"{result['sources']} source(s) for capture {capture_id}."
            )
        )

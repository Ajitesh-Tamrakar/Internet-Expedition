"""
Run the background capture pipeline worker.

    python manage.py run_worker [-t N] [--run-once]

At startup it sweeps the database for captures a previous (dead) worker
may have abandoned - and for `queued` captures whose user now has a
free slot - re-queues them, then starts the django-q2 cluster, which
processes the queue until stopped.

Run this as its own long-lived process next to the web server (docker
compose: a second service with this command; a PaaS: a second "worker"
service). Scale by running more copies: the queue and the API pace slot
are shared via the database, so extra copies simply process captures in
parallel within the same global quota.
"""
from django.core.management import call_command
from django.core.management.base import BaseCommand

from core.pipeline import sweep_stuck_captures


class Command(BaseCommand):
    help = (
        "Run the background capture pipeline worker: sweep stuck "
        "captures, then run the django-q2 cluster."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "-t",
            "--tasks",
            type=int,
            default=None,
            help="Worker pool size (default: Q_CLUSTER 'workers').",
        )
        parser.add_argument(
            "--run-once",
            action="store_true",
            help="Process whatever is queued, then exit.",
        )

    def handle(self, *args, **options):
        requeued = sweep_stuck_captures()
        self.stdout.write(
            self.style.SUCCESS(
                f"startup sweep: re-queued {requeued} abandoned/queued "
                "capture(s)"
            )
        )

        if options["tasks"] is not None:
            from django_q import conf as qconf

            qconf.Conf.WORKERS = options["tasks"]

        call_command("qcluster", run_once=options["run_once"])

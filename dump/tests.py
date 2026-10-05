from datetime import timedelta

import psycopg2
from django.conf import settings
from django.test import TestCase
from django.utils.timezone import now

from core.db import (
    WORKER_ALIVE_THRESHOLD_SEC,
    WORKER_SINGLETON_LOCK_KEY,
    acquire_worker_singleton_lock,
    find_unembedded_complete_bookmark_ids,
    record_worker_idle,
    record_worker_working,
    repair_unembedded_complete_bookmarks,
    worker_status,
)
from core.models import Bookmark, Chunk, WorkerStatus


def _raw_connection():
    """A second, independent DB connection -- distinct from Django's default test
    connection -- so advisory-lock contention can actually be observed."""
    db = settings.DATABASES['default']
    return psycopg2.connect(
        dbname=db['NAME'], user=db['USER'], password=db['PASSWORD'],
        host=db['HOST'], port=db['PORT'],
    )


def _bookmark(**overrides):
    defaults = dict(
        url='https://example.com',
        platform=Bookmark.Platform.WEB,
        processing_status=Bookmark.Processing_Status.COMPLETE,
    )
    defaults.update(overrides)
    return Bookmark.objects.create(**defaults)


def _chunk(bookmark, embedding=None, **overrides):
    defaults = dict(
        bookmark=bookmark,
        text='some chunk text',
        chunk_type=Chunk.ChunkType.ARTICLE,
        word_count=3,
        embedding=embedding,
    )
    defaults.update(overrides)
    return Chunk.objects.create(**defaults)


class FindUnembeddedCompleteBookmarkIdsTests(TestCase):
    def test_finds_complete_bookmark_with_unembedded_chunk(self):
        bookmark = _bookmark()
        _chunk(bookmark, embedding=None)

        self.assertEqual(find_unembedded_complete_bookmark_ids(Bookmark), [bookmark.id])

    def test_ignores_complete_bookmark_with_all_chunks_embedded(self):
        bookmark = _bookmark()
        _chunk(bookmark, embedding=[0.1] * 8)

        self.assertEqual(find_unembedded_complete_bookmark_ids(Bookmark), [])

    def test_ignores_non_complete_bookmark_with_unembedded_chunk(self):
        bookmark = _bookmark(processing_status=Bookmark.Processing_Status.PENDING)
        _chunk(bookmark, embedding=None)

        self.assertEqual(find_unembedded_complete_bookmark_ids(Bookmark), [])

    def test_does_not_duplicate_id_for_multiple_unembedded_chunks(self):
        bookmark = _bookmark()
        _chunk(bookmark, embedding=None)
        _chunk(bookmark, embedding=None, chunk_index=1)

        self.assertEqual(find_unembedded_complete_bookmark_ids(Bookmark), [bookmark.id])


class RepairUnembeddedCompleteBookmarksTests(TestCase):
    def test_requeues_as_pending_and_resets_retry_state(self):
        bookmark = _bookmark(retry_count=2, failed_at=Bookmark.Stages.EMBEDDING)
        _chunk(bookmark, embedding=None)

        repaired = repair_unembedded_complete_bookmarks(Bookmark)

        bookmark.refresh_from_db()
        self.assertEqual(repaired, [bookmark.id])
        self.assertEqual(bookmark.processing_status, Bookmark.Processing_Status.PENDING)
        self.assertEqual(bookmark.retry_count, 0)
        self.assertIsNone(bookmark.failed_at)
        self.assertIsNone(bookmark.current_step)
        self.assertIsNone(bookmark.processed_at)

    def test_is_idempotent_when_nothing_matches(self):
        self.assertEqual(repair_unembedded_complete_bookmarks(Bookmark), [])

    def test_leaves_healthy_complete_bookmark_untouched(self):
        bookmark = _bookmark()
        _chunk(bookmark, embedding=[0.1] * 8)

        repaired = repair_unembedded_complete_bookmarks(Bookmark)

        bookmark.refresh_from_db()
        self.assertEqual(repaired, [])
        self.assertEqual(bookmark.processing_status, Bookmark.Processing_Status.COMPLETE)


class WorkerStatusTests(TestCase):
    def test_worker_status_with_no_row_yet_reports_not_alive_without_raising(self):
        status = worker_status()

        self.assertEqual(status, {
            'state': None, 'current_bookmark_id': None, 'updated_at': None, 'alive': False,
        })

    def test_record_worker_idle_reports_idle_and_alive(self):
        record_worker_idle()

        status = worker_status()
        self.assertEqual(status['state'], WorkerStatus.State.IDLE)
        self.assertIsNone(status['current_bookmark_id'])
        self.assertTrue(status['alive'])

    def test_record_worker_working_reports_working_bookmark(self):
        bookmark = _bookmark()

        record_worker_working(bookmark.id)

        status = worker_status()
        self.assertEqual(status['state'], WorkerStatus.State.WORKING)
        self.assertEqual(status['current_bookmark_id'], str(bookmark.id))
        self.assertTrue(status['alive'])

    def test_stale_status_reports_not_alive(self):
        record_worker_idle()
        stale_time = now() - timedelta(seconds=WORKER_ALIVE_THRESHOLD_SEC + 1)
        WorkerStatus.objects.filter(id=1).update(updated_at=stale_time)

        status = worker_status()
        self.assertFalse(status['alive'])


class WorkerSingletonLockTests(TestCase):
    """Advisory locks are session-scoped, not transactional -- Django's TestCase
    transaction rollback won't release one taken on the shared default connection,
    so explicitly release it here to avoid leaking into other tests."""

    def tearDown(self):
        from django.db import connection
        with connection.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s);", [WORKER_SINGLETON_LOCK_KEY])

    def test_acquires_on_first_call(self):
        self.assertTrue(acquire_worker_singleton_lock())

    def test_second_connection_is_blocked_while_first_holds_it(self):
        self.assertTrue(acquire_worker_singleton_lock())

        other = _raw_connection()
        try:
            with other.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(%s);", [WORKER_SINGLETON_LOCK_KEY])
                self.assertFalse(cur.fetchone()[0])
        finally:
            other.close()

    def test_second_connection_acquires_after_first_releases(self):
        self.assertTrue(acquire_worker_singleton_lock())

        from django.db import connection
        with connection.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s);", [WORKER_SINGLETON_LOCK_KEY])

        other = _raw_connection()
        try:
            with other.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(%s);", [WORKER_SINGLETON_LOCK_KEY])
                self.assertTrue(cur.fetchone()[0])
                cur.execute("SELECT pg_advisory_unlock(%s);", [WORKER_SINGLETON_LOCK_KEY])
        finally:
            other.close()

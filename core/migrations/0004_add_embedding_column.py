from django.db import migrations


def add_embedding_column(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='chunks' AND column_name='embedding'
        """)
        if cursor.fetchone():
            return
        cursor.execute("ALTER TABLE chunks ADD COLUMN embedding vector(768);")

def remove_embedding_column(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "ALTER TABLE chunks DROP COLUMN IF EXISTS embedding;"
        )

class Migration(migrations.Migration):
    dependencies = [
        ('core', '0003_config_rename_bookmarktags_bookmarktag_and_more'),
    ]

    operations = [
        # The `vector` type must exist before any vector column can be
        # added. Docker installs get it from the entrypoint script, but
        # fresh databases (and the test database) need it here. No-op on
        # databases where it already exists.
        migrations.RunSQL(
            "CREATE EXTENSION IF NOT EXISTS vector;",
            reverse_sql="DROP EXTENSION IF EXISTS vector;",
        ),
        migrations.RunPython(
            add_embedding_column,
            reverse_code=remove_embedding_column
        ),
    ]
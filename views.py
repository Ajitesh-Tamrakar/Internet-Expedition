from django.shortcuts import render
from .models import Config, Bookmark, BookmarkTag, Tag, Chunk
from django.http import JsonResponse
from core.registry import EMBEDDING_REGISTRY, GENERATION_REGISTRY
from django.views.decorators.csrf import csrf_exempt
from core import pull_manager
from core import secrets as api_key_store
from core.db import ensure_embedding_index, worker_status
import json
import os
import re
from pathlib import Path


#Setup status — used by frontend root redirect; exempt from SetupRequiredMiddleware via /setup/ prefix
@csrf_exempt
def setup_status(request):
    if request.method != 'GET':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    try:
        config = Config.get()
        return JsonResponse({'setup_complete': config.setup_complete, 'dev_mode': config.dev_mode})
    except Config.DoesNotExist:
        return JsonResponse({'setup_complete': False, 'dev_mode': False})


@csrf_exempt
def setup_embedding(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Invalid request method'}, status=400)

    import json
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        body = request.POST

    embedding_provider = body.get('embedding_provider')
    embedding_model = body.get('embedding_model')
    generation_provider = body.get('generation_provider')
    generation_model = body.get('generation_model')
    whisper_model = body.get('whisper_model')
    dev_mode = body.get('dev_mode', False)
    keys = body.get('keys') or {}

    if not embedding_provider or not embedding_model:
        return JsonResponse({'error': 'embedding_provider and embedding_model are required'}, status=400)
    if not generation_provider or not generation_model:
        return JsonResponse({'error': 'generation_provider and generation_model are required'}, status=400)
    if not whisper_model:
        return JsonResponse({'error': 'whisper_model is required'}, status=400)

    if embedding_provider not in EMBEDDING_REGISTRY:
        return JsonResponse({'error': 'Invalid embedding provider'}, status=400)
    if embedding_model not in EMBEDDING_REGISTRY[embedding_provider]:
        return JsonResponse({'error': 'Invalid embedding model'}, status=400)
    if generation_provider not in GENERATION_REGISTRY:
        return JsonResponse({'error': 'Invalid generation provider'}, status=400)
    if generation_model not in GENERATION_REGISTRY[generation_provider]:
        return JsonResponse({'error': 'Invalid generation model'}, status=400)

    embedding_dimension = EMBEDDING_REGISTRY[embedding_provider][embedding_model]

    existing = Config.objects.filter(id=1).first()
    embedding_locked = bool(existing and existing.embedding_locked)
    if embedding_locked and (
        existing.embedding_provider != embedding_provider
        or existing.embedding_model_name != embedding_model
    ):
        return JsonResponse({
            'error': (
                'Embedding model is locked after first use and cannot be changed here. '
                "Run 'python manage.py reembed --provider <provider> --model <model>' to "
                'switch and re-embed everything.'
            ),
        }, status=409)

    try:
        for provider, value in keys.items():
            if value:
                api_key_store.set_api_key(provider, value)
    except Exception as e:
        return JsonResponse({'error': f'Failed to store API key: {e}'}, status=500)

    if not embedding_locked:
        try:
            ensure_embedding_index(embedding_dimension)
        except Exception as e:
            return JsonResponse({'error': f'Failed to size embedding column: {e}'}, status=500)

    Config.objects.update_or_create(
        id=1,
        defaults=dict(
            embedding_provider=embedding_provider,
            embedding_model_name=embedding_model,
            embedding_dimensions=embedding_dimension,
            generation_provider=generation_provider,
            generation_model_name=generation_model,
            whisper_model_name=whisper_model,
            dev_mode=bool(dev_mode),
            setup_complete=True,
        ),
    )

    return JsonResponse({
        'status': 'Setup complete',
        'embedding_provider': embedding_provider,
        'embedding_model': embedding_model,
        'embedding_dimension': embedding_dimension,
        'generation_provider': generation_provider,
        'generation_model': generation_model,
        'whisper_model': whisper_model,
        'dev_mode': bool(dev_mode),
    })


@csrf_exempt
def models_registry(request):
    if request.method != 'GET':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    return JsonResponse({
        'embedding': EMBEDDING_REGISTRY,
        'generation': GENERATION_REGISTRY,
    })


@csrf_exempt
def pull_models(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    import json
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    models = body.get('models', [])
    whisper = body.get('whisper')

    if not models and not whisper:
        return JsonResponse({'error': 'models or whisper is required'}, status=400)

    try:
        for model in models:
            pull_manager.pull_model(model)
        if whisper:
            pull_manager.pull_whisper(whisper)
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

    return JsonResponse({'status': 'pulling', 'models': models, 'whisper': whisper})


@csrf_exempt
def pull_status(request):
    if request.method != 'GET':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    try:
        return JsonResponse(pull_manager.get_status())
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


#Dev check
def dev_wipe(request):
    config = Config.get()
    if not config.dev_mode:
        return JsonResponse({'error': 'dev mode is not enabled'}, status = 403)
    
    #Wipe data

    BookmarkTag.objects.all().delete()
    Chunk.objects.all().delete()
    Tag.objects.all().delete()
    Bookmark.objects.all().delete()

    #Reset config

    Config.objects.filter(id=1).update(
        embedding_locked =False,
        setup_complete = False,
        embedding_provider = None,
        embedding_model_name = None, 
        embedding_dimensions = None, 
       generation_provider = None, 
       generation_model_name = None,
    )

    return JsonResponse({'status': 'Wiped'})

@csrf_exempt
def set_dev_mode(request):
    enabled = request.POST.get('enabled') == 'true'
    Config.objects.filter(id=1).update(dev_mode=enabled)
    return JsonResponse({'dev_mode': enabled})


TEMP_DIR = Path(__file__).resolve().parent.parent / "tmp" / "captures"
_TEMP_FILE_RE = re.compile(r'^(.+)_([^_]+)\.(\w+)$')


@csrf_exempt
def pipeline_status(request):
    if request.method != 'GET':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    try:
        config = Config.get()
        if not config.dev_mode:
            return JsonResponse({'error': 'dev mode not enabled'}, status=403)
    except Config.DoesNotExist:
        return JsonResponse({'error': 'config not found'}, status=404)

    def serialize(qs, fields):
        rows = []
        for b in qs:
            row = {}
            for f in fields:
                val = getattr(b, f)
                if hasattr(val, 'isoformat'):
                    val = val.isoformat()
                elif val is not None:
                    val = str(val) if not isinstance(val, (int, float, bool)) else val
                row[f] = val
            rows.append(row)
        return rows

    processing = serialize(
        Bookmark.objects.filter(processing_status='processing').order_by('processing_started_at'),
        ['id', 'title', 'url', 'platform', 'retry_count', 'current_step', 'processing_started_at'],
    )
    pending = serialize(
        Bookmark.objects.filter(processing_status='pending').order_by('saved_at'),
        ['id', 'title', 'url', 'capture_method', 'saved_at'],
    )
    failed = serialize(
        Bookmark.objects.filter(processing_status='failed').order_by('-saved_at'),
        ['id', 'title', 'url', 'failed_at', 'processing_error', 'retry_count'],
    )
    complete_count = Bookmark.objects.filter(processing_status='complete').count()

    # scan tmp/captures/ for orphaned files
    temp_files = []
    if TEMP_DIR.exists():
        for fname in sorted(TEMP_DIR.iterdir()):
            if not fname.is_file():
                continue
            m = _TEMP_FILE_RE.match(fname.name)
            if not m:
                continue
            bid, ftype, ext = m.group(1), m.group(2), m.group(3)
            size_bytes = fname.stat().st_size
            if size_bytes >= 1_048_576:
                size_str = f'{size_bytes / 1_048_576:.0f} MB'
            else:
                size_str = f'{size_bytes / 1024:.0f} KB'
            temp_files.append({'bid': bid, 'type': ftype, 'ext': ext, 'size': size_str})

    return JsonResponse({
        'processing': processing,
        'pending': pending,
        'failed': failed,
        'complete_count': complete_count,
        'temp_files': temp_files,
        'worker': worker_status(),
    })


@csrf_exempt
def pipeline_retry(request, bookmark_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    try:
        config = Config.get()
        if not config.dev_mode:
            return JsonResponse({'error': 'dev mode not enabled'}, status=403)
    except Config.DoesNotExist:
        return JsonResponse({'error': 'config not found'}, status=404)

    updated = Bookmark.objects.filter(id=bookmark_id, processing_status='failed').update(
        processing_status='pending',
        retry_count=0,
        failed_at=None,
        processing_error=None,
    )
    if not updated:
        return JsonResponse({'error': 'bookmark not found or not in failed state'}, status=404)

    return JsonResponse({'status': 'queued'})


def health(request):
    return JsonResponse({"status": "ok"})
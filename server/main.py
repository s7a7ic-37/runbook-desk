import hashlib
import json
import os
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from psycopg.types.json import Jsonb

from . import db, llm
from .models import CaseInput, Draft, ReviewInput

HERE = Path(__file__).parent
RUNBOOKS = json.loads((HERE / 'runbooks.json').read_text())
EXAMPLES = json.loads((HERE / 'examples.json').read_text())
BOOK_IDS = {r['id'] for r in RUNBOOKS}
COOKIE = 'runbook_workspace'


@dataclass(frozen=True)
class Settings:
    database_url: str
    api_key: str = ''
    model: str = ''
    call_limit: int = 0
    origin: str = 'http://localhost:5173'
    secure_cookie: bool = True

    def __post_init__(self):
        if not self.database_url or not 0 <= self.call_limit <= 20:
            raise ValueError('Set DATABASE_URL and a MODEL_CALL_LIMIT from 0 to 20.')

    @classmethod
    def load(cls):
        return cls(os.getenv('DATABASE_URL', ''), os.getenv('OPENAI_API_KEY', ''),
                   os.getenv('OPENAI_MODEL', ''), int(os.getenv('MODEL_CALL_LIMIT', '0')),
                   os.getenv('APP_ORIGIN', 'http://localhost:5173'),
                   os.getenv('COOKIE_SECURE', 'true').lower() == 'true')

    @property
    def live_enabled(self):
        return bool(self.api_key and self.model and self.call_limit)


def problem(status, code, message):
    raise HTTPException(status, detail={'code': code, 'message': message})


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] not in ('POST', 'PUT', 'PATCH'):
            return await self.app(scope, receive, send)
        chunks = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            chunks.extend(message.get('body', b''))
            if len(chunks) > 16384:
                response = JSONResponse({'error': {'code': 'body_too_large', 'message': 'Keep this request under 16 KB.'}}, status_code=413)
                return await response(scope, receive, send)
            if not message.get('more_body'):
                break

        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': bytes(chunks), 'more_body': False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings=None):
    settings = settings or Settings.load()

    @asynccontextmanager
    async def lifespan(app):
        db.initialize(settings.database_url)
        yield

    app = FastAPI(title='Runbook Desk API', version='1.0.0', lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url='/api/openapi.json')
    app.state.model_transport = None
    app.add_middleware(BodyLimit)

    @app.middleware('http')
    async def response_headers(request, call_next):
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and request.headers.get('origin') not in (None, settings.origin):
            return JSONResponse({'error': {'code': 'wrong_origin', 'message': 'Open the app from its normal address.'}}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        detail = error.detail if isinstance(error.detail, dict) else {'code': 'request_error', 'message': str(error.detail)}
        return JSONResponse({'error': detail}, status_code=error.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({'error': {'code': 'invalid_input', 'message': 'Check the case title, details and selected runbooks.'}}, status_code=422)

    @app.exception_handler(psycopg.Error)
    async def database_error(request, error):
        return JSONResponse({'error': {'code': 'database_unavailable', 'message': 'The case store is unavailable. Please try again.'}}, status_code=503)

    def workspace(request: Request):
        token = request.cookies.get(COOKIE, '')
        if len(token) != 64:
            problem(401, 'workspace_required', 'Start a workspace before saving a case.')
        with db.connection(settings.database_url) as conn:
            row = conn.execute('SELECT id FROM runbook_desk.workspaces WHERE token_hash = %s AND expires_at > now()',
                               (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if not row:
            problem(401, 'workspace_expired', 'Your browser workspace expired. Start a new one.')
        return row['id']

    def case_row(conn, case_id, workspace_id, lock=False):
        query = 'SELECT * FROM runbook_desk.cases WHERE id = %s AND workspace_id = %s'
        row = conn.execute(query + (' FOR UPDATE' if lock else ''), (case_id, workspace_id)).fetchone()
        if not row:
            problem(404, 'case_not_found', 'This case is not in your browser workspace.')
        return row

    def full_case(conn, case_id, workspace_id):
        row = case_row(conn, case_id, workspace_id)
        for field in ('workspace_id', 'active_run_id', 'creation_key', 'creation_hash'):
            row.pop(field)
        row['reviews'] = conn.execute('SELECT decision, original_reply, reviewed_reply, note, created_at FROM runbook_desk.reviews WHERE case_id = %s ORDER BY id', (case_id,)).fetchall()
        row['runs'] = conn.execute('SELECT state, model, input_tokens, output_tokens, latency_ms, error_code, created_at FROM runbook_desk.runs WHERE case_id = %s ORDER BY created_at DESC LIMIT 5', (case_id,)).fetchall()
        return row

    def insert_case(conn, workspace_id, data, mode='live', draft=None, creation_key=None, example_id=None):
        conn.execute('SELECT pg_advisory_xact_lock(720051)')
        creation_hash = None
        if creation_key is not None:
            request_input = example_id if mode == 'example' else data.model_dump()
            creation_hash = hashlib.sha256(json.dumps(
                [mode, request_input], sort_keys=True).encode()).hexdigest()
            existing = conn.execute('''SELECT id, creation_hash FROM runbook_desk.cases
                WHERE workspace_id=%s AND creation_key=%s''', (workspace_id, creation_key)).fetchone()
            if existing:
                if existing['creation_hash'] != creation_hash:
                    problem(409, 'creation_conflict', 'This save key was already used for different case details. Start a new case.')
                return full_case(conn, existing['id'], workspace_id)
        count = conn.execute('SELECT count(*) AS n FROM runbook_desk.cases WHERE workspace_id = %s', (workspace_id,)).fetchone()['n']
        total = conn.execute('SELECT count(*) AS n FROM runbook_desk.cases').fetchone()['n']
        if count >= 20 or total >= 1000:
            problem(429, 'case_limit', 'This demo workspace has reached its case limit.')
        case_id = uuid4()
        conn.execute('''INSERT INTO runbook_desk.cases
            (id, workspace_id, title, description, runbook_ids, mode, state, draft, reply, creation_key, creation_hash)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (case_id, workspace_id, data.title, data.description, Jsonb(data.runbook_ids), mode,
             'draft' if draft else 'new', Jsonb(draft) if draft else None,
             draft['customer_reply'] if draft else '', creation_key, creation_hash))
        return full_case(conn, case_id, workspace_id)

    @app.get('/api/health')
    def health():
        with db.connection(settings.database_url) as conn:
            conn.execute('SELECT 1')
        return {'status': 'ok'}

    @app.get('/api/config')
    def configuration():
        with db.connection(settings.database_url) as conn:
            calls = conn.execute('SELECT count(*) AS n FROM runbook_desk.runs').fetchone()['n']
        return {'live_enabled': settings.live_enabled and calls < settings.call_limit,
                'case_deletion_enabled': True,
                'calls_remaining': max(0, settings.call_limit - calls),
                'runbooks': RUNBOOKS,
                'examples': [{k: e[k] for k in ('id', 'title', 'description', 'runbook_ids')} for e in EXAMPLES]}

    @app.post('/api/workspace')
    def start_workspace(request: Request, response: Response):
        try:
            workspace(request)
            return {'ready': True}
        except HTTPException as error:
            if error.status_code != 401:
                raise
        token = secrets.token_hex(32)
        with db.connection(settings.database_url) as conn:
            conn.execute('SELECT pg_advisory_xact_lock(720051)')
            # Demo workspaces expire with their cookie; clear their data on the next workspace creation.
            conn.execute('''DELETE FROM runbook_desk.reviews WHERE case_id IN
                (SELECT id FROM runbook_desk.cases WHERE workspace_id IN
                (SELECT id FROM runbook_desk.workspaces WHERE expires_at <= now()))''')
            conn.execute('''DELETE FROM runbook_desk.cases WHERE workspace_id IN
                (SELECT id FROM runbook_desk.workspaces WHERE expires_at <= now())''')
            conn.execute('DELETE FROM runbook_desk.workspaces WHERE expires_at <= now()')
            count = conn.execute('SELECT count(*) AS n FROM runbook_desk.workspaces').fetchone()['n']
            if count >= 2000:
                problem(429, 'workspace_limit', 'This demo is full. Please try again later.')
            conn.execute('INSERT INTO runbook_desk.workspaces(id, token_hash) VALUES (%s,%s)',
                         (uuid4(), hashlib.sha256(token.encode()).hexdigest()))
        response.set_cookie(COOKIE, token, httponly=True, secure=settings.secure_cookie,
                            samesite='lax', max_age=7 * 86400, path='/api')
        return {'ready': True}

    @app.get('/api/cases')
    def list_cases(workspace_id=Depends(workspace)):
        with db.connection(settings.database_url) as conn:
            return conn.execute('SELECT id, title, state, mode, updated_at FROM runbook_desk.cases WHERE workspace_id = %s ORDER BY created_at DESC LIMIT 20', (workspace_id,)).fetchall()

    @app.post('/api/cases', status_code=201)
    def new_case(data: CaseInput, workspace_id=Depends(workspace),
                 creation_key: UUID | None = Header(default=None, alias='Idempotency-Key')):
        if len(set(data.runbook_ids)) != len(data.runbook_ids) or not set(data.runbook_ids) <= BOOK_IDS:
            problem(422, 'invalid_runbooks', 'Choose one to three different runbooks from the library.')
        with db.connection(settings.database_url) as conn:
            return insert_case(conn, workspace_id, data, creation_key=creation_key)

    @app.post('/api/examples/{example_id}', status_code=201)
    def load_example(example_id: str, workspace_id=Depends(workspace),
                     creation_key: UUID | None = Header(default=None, alias='Idempotency-Key')):
        example = next((e for e in EXAMPLES if e['id'] == example_id), None)
        if not example:
            problem(404, 'example_not_found', 'Choose one of the worked examples.')
        data = CaseInput.model_validate({key: example[key] for key in ('title', 'description', 'runbook_ids')})
        draft = Draft.model_validate(example['draft'], context={'source_ids': data.runbook_ids}).model_dump()
        with db.connection(settings.database_url) as conn:
            return insert_case(conn, workspace_id, data, 'example', draft, creation_key, example_id)

    @app.get('/api/cases/{case_id}')
    def read_case(case_id: UUID, workspace_id=Depends(workspace)):
        with db.connection(settings.database_url) as conn:
            return full_case(conn, case_id, workspace_id)

    @app.delete('/api/cases/{case_id}')
    def delete_case(case_id: UUID, workspace_id=Depends(workspace)):
        with db.connection(settings.database_url) as conn:
            case = conn.execute('SELECT state FROM runbook_desk.cases WHERE id=%s AND workspace_id=%s FOR UPDATE',
                                (case_id, workspace_id)).fetchone()
            if not case:
                problem(404, 'case_not_found', 'That saved case was not found.')
            if case['state'] == 'generating':
                problem(409, 'case_in_progress', 'Wait until draft generation finishes, then delete this case.')
            conn.execute('DELETE FROM runbook_desk.reviews WHERE case_id=%s', (case_id,))
            conn.execute('DELETE FROM runbook_desk.cases WHERE id=%s AND workspace_id=%s',
                         (case_id, workspace_id))
        return {'deleted': True}

    @app.post('/api/cases/{case_id}/generate')
    def generate_case(case_id: UUID, workspace_id=Depends(workspace)):
        # Check the zero-budget switch before reserving a run or contacting the provider.
        if not settings.live_enabled:
            problem(503, 'live_paused', 'Live generation is paused. The worked examples remain available.')
        with db.connection(settings.database_url) as conn:
            conn.execute('SELECT pg_advisory_xact_lock(720051)')
            case = case_row(conn, case_id, workspace_id, lock=True)
            if case['mode'] == 'example':
                problem(409, 'example_case', 'Start a new case to request a live draft.')
            if case['state'] in ('approved', 'rejected'):
                problem(409, 'already_reviewed', 'This case has already been reviewed.')
            if case['state'] == 'draft':
                return full_case(conn, case_id, workspace_id)
            if case['state'] == 'generating':
                if case['updated_at'] > datetime.now(timezone.utc) - timedelta(minutes=2):
                    problem(409, 'already_generating', 'A draft is already being prepared for this case.')
                conn.execute("UPDATE runbook_desk.runs SET state='failed', error_code='interrupted', completed_at=now() WHERE id=%s AND state='pending'", (case['active_run_id'],))
            total = conn.execute('SELECT count(*) AS n FROM runbook_desk.runs').fetchone()['n']
            recent = conn.execute("SELECT count(*) AS n FROM runbook_desk.runs WHERE workspace_id=%s AND created_at > now()-interval '1 hour'", (workspace_id,)).fetchone()['n']
            if total >= settings.call_limit or recent >= 3:
                problem(429, 'generation_limit', 'The live demo has reached its request limit. No model call was made.')
            run_id = uuid4()
            conn.execute("INSERT INTO runbook_desk.runs(id,case_id,workspace_id,state,model) VALUES (%s,%s,%s,'pending',%s)", (run_id, case_id, workspace_id, settings.model))
            conn.execute("UPDATE runbook_desk.cases SET state='generating', active_run_id=%s, error_code=NULL, updated_at=now() WHERE id=%s", (run_id, case_id))
        selected = [r for r in RUNBOOKS if r['id'] in case['runbook_ids']]
        try:
            draft, usage = llm.generate({'title': case['title'], 'description': case['description']}, selected,
                                       settings.api_key, settings.model, app.state.model_transport)
        except llm.ProviderError as error:
            with db.connection(settings.database_url) as conn:
                conn.execute("UPDATE runbook_desk.runs SET state='failed',error_code=%s,completed_at=now() WHERE id=%s", (error.code, run_id))
                conn.execute("UPDATE runbook_desk.cases SET state='failed',error_code=%s,updated_at=now() WHERE id=%s AND active_run_id=%s", (error.code, case_id, run_id))
            problem(504 if error.code == 'provider_timeout' else 502, error.code,
                    'The model could not produce a usable draft. Your case is saved; you can retry or investigate manually.')
        with db.connection(settings.database_url) as conn:
            row = conn.execute("UPDATE runbook_desk.cases SET state='draft', draft=%s, reply=%s, version=version+1,updated_at=now() WHERE id=%s AND active_run_id=%s AND state='generating' RETURNING id", (Jsonb(draft), draft['customer_reply'], case_id, run_id)).fetchone()
            if not row:
                problem(409, 'stale_run', 'A newer attempt replaced this draft. Refresh the case.')
            conn.execute("UPDATE runbook_desk.runs SET state='succeeded',provider_request_id=%s,input_tokens=%s,output_tokens=%s,latency_ms=%s,completed_at=now() WHERE id=%s", (usage['provider_request_id'], usage['input_tokens'], usage['output_tokens'], usage['latency_ms'], run_id))
            return full_case(conn, case_id, workspace_id)

    @app.post('/api/cases/{case_id}/review')
    def review_case(case_id: UUID, data: ReviewInput, workspace_id=Depends(workspace)):
        with db.connection(settings.database_url) as conn:
            case = case_row(conn, case_id, workspace_id, lock=True)
            if case['state'] != 'draft' or case['version'] != data.version:
                problem(409, 'review_conflict', 'This draft has changed or was already reviewed. Refresh before deciding.')
            conn.execute('INSERT INTO runbook_desk.reviews(case_id,decision,original_reply,reviewed_reply,note) VALUES (%s,%s,%s,%s,%s)',
                         (case_id, data.decision, case['draft']['customer_reply'], data.reply, data.note))
            conn.execute('UPDATE runbook_desk.cases SET state=%s,reply=%s,version=version+1,updated_at=now() WHERE id=%s', (data.decision, data.reply, case_id))
            return full_case(conn, case_id, workspace_id)

    @app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    def unknown_api(path: str):
        problem(404, 'route_not_found', 'That API route does not exist.')

    web = HERE.parent / 'frontend' / 'dist'
    if web.is_dir():
        app.mount('/', StaticFiles(directory=web, html=True), name='frontend')
    return app


app = create_app()

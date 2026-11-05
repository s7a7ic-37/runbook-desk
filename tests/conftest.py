import os
from urllib.parse import urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

URL = os.environ.get('TEST_DATABASE_URL', 'postgresql://runbook@127.0.0.1:25433/runbook_desk_test')
parsed = urlparse(URL)
if parsed.hostname not in ('localhost', '127.0.0.1') or not parsed.path.endswith('_test'):
    raise RuntimeError('Tests require a loopback database whose name ends in _test.')
os.environ['DATABASE_URL'] = URL

from server import db
from server.main import Settings, create_app


@pytest.fixture(autouse=True)
def clean_database():
    db.initialize(URL)
    with db.connection(URL) as conn:
        conn.execute('TRUNCATE runbook_desk.reviews, runbook_desk.runs, runbook_desk.cases, runbook_desk.workspaces RESTART IDENTITY')


@pytest.fixture
def clients():
    opened = []

    def make(limit=0, handler=None):
        app = create_app(Settings(URL, api_key='test-placeholder', model='test-model', call_limit=limit, secure_cookie=False))

        def forbidden(request):
            raise AssertionError('A test attempted an unmocked provider call')

        app.state.model_transport = httpx.MockTransport(handler or forbidden)
        client = TestClient(app)
        client.__enter__()
        opened.append(client)
        assert client.post('/api/workspace').status_code == 200
        return client

    yield make
    for client in reversed(opened):
        client.__exit__(None, None, None)

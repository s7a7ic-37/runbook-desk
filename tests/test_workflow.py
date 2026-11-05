import copy
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import httpx
import pytest
from pydantic import ValidationError

from server import db, llm
from server.main import EXAMPLES, Settings, create_app
from fastapi.testclient import TestClient
from server.models import Draft
from conftest import URL

CASE = {key: EXAMPLES[0][key] for key in ('title', 'description', 'runbook_ids')}
DRAFT = EXAMPLES[0]['draft']


def completed(draft=None):
    return httpx.Response(200, json={'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': json.dumps(draft or DRAFT)}]}],
        'usage': {'input_tokens': 120, 'output_tokens': 250}}, headers={'x-request-id': 'synthetic-request'})


def new_case(client):
    response = client.post('/api/cases', json=CASE)
    assert response.status_code == 201, response.text
    return response.json()


def test_zero_budget_never_reserves_or_calls_provider(clients):
    client = clients()
    case = new_case(client)
    assert client.post(f"/api/cases/{case['id']}/generate").status_code == 503
    assert client.get('/api/config').json()['live_enabled'] is False
    with db.connection(URL) as conn:
        assert conn.execute('SELECT count(*) AS n FROM runbook_desk.runs').fetchone()['n'] == 0


def test_example_edits_review_history_and_conflict(clients):
    client = clients()
    case = client.post('/api/examples/webhook-retries').json()
    assert case['mode'] == 'example'
    edited = 'We are reviewing the delivery timeline and will confirm the next checks with you.'
    review = {'version': case['version'], 'decision': 'approved', 'reply': edited, 'note': 'Checked the selected sources.'}
    result = client.post(f"/api/cases/{case['id']}/review", json=review)
    assert result.status_code == 200
    saved = client.get(f"/api/cases/{case['id']}").json()
    assert saved['reply'] == edited
    assert saved['reviews'][0]['original_reply'] == DRAFT['customer_reply']
    assert saved['reviews'][0]['reviewed_reply'] == edited
    assert client.post(f"/api/cases/{case['id']}/review", json=review).status_code == 409
    assert len(client.get('/api/cases').json()) == 1


def test_workspace_isolation_and_expiry(clients):
    owner, stranger = clients(1), clients(1)
    case = new_case(owner)
    for suffix in ('', '/generate', '/review'):
        url = f"/api/cases/{case['id']}" + suffix
        result = stranger.get(url) if not suffix else stranger.post(url, json={
            'version': 0, 'decision': 'approved', 'reply': DRAFT['customer_reply'], 'note': 'Checked.'})
        assert result.status_code == 404
    assert stranger.get('/api/cases').json() == []
    with db.connection(URL) as conn:
        conn.execute("UPDATE runbook_desk.workspaces SET expires_at=now()-interval '1 minute'")
    assert owner.get('/api/cases').status_code == 401
    assert owner.post('/api/workspace').status_code == 200
    assert owner.get('/api/cases').json() == []


def test_input_origin_cookie_and_public_config(clients):
    client = clients()
    cookie = next(c for c in client.cookies.jar if c.name == 'runbook_workspace')
    assert cookie.has_nonstandard_attr('HttpOnly')
    assert cookie.get_nonstandard_attr('SameSite') == 'lax'
    result = client.post('/api/cases', json={'password': 'must-not-be-echoed'})
    assert result.status_code == 422 and 'must-not-be-echoed' not in result.text
    assert client.post('/api/workspace', headers={'Origin': 'https://untrusted.invalid'}).status_code == 403
    assert client.post('/api/cases', content='x' * 17000).status_code == 413
    for ids in (['missing'], ['rb-scope', 'rb-scope']):
        assert client.post('/api/cases', json={**CASE, 'runbook_ids': ids}).status_code == 422
    quoted = client.post('/api/cases', json={**CASE, 'title': "Case '); DROP TABLE cases; --"})
    assert quoted.status_code == 201
    config = client.get('/api/config')
    assert 'test-placeholder' not in config.text and 'postgresql' not in config.text
    assert config.headers['cache-control'] == 'no-store'
    assert client.get('/api/health').json() == {'status': 'ok'}


def test_real_request_shape_and_idempotency(clients):
    requests = []

    def handler(request):
        requests.append(request)
        body = json.loads(request.content)
        assert str(request.url) == 'https://api.openai.com/v1/responses'
        assert body['store'] is False
        assert body['text']['format']['strict'] is True
        assert body['text']['format']['schema']['additionalProperties'] is False
        assert json.loads(body['input'])['incident']['title'] == CASE['title']
        return completed()

    client = clients(2, handler)
    case = new_case(client)
    route = f"/api/cases/{case['id']}/generate"
    result = client.post(route)
    assert result.status_code == 200, result.text
    assert result.json()['runs'][0]['input_tokens'] == 120
    assert client.post(route).json()['draft'] == DRAFT
    assert len(requests) == 1


@pytest.mark.parametrize('kind,code', [
    ('busy', 'provider_busy'), ('error', 'provider_error'), ('timeout', 'provider_timeout'),
    ('refusal', 'provider_refusal'), ('incomplete', 'incomplete_response'),
    ('invalid', 'invalid_draft'), ('citations', 'invalid_draft'), ('usage', 'invalid_draft')])
def test_provider_failures_are_saved_and_sanitized(clients, kind, code):
    def handler(request):
        if kind == 'busy': return httpx.Response(429, text='private-provider-detail')
        if kind == 'error': return httpx.Response(503, text='private-provider-detail')
        if kind == 'timeout': raise httpx.ReadTimeout('private-provider-detail')
        if kind == 'refusal': return httpx.Response(200, json={'status': 'completed', 'output': [
            {'type': 'message', 'content': [{'type': 'refusal'}]}]})
        if kind == 'incomplete': return httpx.Response(200, json={'status': 'incomplete'})
        if kind == 'invalid': return httpx.Response(200, json=[])
        if kind == 'usage':
            body = completed().json()
            body['usage']['input_tokens'] = 'bad'
            return httpx.Response(200, json=body)
        draft = copy.deepcopy(DRAFT)
        draft['checks'][0]['source_ids'] = ['invented']
        return completed(draft)

    client = clients(1, handler)
    case = new_case(client)
    result = client.post(f"/api/cases/{case['id']}/generate")
    assert result.status_code in (502, 504)
    assert result.json()['error']['code'] == code
    assert 'private-provider-detail' not in result.text
    stored = client.get(f"/api/cases/{case['id']}").json()
    assert stored['state'] == stored['runs'][0]['state'] == 'failed'
    assert client.post(f"/api/cases/{case['id']}/generate").status_code == 429


def test_citations_must_include_selected_runbook():
    draft = copy.deepcopy(DRAFT)
    draft['checks'][0]['source_ids'] = ['incident']
    with pytest.raises(ValidationError):
        Draft.model_validate(draft, context={'source_ids': CASE['runbook_ids']})
    for example in EXAMPLES:
        Draft.model_validate(example['draft'], context={'source_ids': example['runbook_ids']})


def test_concurrent_calls_reserve_budget_before_provider(clients):
    started, release = Event(), Event()
    calls = []

    def handler(request):
        calls.append(request)
        started.set()
        assert release.wait(10)
        return completed()

    first, second = clients(1, handler), clients(1, handler)
    case1, case2 = new_case(first), new_case(second)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(first.post, f"/api/cases/{case1['id']}/generate")
        try:
            assert started.wait(10)
            assert second.post(f"/api/cases/{case2['id']}/generate").status_code == 429
            assert first.post(f"/api/cases/{case1['id']}/generate").status_code == 409
        finally:
            release.set()
        assert future.result().status_code == 200
    assert len(calls) == 1


def test_retry_is_explicit_and_review_version_is_checked(clients):
    replies = iter([httpx.Response(503), completed()])
    client = clients(2, lambda request: next(replies))
    case = new_case(client)
    route = f"/api/cases/{case['id']}"
    assert client.post(route + '/generate').status_code == 502
    result = client.post(route + '/generate').json()
    assert result['state'] == 'draft' and len(result['runs']) == 2
    review = {'version': 0, 'decision': 'rejected', 'reply': result['reply'], 'note': 'Needs more evidence.'}
    assert client.post(route + '/review', json=review).status_code == 409
    review['version'] = result['version']
    assert client.post(route + '/review', json=review).json()['state'] == 'rejected'


def test_hourly_attempt_limit_counts_failures(clients):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503)

    client = clients(20, handler)
    case = new_case(client)
    route = f"/api/cases/{case['id']}/generate"
    assert [client.post(route).status_code for _ in range(4)] == [502, 502, 502, 429]
    assert len(calls) == 3


def test_production_cookie_is_secure_and_unknown_workspace_denied():
    with TestClient(create_app(Settings(URL)), base_url='https://testserver') as client:
        assert client.get('/api/cases').status_code == 401
        response = client.post('/api/workspace')
        cookie = response.headers['set-cookie']
        assert 'Secure' in cookie and 'HttpOnly' in cookie and 'SameSite=lax' in cookie
        assert client.get('/api/cases').status_code == 200
    with pytest.raises(ValueError):
        Settings(URL, call_limit=21)

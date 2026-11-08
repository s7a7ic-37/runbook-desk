from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest

from conftest import URL
from server import db
from server.main import EXAMPLES


CASE = {key: EXAMPLES[0][key] for key in ('title', 'description', 'runbook_ids')}


@pytest.mark.parametrize('route', ['/api/cases', '/api/examples/webhook-retries'])
def test_repeating_an_unconfirmed_creation_returns_one_case(clients, route):
    client = clients()
    headers = {'Idempotency-Key': str(uuid4())}
    body = {'json': CASE} if route == '/api/cases' else {}
    # The server committed this request, but the browser did not receive its response.
    original = client.post(route, headers=headers, **body)
    repeated = client.post(route, headers=headers, **body)
    assert original.status_code == repeated.status_code == 201
    assert repeated.json() == original.json()
    assert len(client.get('/api/cases').json()) == 1
    assert not {'creation_key', 'creation_hash'} & repeated.json().keys()
    assert client.get('/api/config').json()['calls_remaining'] == 0
    with db.connection(URL) as conn:
        assert conn.execute('SELECT count(*) AS n FROM runbook_desk.runs').fetchone()['n'] == 0


def test_replay_returns_current_review_without_creating_or_repeating_it(clients):
    client = clients()
    headers = {'Idempotency-Key': str(uuid4())}
    case = client.post('/api/examples/webhook-retries', headers=headers).json()
    reviewed = client.post(f"/api/cases/{case['id']}/review", json={
        'version': case['version'], 'decision': 'approved', 'reply': case['reply'],
        'note': 'Checked the fictional sources.'})
    replayed = client.post('/api/examples/webhook-retries', headers=headers)
    assert replayed.status_code == 201
    assert replayed.json() == reviewed.json()
    assert len(replayed.json()['reviews']) == 1
    assert len(client.get('/api/cases').json()) == 1


def test_example_replay_keeps_the_saved_copy_when_the_catalogue_changes(clients, monkeypatch):
    client = clients()
    headers = {'Idempotency-Key': str(uuid4())}
    original = client.post('/api/examples/webhook-retries', headers=headers).json()
    monkeypatch.setitem(EXAMPLES[0], 'description', 'An updated fictional example, published after the original request was saved.')
    replayed = client.post('/api/examples/webhook-retries', headers=headers)
    assert replayed.status_code == 201 and replayed.json() == original
    assert len(client.get('/api/cases').json()) == 1


def test_different_examples_cannot_share_a_creation_key(clients):
    client = clients()
    headers = {'Idempotency-Key': str(uuid4())}
    original = client.post('/api/examples/' + EXAMPLES[0]['id'], headers=headers).json()
    conflict = client.post('/api/examples/' + EXAMPLES[1]['id'], headers=headers)
    assert conflict.status_code == 409
    assert client.get('/api/cases').json()[0]['id'] == original['id']


@pytest.mark.parametrize('route,body', [
    ('/api/cases', {**CASE, 'title': 'Different fictional case'}),
    ('/api/cases', {**CASE, 'description': CASE['description'] + ' Additional details.'}),
    ('/api/cases', {**CASE, 'runbook_ids': ['rb-scope']}),
    ('/api/examples/webhook-retries', None),
])
def test_a_key_cannot_be_reused_for_different_details_or_mode(clients, route, body):
    client = clients()
    headers = {'Idempotency-Key': str(uuid4())}
    original = client.post('/api/cases', json=CASE, headers=headers).json()
    response = client.post(route, headers=headers, **({'json': body} if body else {}))
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'creation_conflict'
    assert client.get(f"/api/cases/{original['id']}").json() == original
    assert len(client.get('/api/cases').json()) == 1


def test_creation_keys_are_scoped_to_the_browser_workspace(clients):
    first, second = clients(), clients()
    headers = {'Idempotency-Key': str(uuid4())}
    one = first.post('/api/cases', json=CASE, headers=headers)
    two = second.post('/api/cases', json=CASE, headers=headers)
    assert one.status_code == two.status_code == 201
    assert one.json()['id'] != two.json()['id']
    assert len(first.get('/api/cases').json()) == len(second.get('/api/cases').json()) == 1


@pytest.mark.parametrize('different', [False, True])
def test_concurrent_repeats_create_one_case_and_conflicting_details_do_not_win_twice(clients, different):
    first, second = clients(), clients()
    second.cookies.update(first.cookies)
    headers = {'Idempotency-Key': str(uuid4())}
    start = Barrier(3)

    def submit(client, body):
        start.wait(timeout=10)
        return client.post('/api/cases', json=body, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        requests = [pool.submit(submit, first, CASE), pool.submit(submit, second,
            {**CASE, 'title': 'Different concurrent case'} if different else CASE)]
        start.wait(timeout=10)
        responses = [request.result(timeout=20) for request in requests]
    assert sorted(response.status_code for response in responses) == ([201, 409] if different else [201, 201])
    if not different:
        assert responses[0].json()['id'] == responses[1].json()['id']
    assert len(first.get('/api/cases').json()) == 1


def test_existing_creation_can_be_recovered_at_the_workspace_case_limit(clients):
    client = clients()
    headers = {'Idempotency-Key': str(uuid4())}
    original = client.post('/api/cases', json=CASE, headers=headers).json()
    for _ in range(19):
        assert client.post('/api/cases', json=CASE).status_code == 201
    assert client.post('/api/cases', json=CASE, headers={'Idempotency-Key': str(uuid4())}).status_code == 429
    replayed = client.post('/api/cases', json=CASE, headers=headers)
    assert replayed.status_code == 201 and replayed.json()['id'] == original['id']
    assert len(client.get('/api/cases').json()) == 20


def test_replays_work_at_the_global_case_limit_without_allowing_a_new_case(clients):
    owner, other = clients(), clients()
    headers = {'Idempotency-Key': str(uuid4())}
    original = owner.post('/api/cases', json=CASE, headers=headers).json()
    other_case = other.post('/api/cases', json=CASE).json()
    with db.connection(URL) as conn:
        conn.execute('''INSERT INTO runbook_desk.cases
            (id, workspace_id, title, description, runbook_ids, mode)
            SELECT gen_random_uuid(), workspace_id, title, description, runbook_ids, mode
            FROM runbook_desk.cases CROSS JOIN generate_series(1,998) WHERE id=%s''', (other_case['id'],))
    assert owner.post('/api/cases', json=CASE, headers={'Idempotency-Key': str(uuid4())}).status_code == 429
    replayed = owner.post('/api/cases', json=CASE, headers=headers)
    assert replayed.status_code == 201 and replayed.json()['id'] == original['id']


def test_additive_schema_upgrade_preserves_existing_case_and_review(clients):
    client = clients()
    case = client.post('/api/examples/webhook-retries').json()
    reviewed = client.post(f"/api/cases/{case['id']}/review", json={
        'version': case['version'], 'decision': 'approved', 'reply': case['reply'],
        'note': 'Existing review must survive upgrade.'}).json()
    with db.connection(URL) as conn:
        conn.execute('ALTER TABLE runbook_desk.cases DROP COLUMN IF EXISTS creation_key CASCADE')
        conn.execute('ALTER TABLE runbook_desk.cases DROP COLUMN IF EXISTS creation_hash')
    db.initialize(URL)
    db.initialize(URL)
    assert client.get(f"/api/cases/{case['id']}").json() == reviewed
    headers = {'Idempotency-Key': str(uuid4())}
    first = client.post('/api/cases', json=CASE, headers=headers)
    assert client.post('/api/cases', json=CASE, headers=headers).json()['id'] == first.json()['id']


def test_malformed_keys_do_not_create_cases(clients):
    client = clients()
    for key in ('not-a-uuid', 'x' * 1000):
        response = client.post('/api/cases', json=CASE, headers={'Idempotency-Key': key})
        assert response.status_code == 422
        assert key not in response.text
    assert client.get('/api/cases').json() == []

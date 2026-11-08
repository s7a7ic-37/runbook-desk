import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';

test('edge forwards only API requests and preserves browser workspace headers', async () => {
  const originalFetch = globalThis.fetch;
  const env = {API_ORIGIN: 'https://synthetic-backend.example', ASSETS: {fetch: async () => new Response('asset')}};
  try {
    let forwarded;
    globalThis.fetch = async request => {
      forwarded = request;
      return new Response('saved', {headers: {'Set-Cookie': 'runbook_workspace=synthetic; HttpOnly'}});
    };
    const response = await worker.fetch(new Request('https://runbook.artemislab.co.uk/api/cases?view=recent', {
      method: 'POST', body: '{}', headers: {'Origin': 'https://runbook.artemislab.co.uk', 'Cookie': 'runbook_workspace=synthetic',
        'Idempotency-Key': '49802d63-ea51-4165-898a-8a7f387d0248'},
    }), env);
    assert.equal(forwarded.url, 'https://synthetic-backend.example/api/cases?view=recent');
    assert.equal(forwarded.headers.get('Origin'), 'https://runbook.artemislab.co.uk');
    assert.equal(forwarded.headers.get('Cookie'), 'runbook_workspace=synthetic');
    assert.equal(forwarded.headers.get('Idempotency-Key'), '49802d63-ea51-4165-898a-8a7f387d0248');
    assert.match(response.headers.get('Set-Cookie'), /HttpOnly/);
    assert.equal(await (await worker.fetch(new Request('https://runbook.artemislab.co.uk/'), env)).text(), 'asset');
    globalThis.fetch = async () => {throw new Error('private upstream detail');};
    const failure = await worker.fetch(new Request('https://runbook.artemislab.co.uk/api/config'), env);
    assert.equal(failure.status, 503);
    assert.equal(failure.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await failure.text(), /private upstream detail/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {api, ApiError} from '../src/api.ts';

test('API requests keep cookies and surface useful errors without exposing raw responses', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/cases');
      assert.equal(options?.credentials, 'same-origin');
      assert.ok(options?.signal instanceof AbortSignal);
      assert.equal(options?.body, JSON.stringify({title: 'Fictional case'}));
      return Response.json({id: 'synthetic-case'});
    };
    assert.deepEqual(await api('/cases', 'POST', {title: 'Fictional case'}), {id: 'synthetic-case'});
    globalThis.fetch = async () => Response.json({error: {message: 'Live generation is paused.'}}, {status: 503});
    await assert.rejects(api('/cases/synthetic/generate', 'POST'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.message, 'Live generation is paused.');
      return true;
    });
    globalThis.fetch = async () => new Response('private upstream text', {status: 502});
    await assert.rejects(api('/config'), /starting or temporarily unavailable/);
    globalThis.fetch = async () => new Response('<html>Just a moment...</html>', {status: 429});
    await assert.rejects(api('/config'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.match(error.message, /temporarily limiting connections.*Wait a minute/);
      assert.equal(error.retryAfterWake, true);
      assert.doesNotMatch(error.message, /html|Just a moment/);
      return true;
    });
    globalThis.fetch = async () => new Response('<html>Just a moment...</html>', {
      status: 429,
      headers: {'cf-mitigated': 'challenge', 'content-type': 'text/html'},
    });
    await assert.rejects(api('/workspace', 'POST'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.retryAfterWake, true);
      assert.match(error.message, /still waking up.*select Retry connection/);
      assert.doesNotMatch(error.message, /case history|Just a moment/);
      return true;
    });
    globalThis.fetch = async () => Response.json({error: {message: 'The demo is full.'}}, {status: 429});
    await assert.rejects(api('/workspace', 'POST'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.retryAfterWake, false);
      assert.equal(error.message, 'The demo is full.');
      return true;
    });
    for (const status of [503, 504]) {
      globalThis.fetch = async () => new Response('private upstream text', {status});
      await assert.rejects(api('/config'), /starting or temporarily unavailable/);
    }
    globalThis.fetch = async () => new Response('warming up');
    await assert.rejects(api('/config'), /unexpected response/);
    globalThis.fetch = async () => {throw new Error('private network detail');};
    await assert.rejects(api('/config'), /The server could not be reached/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API timeouts bound response and body reads without automatically repeating writes', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  let requests = 0;
  try {
    AbortSignal.timeout = (delay: number) => {
      assert.equal(delay, 90_000);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort(new DOMException('Synthetic timeout', 'TimeoutError')));
      return controller.signal;
    };
    globalThis.fetch = (_url, options) => new Promise<Response>((_resolve, reject) => {
      requests++;
      options?.signal?.addEventListener('abort', () => reject(new Error('private upstream detail')));
    });
    await assert.rejects(api('/cases'), /took too long.*try again in a minute/);
    await assert.rejects(api('/cases', 'POST', {title: 'Fictional case'}), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /took too long.*may still have completed.*Check case history/);
      assert.doesNotMatch(error.message, /private upstream/);
      return true;
    });
    assert.equal(requests, 2);
    globalThis.fetch = async () => {
      const response = Response.json({});
      response.json = async () => { throw new DOMException('Private body detail', 'AbortError'); };
      return response;
    };
    await assert.rejects(api('/cases'), /took too long/);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test('case creation sends the supplied retry key with and without a JSON body', async () => {
  const originalFetch = globalThis.fetch;
  const key = '49802d63-ea51-4165-898a-8a7f387d0248';
  const requests: Request[] = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push(new Request('https://synthetic.example' + url, options));
      return Response.json({id: 'synthetic-case'});
    };
    await api('/cases', 'POST', {title: 'Fictional case'}, key);
    await api('/examples/webhook-retries', 'POST', undefined, key);
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(request.headers.get('Idempotency-Key'), key);
    assert.equal(requests[0].headers.get('Content-Type'), 'application/json');
    assert.deepEqual(await requests[0].json(), {title: 'Fictional case'});
    assert.equal(requests[1].headers.get('Content-Type'), null);
    assert.equal(await requests[1].text(), '');
    globalThis.fetch = async () => { throw new Error('Synthetic connection interruption'); };
    await assert.rejects(api('/cases', 'POST', {title: 'Fictional case'}, key), /Retry with unchanged details to recover the same case/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unreadable write responses explain uncertain completion without repeating requests', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    for (const status of [200, 429, 502, 503, 504]) {
      globalThis.fetch = async () => {
        requests++;
        return new Response('private upstream text', {status});
      };
      await assert.rejects(api('/cases', 'POST', {}, 'synthetic-key'), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /may still have completed.*Retry with unchanged details/);
        assert.doesNotMatch(error.message, /private upstream/);
        return true;
      });
      await assert.rejects(api('/cases/synthetic/review', 'POST', {}), /may still have completed.*Check case history/);
    }
    assert.equal(requests, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

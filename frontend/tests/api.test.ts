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
      assert.doesNotMatch(error.message, /html|Just a moment/);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {api, ApiError} from '../src/api.ts';

test('API requests keep cookies and surface useful errors without exposing raw responses', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/cases');
      assert.equal(options?.credentials, 'same-origin');
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
    await assert.rejects(api('/config'), /The request could not be completed/);
    globalThis.fetch = async () => new Response('warming up');
    await assert.rejects(api('/config'), /unexpected response/);
    globalThis.fetch = async () => {throw new Error('private network detail');};
    await assert.rejects(api('/config'), /The server could not be reached/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

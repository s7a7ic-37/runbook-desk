export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = new URL(env.API_ORIGIN);
      url.protocol = target.protocol;
      url.host = target.host;
      try {
        return await fetch(new Request(url, request));
      } catch {
        return Response.json({error: {code: 'service_unavailable', message: 'The case server is starting or temporarily unavailable. Please try again.'}}, {status: 503, headers: {'Cache-Control': 'no-store'}});
      }
    }
    return env.ASSETS.fetch(request);
  },
};

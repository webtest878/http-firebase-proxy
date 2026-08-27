export const config = { runtime: 'edge' };

const FIREBASE_URL = process.env.FIREBASE_URL?.replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';

async function loadMappings() {
  const res = await fetch(`${FIREBASE_URL}/mappings.json${auth}`);
  if (!res.ok) throw new Error(`Could not load mappings (${res.status})`);
  const data = await res.json();
  const out = {};
  for (const m of Object.values(data || {})) {
    if (m?.alias && m?.url) out[m.alias] = m.url.replace(/\/$/, '');
  }
  return out;
}

export default async function handler(request) {
  if (!FIREBASE_URL) {
    return new Response('FIREBASE_URL is not set', { status: 500 });
  }

  const incoming = new URL(request.url);
  const [, alias, ...rest] = incoming.pathname.split('/');

  if (!alias) {
    return new Response('Usage: /<alias>/<path>', { status: 400 });
  }

  let mappings;
  try {
    mappings = await loadMappings();
  } catch (e) {
    return new Response(e.message, { status: 502 });
  }

  const target = mappings[alias];
  if (!target) {
    return new Response(`Mapping for "${alias}" not found.`, { status: 404 });
  }

  const targetUrl = `${target}/${rest.join('/')}${incoming.search}`;

  // Read the body BEFORE forwarding, so we actually have it to log.
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const requestBody = hasBody ? await request.text() : '';

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('x-forwarded-host');
  headers.delete('accept-encoding');

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: requestBody || undefined,
      redirect: 'manual',
    });
  } catch (e) {
    return new Response(`Problem with request: ${e.message}`, { status: 502 });
  }

  const responseBody = await upstream.text();

  // Must await: a serverless function is frozen the moment you return,
  // so fire-and-forget logging silently drops records.
  try {
    await fetch(`${FIREBASE_URL}/${alias}.json${auth}`, {
      method: 'POST',
      body: JSON.stringify({
        at: Date.now(),
        request: {
          ip: request.headers.get('x-forwarded-for') ?? null,
          url: incoming.pathname + incoming.search,
          target: targetUrl,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: requestBody,
        },
        response: {
          code: upstream.status,
          headers: Object.fromEntries(upstream.headers),
          body: responseBody,
        },
      }),
    });
  } catch (e) {
    console.error('Failed to record request:', e.message);
  }

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  outHeaders.delete('transfer-encoding');

  return new Response(responseBody, { status: upstream.status, headers: outHeaders });
}

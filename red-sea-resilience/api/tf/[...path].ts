const AGENT = 'https://agent.tinyfish.ai';

// Vercel only bundles files reachable from this function's own directory, so
// the whole proxy lives here instead of importing ../server/vercel-handler.
// `maxDuration` is the only supported key; `runtime: 'nodejs'` is not valid.
export const config = { maxDuration: 60 };

declare const process: { env: Record<string, string | undefined> };

const key = () => (process.env.TINYFISH_API_KEY || '').trim();
const upstreamHeaders = () => ({ 'X-API-Key': key(), 'Content-Type': 'application/json' });

function pathSegments(req: any): string[] {
  const q = req.query?.path ?? req.query?.['...path'];
  if (Array.isArray(q)) return q.map(String).filter(Boolean);
  if (typeof q === 'string' && q) return q.split('/').filter(Boolean);

  const raw = String(req.url || '').split('?')[0];
  const marker = raw.indexOf('/tf/');
  const tail = marker >= 0 ? raw.slice(marker + 4) : raw.replace(/^\/+api\/?/, '');
  const parts = tail.split('/').filter(Boolean);
  if (parts[0] === 'tf') return parts.slice(1);
  return parts;
}

function queryString(req: any): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k === 'path' || k === '...path') continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
    else if (v != null) params.set(k, String(v));
  }
  return params.toString();
}

function body(req: any): any {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function send(res: any, status: number, text: string, contentType = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}
const sendJson = (res: any, status: number, value: unknown) => send(res, status, JSON.stringify(value));

async function relay(res: any, up: Response) {
  const text = await up.text();
  const retryAfter = up.headers.get('retry-after');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);
  send(res, up.status, text, up.headers.get('content-type') || 'application/json');
}

export default async function handler(req: any, res: any) {
  const path = pathSegments(req);
  const method = String(req.method || 'GET').toUpperCase();

  if (path.length === 0 || path[0] === 'status') {
    return sendJson(res, 200, { configured: Boolean(key()) });
  }
  if (!key()) return sendJson(res, 503, { error: 'NOT_CONFIGURED' });

  try {
    if (path[0] === 'search' && method === 'GET') {
      return await relay(res, await fetch(`https://api.search.tinyfish.ai?${queryString(req)}`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(20_000),
      }));
    }

    if (path[0] === 'fetch' && method === 'POST') {
      const up = await fetch('https://api.fetch.tinyfish.ai', {
        method: 'POST',
        headers: upstreamHeaders(),
        body: JSON.stringify(body(req)),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await up.text();
      let payload = text;
      if (up.ok) {
        try {
          const parsed = JSON.parse(text);
          // Stamp retrieval time server-side so identical bodies stay auditable.
          payload = JSON.stringify({ ...parsed, retrievedAt: new Date().toISOString() });
        } catch { /* non-JSON upstream error: relay untouched */ }
      }
      return send(res, up.status, payload, up.headers.get('content-type') || 'application/json');
    }

    if (path[0] === 'wallet' && method === 'GET') {
      return await relay(res, await fetch(`${AGENT}/v1/wallet`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(20_000),
      }));
    }

    if (path[0] === 'research' && path[1] === 'start' && method === 'POST') {
      return await relay(res, await fetch(`${AGENT}/v1/automation/run-research-async`, {
        method: 'POST',
        headers: upstreamHeaders(),
        body: JSON.stringify({ query: body(req).query, mode: 'deep' }),
        signal: AbortSignal.timeout(20_000),
      }));
    }
    if (path[0] === 'research' && path[2] === 'cancel' && method === 'POST') {
      return await relay(res, await fetch(`${AGENT}/v1/research-run/${path[1]}/cancel`, {
        method: 'POST',
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(20_000),
      }));
    }
    if (path[0] === 'research' && path[1] && method === 'GET') {
      return await relay(res, await fetch(`${AGENT}/v1/research-run/${path[1]}`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(20_000),
      }));
    }

    if (path[0] === 'agent' && path[1] === 'run-sse' && method === 'POST') {
      const b = body(req);
      if (typeof b.url !== 'string' || !b.url.startsWith('https://')) {
        return sendJson(res, 400, { error: 'https url only' });
      }
      return await relay(res, await fetch(`${AGENT}/v1/automation/run-sse`, {
        method: 'POST',
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({ ...b, agent_config: { max_duration_seconds: 20 } }),
      }));
    }
    if (path[0] === 'agent' && path[1] === 'run' && path[2] && method === 'GET') {
      return await relay(res, await fetch(`${AGENT}/v1/runs/${path[2]}`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(20_000),
      }));
    }
    if (path[0] === 'agent' && path[1] === 'cancel' && path[2] && method === 'POST') {
      return await relay(res, await fetch(`${AGENT}/v1/runs/${path[2]}/cancel`, {
        method: 'POST',
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(20_000),
      }));
    }

    if (path[0] === 'browser' && path[1] === 'capture' && method === 'POST') {
      return sendJson(res, 501, { error: 'capture not available on this host' });
    }

    return sendJson(res, 404, { error: 'not found', path });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { error: String(e) });
  }
}

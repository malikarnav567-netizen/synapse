import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { Readable } from 'node:stream';

const app = express();
app.use(express.json({ limit: '1mb' }));
const KEY = process.env.TINYFISH_API_KEY;
const H = { 'X-API-Key': KEY ?? '', 'Content-Type': 'application/json' };
const AGENT = 'https://agent.tinyfish.ai';

app.get('/api/tf/status', (_q, r) => r.json({ configured: !!KEY }));
app.use('/api/tf', (_q, r, next) => (KEY ? next() : r.status(503).json({ error: 'NOT_CONFIGURED' })));

const httpsOnly = (u: unknown) => typeof u === 'string' && u.startsWith('https://');
async function relay(up: Response, res: express.Response) {
  const ra = up.headers.get('retry-after');
  if (ra) res.setHeader('Retry-After', ra);
  res.status(up.status).type('json').send(await up.text());
}
const fail = (res: express.Response, e: unknown) => { if (!res.headersSent) res.status(502).json({ error: String(e) }); };
const w = (fn: (q: express.Request, r: express.Response) => Promise<unknown>) =>
  (q: express.Request, r: express.Response) => { fn(q, r).catch(e => fail(r, e)); };

app.get('/api/tf/search', w(async (req, res) => {
  const qs = new URLSearchParams(req.query as Record<string, string>);
  await relay(await fetch(`https://api.search.tinyfish.ai?${qs}`, { headers: H }), res);
}));
app.post('/api/tf/fetch', w(async (req, res) => {
  await relay(await fetch('https://api.fetch.tinyfish.ai', {
    method: 'POST', headers: H, body: JSON.stringify(req.body), signal: AbortSignal.timeout(150_000),
  }), res);
}));

let agentRuns = 0;
const MAX_AGENT_RUNS = 5;
app.post('/api/tf/agent/run-sse', async (req, res) => {
  if (!httpsOnly(req.body?.url)) return res.status(400).json({ error: 'https url only' });
  if (agentRuns >= MAX_AGENT_RUNS) return res.status(429).json({ error: 'AGENT_BUDGET' });
  agentRuns++;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const up = await fetch(`${AGENT}/v1/automation/run-sse`, {
      method: 'POST', headers: H, signal: ac.signal,
      body: JSON.stringify({ ...req.body, agent_config: { max_duration_seconds: 60 } }),
    });
    res.status(up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') ?? 'text/event-stream');
    Readable.fromWeb(up.body as any).pipe(res);
  } catch (e) { fail(res, e); }
});
app.get('/api/tf/agent/run/:id', w(async (req, res) => relay(await fetch(`${AGENT}/v1/runs/${req.params.id}`, { headers: H }), res)));
app.post('/api/tf/agent/cancel/:id', w(async (req, res) => relay(await fetch(`${AGENT}/v1/runs/${req.params.id}/cancel`, { method: 'POST', headers: H }), res)));

app.post('/api/tf/research/start', w(async (req, res) => {
  await relay(await fetch(`${AGENT}/v1/automation/run-research-async`, {
    method: 'POST', headers: H, body: JSON.stringify({ query: req.body.query, mode: 'deep' }),
  }), res);
}));
app.get('/api/tf/research/:id', w(async (req, res) => relay(await fetch(`${AGENT}/v1/research-run/${req.params.id}`, { headers: H }), res)));
app.post('/api/tf/research/:id/cancel', w(async (req, res) => relay(await fetch(`${AGENT}/v1/research-run/${req.params.id}/cancel`, { method: 'POST', headers: H }), res)));

app.get('/api/tf/wallet', w(async (_q, res) => relay(await fetch(`${AGENT}/v1/wallet`, { headers: H }), res)));

app.post('/api/tf/browser/capture', async (req, res) => {
  if (!httpsOnly(req.body?.url)) return res.status(400).json({ error: 'https url only' });
  let sessionId: string | undefined;
  try {
    const s: any = await fetch('https://api.browser.tinyfish.ai', {
      method: 'POST', headers: H, body: JSON.stringify({ url: req.body.url, timeout_seconds: 120 }),
      signal: AbortSignal.timeout(60_000),
    }).then(r => r.json());
    sessionId = s.session_id;
    const { chromium } = await import('playwright-core');   // lazy: keeps the serverless bundle small
    const browser = await chromium.connectOverCDP(s.cdp_url);
    await new Promise(r => setTimeout(r, 2000));
    const page = browser.contexts()[0].pages()[0];
    await page.waitForLoadState('domcontentloaded');
    const img = await page.screenshot({ type: 'jpeg', quality: 60 });
    res.json({ sourceUrl: req.body.url, title: await page.title(), capturedAt: new Date().toISOString(), imageBase64: img.toString('base64') });
  } catch (e) { fail(res, e); }
  finally {
    if (sessionId) await fetch(`https://api.browser.tinyfish.ai/${sessionId}`, { method: 'DELETE', headers: H }).catch(() => {});
  }
});

// Production: serve the built website from the same server.
app.use(express.static('dist'));
app.get(/^(?!\/api).*/, (_q, r) => r.sendFile(path.resolve('dist/index.html'), e => e && r.status(404).end()));

const PORT = Number(process.env.PORT) || 8787;
if (!process.env.VERCEL) app.listen(PORT, () => console.log('kitchen open on :' + PORT));

export default app;

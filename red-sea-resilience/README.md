# Red Sea Resilience

1. `npm i`
2. `cp .env.example .env` and paste your `TINYFISH_API_KEY`
3. `npm run dev` → open http://localhost:5173 (add `?simulate` to auto-run once)
4. Production: `npm run build && npm start` (one server serves the site and `/api`)

The key lives only in the server. Without it the UI shows NOT CONFIGURED and the full flow runs on the local model.

## Vercel

The live project is `synapse1-kappa` → https://synapse1-kappa-gamma.vercel.app.

1. Deploy **from this folder**, not the repo root, so the `api/` function is uploaded:
   `vercel deploy --prod --project synapse1-kappa`
2. `TINYFISH_API_KEY` must exist in the project's Production, Preview and Development
   environments. Env changes only apply to **new** deployments, so redeploy after adding it.
3. `api/tf/[...path].ts` must stay self-contained. Vercel does not bundle imports from
   outside `api/` (a `../../server/...` import fails at runtime with
   `ERR_MODULE_NOT_FOUND`), and plain `api` functions only match a **single** path
   segment — `vercel.json` rewrites deeper paths (`/api/tf/research/start`,
   `/api/tf/agent/run/:id`, …) back to the function.
4. The MapTiler key is optional: when it is missing or rejected the globe falls back to
   a keyless CARTO basemap and then to a plain schematic.

Sanity check after deploying:

```bash
curl https://synapse1-kappa-gamma.vercel.app/api/tf/status   # {"configured":true}
curl "https://synapse1-kappa-gamma.vercel.app/api/tf/search?query=Red%20Sea%20advisory"
```

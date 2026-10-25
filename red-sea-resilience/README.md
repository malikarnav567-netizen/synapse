# Synapse

> Live maritime cold-chain disruption control.

A five-agent control room for pharmaceutical containers moving through the Red
Sea. It fuses a cargo IoT feed, live shipping advisories and the actual sea
geometry to answer two different questions — *what is wrong right now* and *what
will be wrong in a few hours* — and keeps a human in the approval loop.

## Run

```bash
npm i
cp .env.example .env          # add TINYFISH_API_KEY
npm run dev                   # http://localhost:5173, add ?simulate to auto-run
npm run build && npm start    # one server on :8787 serves the site and /api
```

`?data=dummy` opens the seeded demo: no sensor, advisory or wallet request is
made, so it runs with the network down and never spends a token. The **Live data
/ Dummy** switch in the header does the same thing and is persisted. Basemap
tiles are the one third-party fetch the demo still makes (the globe degrades to
a schematic if even those fail).

## What is real, what is modelled

| Signal | Source | Provenance |
| --- | --- | --- |
| Vessel position | lane geometry, great-circle densified, advanced along the voyage | model |
| Ambient temp, humidity, wind, cloud | Open-Meteo `v1/forecast` at the vessel's coordinates | **live**, no key |
| Wave height, sea-surface temp | Open-Meteo `v1/marine` | **live**, no key |
| Next-24 h air-temperature peak | Open-Meteo hourly forecast | **live** |
| Box temperature, door, compressor, gateway battery | first-order thermal model driven by the live ambient | model |
| Advisories, port notes, WHO 2–8 °C rule | TinyFish search / fetch / research | **live**, keyed |
| Lane risk zone, port calls, Cape diversion | hand-placed waypoints in `src/lib/routes.ts` | model |

No public API exposes per-container reefer probes, so the box probe is a thermal
twin: it equilibrates against *measured* ambient and sea state, and its faults
(compressor drop-out, door opening, gateway battery) are scenario events. The UI
labels both sides — `Open-Meteo live` on the driver, `box probe is a thermal
model` in the footer — rather than pretending the probe is real hardware.

## Urgent vs predictive

They are separate columns and separate code paths, not two views of one list.

- **Urgent** (`src/lib/predict.ts`, reactive) is computed from the latest
  reading only: over-limit, compressor offline, door open, or a limit crossing
  inside 90 minutes. It stays correct with the network down, and a device with an
  urgent case is removed from the predictive column so red always means *act
  now*.
- **Predictive** is the planner's column: where the first-order model reaches
  equilibrium, the forecast peak in the next 12 hours, sea-state speed derating,
  and how much delivery-window slack a Cape diversion would consume (computed
  from the real lane lengths). Horizon: 36 hours.

Time-to-limit is solved from the model (`t = -tau·ln((target-limit)/(target-box))`)
rather than extrapolating noisy samples, so a box drifting to a safe equilibrium
never raises a false alarm.

## Latency contract

`src/lib/net.ts` is the only way out to the network:

- **urgent** reads: 2.6 s ceiling, no retries — a late answer about an already
  warm box is worthless.
- **patient** reads: 12 s ceiling, two jittered retries, per-host circuit breaker
  after three consecutive failures so a flapping upstream cannot stall the UI.
- Every call is measured; the Fleet card shows the real p95 and timeout count.

Telemetry has two cadences for the same reason: a 4 s local model tick keeps the
console live, a 60 s upstream refresh keeps the *driver* real. A failed refresh
keeps the last good snapshot and marks it stale instead of blanking the screen.

## Token discipline

`src/lib/budget.ts` keeps a TinyFish wallet alive across repeated demos:

1. TTL cache — advisories 15 min, port/general 6 h, reference material 24 h.
2. In-flight dedupe — two agents asking the same question share one request.
3. Hard ceiling of 20 paid calls per rolling UTC hour. Past it the intelligence
   agent degrades to the local model instead of silently burning credits.

Cache hits are free, so re-running the assessment inside the TTL windows costs
nothing. The Fleet card shows `TF spent/cap` and the number of answers served
from cache; dummy mode spends nothing at all.

## Performance

MapLibre (~1.08 MB, 294 kB gzip) is a lazy chunk: the console shell is 203 kB
(67 kB gzip) and paints before WebGL is even requested, so the first screen never
waits on the globe. Telemetry costs two requests per minute (air + marine, both
Open-Meteo, batched across vessels), and the urgent path costs none.

## Deploy (Vercel)

The live project is `synapse1-kappa` → https://synapse1-kappa-gamma.vercel.app.

1. Deploy **from this folder**, not the repo root, so the `api/` function ships:
   `vercel deploy --prod --project synapse1-kappa`
2. `TINYFISH_API_KEY` must exist in Production, Preview and Development. Env
   changes only apply to **new** deployments, so redeploy after adding it.
3. `api/tf/[...path].ts` must stay self-contained. Vercel does not bundle imports
   from outside `api/` (a `../../server/...` import fails at runtime with
   `ERR_MODULE_NOT_FOUND`), and plain `api` functions only match a single path
   segment — `vercel.json` rewrites deeper paths back to the function.
4. Open-Meteo needs no key and is called straight from the browser (CORS `*`), so
   telemetry works even when the TinyFish wallet is empty.
5. MapTiler key is optional: without it the globe falls back to a keyless CARTO
   basemap and then to a plain schematic.

Sanity check after deploying:

```bash
curl https://synapse1-kappa-gamma.vercel.app/api/tf/status   # {"configured":true}
curl "https://synapse1-kappa-gamma.vercel.app/api/tf/search?query=Red%20Sea%20advisory"
```

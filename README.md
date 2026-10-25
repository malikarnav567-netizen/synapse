# Synapse

> Live maritime cold-chain disruption control.

A five-agent control room for pharmaceutical containers moving through the Red
Sea. It fuses a cargo IoT feed, live shipping advisories and the real sea
geometry to answer two different questions — *what is wrong right now* and *what
will be wrong in a few hours* — and keeps a human in the approval loop.

**Live:** https://synapse1-kappa-gamma.vercel.app
**Source:** [`red-sea-resilience/`](red-sea-resilience/) — the whole app lives there.

## Quick start

```bash
cd red-sea-resilience
npm i
cp .env.example .env          # add TINYFISH_API_KEY (server-side only)
npm run dev                   # http://localhost:5173 — add ?simulate to auto-run
```

Open with `?data=dummy` (or the **Live data / Dummy** switch in the header) to run
the entire console offline on seeded data: no sensor, advisory or wallet request is
made, so it works with the network down and never spends a token.

## What it does

The console shows a 3D globe of the shipping lanes, a cargo telemetry ribbon for
every reefer container, and two deliberately separate case columns:

- **Urgent** — reactive, minutes. Over-limit box, compressor offline, door open, or
  a limit crossing inside 90 minutes. Computed from the latest reading only, so it
  stays correct with the network down. A device with an urgent case is removed from
  the predictive column, so red always means *act now*.
- **Predictive** — proactive, 36 hours. Forecast peak, sea-state speed derating, and
  how much delivery-window slack a Cape diversion would consume, all computed from
  live conditions and the real lane lengths.

Time-to-limit is solved from the thermal model
(`t = -tau·ln((target-limit)/(target-box))`) rather than extrapolating noisy
samples, so a box drifting to a safe equilibrium never raises a false alarm.

## What is real, what is modelled

| Signal | Source | Provenance |
| --- | --- | --- |
| Ambient temp, humidity, wind, cloud | Open-Meteo at the vessel's coordinates | **live**, no key |
| Wave height, sea-surface temp | Open-Meteo marine | **live**, no key |
| Next-24 h air-temperature peak | Open-Meteo hourly forecast | **live** |
| Advisories, port notes, WHO 2–8 °C rule | TinyFish search / fetch / research | **live**, keyed |
| Box temperature, door, compressor, gateway battery | first-order thermal twin driven by the live ambient | model |
| Vessel position, lane risk zone, Cape diversion | hand-placed waypoints in `src/lib/routes.ts` | model |

No public API exposes per-container reefer probes, so the box probe is a thermal
twin that equilibrates against *measured* ambient and sea state. The UI labels both
sides — `Open-Meteo live` on the driver, `box probe is a thermal model` in the
footer — rather than pretending the probe is real hardware.

## Efficiency

- **Latency tiers** (`src/lib/net.ts`): urgent reads get a 2.6 s ceiling with no
  retries; patient reads get 12 s, two jittered retries and a per-host circuit
  breaker. Every call is measured, so the Fleet card shows real p95 and timeout
  counts.
- **Token discipline** (`src/lib/budget.ts`): TTL cache (advisories 15 min, port
  6 h, reference 24 h), in-flight dedupe, and a hard 20-call/hour ceiling. Past it
  the intelligence agent degrades to the local model instead of silently burning
  credits. The Fleet card shows `TF spent/cap` and cache hits.
- **Payload**: MapLibre (~1.08 MB, 294 kB gzip) is a lazy chunk, so the console
  shell (203 kB, 67 kB gzip) paints before WebGL is even requested.

## Tests

```bash
npm test          # 52 headless tests, node's built-in runner — no extra dependency
npm run typecheck # src, server and tests
```

The suites cover the triage logic, the latency contract, the spend guard, the sensor
layer, the geometry helpers, and that dummy mode and an exhausted budget both refuse
*before* the network. See [`red-sea-resilience/README.md`](red-sea-resilience/README.md)
for the full breakdown and the deploy notes.

## Deploy

The Vercel project is `synapse1-kappa`, with `Root Directory = red-sea-resilience`.
Deploy **from the repo root** so the upload contains that directory:

```bash
vercel deploy --prod --project synapse1-kappa
```

Sanity check afterwards:

```bash
curl https://synapse1-kappa-gamma.vercel.app/api/tf/status   # {"configured":true}
```

## Honest limits

- The reefer probe and its faults are modelled; the ambient driving them is not.
- AIS is labelled simulated — there is no free AIS feed wired in.
- Dummy mode still fetches basemap tiles and fonts; it makes no *sensor or advisory*
  request. With `VITE_MAPLIBRE_KEY` unset the globe degrades to a keyless CARTO
  basemap and then to a plain schematic.
- The TinyFish wallet on the current key reads $0.00, so browser audit capture
  returns 402; search, fetch and research still answer and the decision flow works.

# Red Sea Resilience

1. `npm i`
2. `cp .env.example .env` and paste your `TINYFISH_API_KEY`
3. `npm run dev` → open http://localhost:5173 (add `?simulate` to auto-run once)
4. Production: `npm run build && npm start` (one server serves the site and `/api`)

The key lives only in the server. Without it the UI shows NOT CONFIGURED and the full flow runs on the local model.

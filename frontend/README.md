# Frontend (lane:web)

React + Vite + the SpacetimeDB TypeScript SDK. The views to build are in [master-plan §10](../docs/master-plan.md); the data they read is in [CONTRACT.md](../CONTRACT.md) §3 and §6.

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build && npm run lint   # what CI runs
```

Client bindings come from the module: `spacetime generate --lang typescript --out-dir src/module_bindings --project-path ../backend/module` (needs the `spacetime` CLI; the first lane:web frontend issue sets this up).

Env (`frontend/.env.local`, optional): `VITE_STDB_URI` (default `same-host`: the page's host on port 3000, so `npm run dev` uses the workspace `scripts/remi up` runs on this machine), `VITE_STDB_DB` (`remi`).

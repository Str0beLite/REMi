# Backend

| Folder | Lane | What |
|---|---|---|
| [module/](module/) | lane:web | SpacetimeDB TypeScript module: tables (`src/contract.ts`) and reducers (`src/index.ts`) |
| [runtime/](runtime/) | lane:core, lane:gpu | Python runtime: agent loop, tools, sandbox, serving, sleep cycle |
| `sandbox/` | lane:core | Per-REMi Docker workspace (not created yet) |

Everything builds against [CONTRACT.md](../CONTRACT.md).

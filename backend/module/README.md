# SpacetimeDB module (lane:web)

Tables are fixed in `src/contract.ts` (contract file, Ryan merges changes). Reducers from [CONTRACT.md §4](../../CONTRACT.md) go in `src/index.ts`.

```bash
npm ci
npm run typecheck && npm test     # what CI runs; tests use spacetimedb's in-process test harness, no server needed
```

Local server + publish (needs the `spacetime` CLI):

```bash
spacetime start                                   # local server on :3000
spacetime publish --project-path . remi           # publish to the local server
spacetime publish --server maincloud --project-path . remi   # shared dev DB, from main only
```

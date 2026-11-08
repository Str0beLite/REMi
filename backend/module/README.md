# SpacetimeDB module (lane:web)

Tables are fixed in `src/contract.ts` (contract file, Ryan merges changes). Reducers from [CONTRACT.md §4](../../CONTRACT.md) go in `src/index.ts`.

```bash
npm ci
npm run typecheck && npm test     # what CI runs; tests use spacetimedb's in-process test harness, no server needed
```

Reducers live one file per area in `src/reducers/` (`chat`, `work`, `agents`, `adapters`), each re-exported from `src/index.ts`.

## Publish and regenerate bindings

Needs the `spacetime` CLI ([install](https://spacetimedb.com/install); tested with 2.14.1). One command typechecks, tests, publishes and regenerates `frontend/src/module_bindings/`:

```bash
spacetime start                              # local server on :3000, in its own terminal
scripts/publish-module.sh                    # publish `remi` to local + regenerate bindings
scripts/publish-module.sh local --reset      # same, dropping all local data first
```

Commit the regenerated `frontend/src/module_bindings/` whenever a reducer or table changes.

Check it worked:

```bash
spacetime sql remi "SELECT * FROM channel" --server local    # general and ops exist after init
spacetime logs remi --server local -n 20                     # reducer errors show here
```

A real workspace publishes itself: `scripts/remi up` runs SpacetimeDB, publishes this module and writes the owner's token to `.env` (never in git).

The local server has no admin bootstrap yet (CONTRACT.md §12). To make your own identity admin while developing:

```bash
spacetime call remi set_nickname '"you"' --server local
spacetime sql remi "UPDATE user SET is_admin = true WHERE nickname = 'you'" --server local
```

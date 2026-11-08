# Agent notes

## Repo layout
- `frontend/`: client app. `backend/`: API and data. `docs/`: idea, decisions, pitch.
- Read `docs/idea.md` and `docs/master-plan.md` before building; they define the MVP scope and the build contract. Don't build features outside it without asking.
- Log notable stack or architecture choices in `docs/decisions.md` (one line each).

## Hackathon rules
- Ship the smallest thing that demos well. Prefer boring, well-known libraries.
- Keep frontend and backend runnable with one command each, documented in their READMEs.

<!-- hackathon-kit:start -->
## Skill kit (.agents/skills)
Core skills: grill-with-docs (uses grilling + domain-modeling), ponytail, impeccable, gsap-react, gsap-scrolltrigger, webapp-testing, systematic-debugging, web-design-guidelines, verification-before-completion.
- Follow the ponytail skill at LITE level for the whole session.
- Stack skills by lane: web → typescript-server, typescript-client, concepts, cli, react-best-practices; core → spacetimedb-http, spacetimedb-sql, spacetimedb-serialization; gpu → trl-training. Read the matching one before writing SpacetimeDB, React or training code.
- Parallel build: work is GitHub issues labelled lane:web / lane:core / lane:gpu. Run one lane with the lane skill (`/lane core` etc.); write or edit task issues with the lane-tasks skill. A task is complete only when its PR merges. Never edit CONTRACT.md outside a lane:contract issue.

Before calling the work done: review every UI file against the web-design-guidelines skill and fix what it finds, then follow verification-before-completion (fresh build + lint, read the exit codes).
<!-- hackathon-kit:end -->

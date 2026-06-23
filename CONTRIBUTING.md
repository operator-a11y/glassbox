# Contributing

Glassbox is a local-first, TypeScript monorepo. Everything runs offline against a
deterministic stub model — no API key needed to develop or test.

## Setup

```bash
pnpm install
pnpm verify        # typecheck + all tests (must be green)
pnpm demo          # record → replay → fork on the demo agent, in the terminal
pnpm dev           # daemon :4319 + debugger UI http://localhost:3000
```

With `ANTHROPIC_API_KEY` set (and optionally `GLASSBOX_MODEL_ID`), `record` and the fork
suffix call the real model; replay never calls a model either way.

## Layout

- `packages/engine` — record-replay-fork core (pure, headless, zod-validated). The
  integration contract is in [`INTEGRATION.md`](./INTEGRATION.md); the design rationale in
  [`DESIGN.md`](./DESIGN.md).
- `packages/daemon` — localhost REST API over the engine.
- `apps/web` — Next.js debugger UI (thin client over the daemon).
- `examples/*` — two demo agents + the CLI / daemon / dev entrypoints.

## Conventions

- **TypeScript strict, no `any`.** zod at every model/tool/external boundary; never trust
  raw model output. The engine stays framework-free and UI-free so it's testable headless.
- **Determinism is non-negotiable.** A replay that isn't bit-identical pre-fork is a bug;
  it's covered by automated tests, not vibes. Agent state must be plain JSON; all
  nondeterminism flows through `io.ctx`.
- **Side effects are recorded-and-mocked by default.** New side-effecting tools must
  declare `kind: 'side_effecting'` and provide a pure `simulate`.
- **Conventional commits, one per coherent step.** Do not add AI/Claude co-author lines.
- Follow `PLAN.md`; don't pull later-phase work forward without being asked.

## Tests

```bash
pnpm test                              # all packages
pnpm --filter @glassbox/engine test    # one package
pnpm --filter @glassbox/web build      # the web app (its own typecheck)
```

Determinism and fork divergence are covered by `packages/engine/test`; the daemon API by
`packages/daemon/test`; each demo agent by its own `test/`.

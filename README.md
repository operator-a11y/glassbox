# Glassbox

An agent-development tool built on one capability: **deterministic record-replay-fork of an agent run.**
Record everything an agent does, replay it exactly, and fork from any step to explore counterfactuals.

> **Phase 0 (this repo): the engine spike.** Prove the atom on a real, side-effecting agent —
> record → bit-identical replay → fork (edit a step, replay forward) → divergent-but-valid
> continuation, with side effects recorded-and-mocked. No product UI yet.

See [`SPEC.md`](./SPEC.md) for the product, [`PLAN.md`](./PLAN.md) for the roadmap, and
[`CLAUDE.md`](./CLAUDE.md) for conventions.

## Quickstart

```bash
pnpm i
pnpm verify    # typecheck + run all tests (offline, no API key required)
pnpm demo      # record → replay → fork on the demo agent, end to end
```

`pnpm demo` runs the [research-emailer](./examples/research-emailer) agent
(`topic → search → read → draft → send_email → confirm`) and shows:

1. **record** — a live run captured to a trace; the real email written to `outbox.json` once.
2. **replay** — the run re-driven **bit-identically**; the LLM **not re-called**; the email
   **SIMULATED** (served from the recording), `outbox.json` unchanged.
3. **fork** — restore state at a step, edit the system prompt, run **live forward from there**;
   pre-fork steps byte-identical, the continuation divergent, the email still **SIMULATED**.

Everything runs offline against a deterministic stub model. Set `ANTHROPIC_API_KEY`
(and optionally `GLASSBOX_MODEL_ID`, default `claude-sonnet-4-6`) to record and fork against the
real model instead; replay never calls the model.

## The debugger UI

```bash
pnpm dev     # local daemon (:4319) + Next.js debugger (http://localhost:3000)
```

Open <http://localhost:3000>: record a run, scrub its **timeline**, inspect any step
(prompt / tool I/O / state / captured nondeterminism), hit **Replay** for a
`bit-identical ✓`, then **Fork** — edit the system prompt at a step and watch the
divergent branch render side by side, with side effects SIMULATED. The web app is a
thin client over the daemon's REST API; the engine is never bundled into the browser.

## The `glassbox` CLI — two agents, one engine

The generic CLI drives record/replay/fork over a SQLite trace store for **any**
registered agent. Two demo agents are wired in; the second one (support-triage)
required zero engine or CLI changes — it is just another registration.

```bash
pnpm glassbox record --agent research-emailer --input '{"topic":"vector databases","recipient":"team@x.com"}'
pnpm glassbox record --agent support-triage   --input '{"customer":"c-42","ticket":"login is broken, cannot access account"}'
pnpm glassbox list
pnpm glassbox replay --trace <id>                       # bit-identical; LLM not re-called; side effect SIMULATED
pnpm glassbox fork   --trace <id> --step <n> --system "…edited prompt…"   # divergent continuation
```

Instrumenting a new agent is config-only via the tool-loop adapter — see
[`INTEGRATION.md`](./INTEGRATION.md).

## Layout

```
packages/engine            record-replay-fork core, trace model, tool-loop adapter,
                           Anthropic SDK adapter, SQLite store, generic CLI (pure, zod-validated)
packages/daemon            local REST API over the engine (record/list/replay/fork)
apps/web                   Next.js debugger UI (thin client over the daemon)
examples/research-emailer  demo agent #1: topic → search → read → draft → send_email → confirm
examples/support-triage    demo agent #2: ticket → classify → lookup → draft → create_ticket → confirm
examples/glassbox          CLI + daemon + dev entrypoints registering both agents over SQLite
INTEGRATION.md             the integration contract (raw + tool-loop adapter)
SPEC.md PLAN.md CLAUDE.md  product, roadmap, conventions
```

## The engine in one screen

- **Determinism is the product.** Every nondeterminism source (LLM outputs, tool results,
  timestamps, ids) is recorded and served back on replay. A replay that isn't bit-identical pre-fork
  is a bug, enforced by an automated test.
- **Resumption by re-drive, not restore.** Replay/fork re-run the agent from the top; the engine
  serves recorded values for steps before the fork and runs live after. This makes "bit-identical" a
  real proof (state is recomputed and compared) and dissolves a class of state-restore bugs.
- **Side effects are recorded-and-mocked.** Tools are typed `read_only | idempotent | side_effecting`.
  A side-effecting tool runs for real only at record time; on replay/fork it is served or synthesized
  and labeled **SIMULATED**, never re-fired — with an engine trap that throws if it ever is.

## Status

**Phases 0–2 are complete.** Phase 0 (engine spike) and Phase 1 (hardening + integration
contract: tool-loop adapter, per-tool opt-in live re-exec, Anthropic SDK adapter, SQLite, generic
CLI, proven on a **second agent with no engine changes**). Phase 2 (the money demo): the
`glassbox dev` daemon + Next.js debugger UI — open a recorded run in the browser, scrub it, fork a
step with an edited prompt, and see the divergent branch. `pnpm i && pnpm verify` is green from a
fresh clone; the daemon API and UI proxy are verified end to end. Next is
[Phase 3](./PLAN.md): local packaging + open-source polish.

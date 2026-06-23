# CLAUDE.md — Glassbox

Context and conventions for this repo. Read fully before acting.

## What this is

Glassbox (working name) is an agent-development tool built on one capability: **deterministic record-replay-fork of an agent run.** You record everything an agent does, replay it exactly, and fork from any step to explore counterfactuals. Debugging, security, evals, regression, and probes are all *views* over that engine.

This is a **portfolio-grade open-source project that could seed a startup** — optimize for a deep, correct, novel, working core over breadth. Do **not** build the whole platform at once; follow `PLAN.md` phase by phase.

## The thesis (don't drift from it)

The atom is **record → replay (bit-identical) → fork (edit a step, replay forward) → divergent-but-valid continuation.** If a change doesn't serve that engine or a view directly over it, it's out of scope for now.

## Non-negotiable principles

1. **Determinism is the product.** Every source of nondeterminism (LLM outputs, tool results, timestamps, randomness) is recorded and, on replay, served from the recording. A replay that isn't bit-identical pre-fork is a bug.
2. **Side effects are recorded-and-mocked by default.** You cannot faithfully re-run a real side effect (a sent email, a charge). On replay/fork, side-effecting tools are served from the recording and clearly labeled SIMULATED. Live re-execution is opt-in and explicit, per tool.
3. **Instrument structured agents first.** Support agents expressed as a resumable step function `(state, input) -> (state, action)` and known framework loops (Anthropic SDK now; LangGraph later) before arbitrary control flow. Keep the integration contract small.
4. **Engine before UI.** The record-replay-fork engine must be proven on a real agent before any web UI is built.
5. **Local-first.** Everything runs on localhost — importable SDK + a local daemon serving a web app. No cloud, no auth, no telemetry leaving the machine. Hosted/team is a far-future add-on.
6. **Never build your own IDE.** The VS Code/Cursor extension (later) is a thin second skin over the same web app. Stay the control plane, not the editor.

## Stack (locked unless flagged)

- **Language: TypeScript everywhere** (engine, daemon, web app) — one codebase, first-class Anthropic TS SDK. (Python/LangGraph is a possible future adapter, not the foundation.)
- **Engine + daemon:** Node + TypeScript (strict, no `any`). Daemon CLI is `glassbox`.
- **Storage:** SQLite (local, zero-config) via a thin typed layer. (Phase 0 may use on-disk JSON.)
- **Web app:** Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui.
- **LLM:** `@anthropic-ai/sdk`, model id from env (`GLASSBOX_MODEL_ID`, default `claude-sonnet-4-6`).
- **Trace model:** own typed schema (zod-validated). OpenTelemetry is an optional *export* only — never the foundation (span-shaped data fights forking).
- **Package manager:** pnpm (monorepo via workspaces). Ask before adding deps beyond these.

## Repo shape (target)

- `packages/engine` — record-replay-fork core + trace model + SDK (`glassbox`)
- `packages/daemon` — local service: trace store, replay/fork orchestration, HTTP API, serves the web app
- `apps/web` — Next.js debugger UI
- `examples/` — instrumented demo agents
- `SPEC.md`, `PLAN.md` — product/architecture + phased roadmap

## Conventions

- TypeScript strict; zod at every LLM/tool/external boundary; never trust raw model output.
- Conventional commits, one per coherent step. **Never add Claude/AI co-author lines or any AI attribution to commits or PRs.**
- Keep the engine framework-free and UI-free (pure TS) so it's testable headless.
- Engine tests are mandatory: record/replay determinism and fork divergence are covered by automated tests, not vibes.
- Follow `PLAN.md`; don't pull later-phase work forward without being asked.

## How to work

Start at `PLAN.md` Phase 0 (the engine spike); the detailed kickoff is `BUILD-PHASE-0.md`. Read `SPEC.md` for the full picture. Build the current phase to its exit criteria, commit, stop, and report — don't sprint ahead into UI or later pillars.

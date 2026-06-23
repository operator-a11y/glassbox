# Glassbox — Phase 0 Build (engine spike)

You're starting **Glassbox**, an agent-debugging tool whose core capability is **deterministic record-replay-fork** of an agent run. This first session builds *only the engine spike* that proves the thesis — no product UI. Read `CLAUDE.md`, `SPEC.md`, and `PLAN.md` in full first, then write a short build plan and proceed phase-internally, committing after each coherent step.

## The thesis you are proving

On a real, structured, side-effecting agent:

1. **Record** a full run — every LLM output, every tool call + result, per-step state, and all nondeterminism.
2. **Replay** it and assert it's **bit-identical** to the original (all recorded values served back; the LLM is not re-called).
3. **Fork** at a chosen step: restore that step's state, edit the system prompt, and **replay forward from that step only** — re-calling the LLM from the fork onward — producing a divergent but valid continuation, with steps before the fork untouched.
4. **Side-effect soundness:** the side-effecting tool is **served from the recording on replay/fork (mocked) and labeled SIMULATED**; it is never actually re-fired during replay.

If all four hold with green tests, the thesis is validated. If clean resumability turns out to require contorting the agent unnaturally, **stop and document exactly why** — that's a valid Phase-0 outcome and the go/no-go signal for the project.

## Stack (per CLAUDE.md)

TypeScript strict, Node, pnpm monorepo. `@anthropic-ai/sdk` (model from `GLASSBOX_MODEL_ID`, default `claude-sonnet-4-6`). zod at every boundary. No web UI this phase. On-disk JSON for traces is fine here (SQLite comes in Phase 1). Ask before adding deps.

## Build

### 1. Engine (`packages/engine`)

- **Trace model** (zod): `Trace` and `Step` per `SPEC.md`, including a `nondeterminism` field and per-tool `kind` (`read_only | idempotent | side_effecting`).
- **Instrumentation:**
  - `wrapModel(client)` — intercepts completions; on each call emits a `Step{type:'llm'}` with prompt, completion, tokens, latency. In replay mode, returns the recorded completion instead of calling the API.
  - `createToolRunner(tools)` — intercepts tool calls; emits `Step{type:'tool'}` with args + result + kind. In replay mode, returns the recorded result; for `side_effecting` tools it **never executes**, returns the recorded result, and marks the step SIMULATED.
- **State capture:** each step snapshots the agent's working state (message list / scratchpad) sufficient to resume.
- **Runner:** drives a structured agent `(state, input) -> (state, action)` in two modes — `record` and `replay({ fromStep?, mutation? })`. `replay` with no args reproduces exactly; with `fromStep` + a `mutation` (e.g. edited system prompt) it serves recorded values up to `fromStep`, applies the mutation, restores state, and runs live from there.
- **Determinism:** record timestamps / seeds / any other nondeterminism and serve them back on replay.

### 2. Demo agent (`examples/research-emailer`)

A structured agent, 5–8 steps, doing real multi-step tool use, e.g.: take a topic → search (stubbed/local) → read results → draft a short summary → **send an email** (the side-effecting tool, stubbed to append to a local `outbox.json`) → confirm. Written in the resumable step-function shape so the engine can record/replay/fork it.

### 3. CLI harness (`packages/engine` bin or a script)

Commands that demonstrate the thesis end to end:

- `record` — run the demo agent live, write the trace to disk, append the real email to `outbox.json`.
- `replay` — replay the trace; assert bit-identical to the recording; prove the email tool was **served from the recording, SIMULATED, and `outbox.json` was NOT written again**.
- `fork --step N --system "<edited prompt>"` — fork at step N with an edited system prompt; show original vs forked continuation side by side (console diff is fine); confirm pre-fork steps are identical and the email step (if past the fork) is SIMULATED.

### 4. Tests

Automated tests asserting: (a) replay is bit-identical pre-fork; (b) the side-effecting tool never re-executes during replay/fork (outbox unchanged); (c) forking at step N changes only steps ≥ N and yields a valid continuation.

## Conventions (per CLAUDE.md)

Conventional commits, one per coherent step, **no AI co-author attribution**. Engine stays pure TS (no UI, headless-testable). zod at all model/tool boundaries.

## Definition of done

- `pnpm i && pnpm test` green from a fresh clone.
- The three CLI commands demonstrate record → bit-identical replay → fork-with-edited-prompt → divergent continuation, with the email tool SIMULATED on replay/fork and `outbox.json` written only during `record`.
- A short `examples/research-emailer/README.md` showing the three commands and what each proves.

## Out of scope (do not build now)

Web UI / Next app, the daemon, SQLite persistence, MCP proxy/firewall, evals, regression, probes, the editor extension, arbitrary non-structured agents, multi-user/auth. Those are later phases in `PLAN.md`.

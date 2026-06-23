# Glassbox — Build Plan

Engine-first, UI-second. Build each phase to its exit criteria, commit, stop, report. Don't pull later work forward unprompted.

## Phase 0 — Engine spike (prove the thesis) ← start here

**Goal:** validate record → bit-identical replay → fork → valid divergence, with side effects mocked, on one real agent. No product UI.

- Build the minimal engine (`packages/engine`): trace model, the LLM + tool wrappers, state capture, and the replay/fork driver.
- Write one **structured demo agent** (`examples/`): 5–8 steps, real tool use, including at least one **side-effecting** tool (e.g. "send email", stubbed to a local outbox).
- A CLI harness that records a run; replays it and asserts bit-identical pre-fork; forks at a chosen step with an edited system prompt and shows a divergent continuation; serves the side-effecting tool from the recording on replay, labeled SIMULATED.
- Automated tests for determinism and fork divergence.

**Exit:** the harness demonstrates all of the above on the demo agent, green tests — OR you've documented exactly what makes clean resumability intractable (then we narrow scope or pivot to the firewall). This is the go/no-go for the whole project.

*(Detailed kickoff: `BUILD-PHASE-0.md`.)*

## Phase 1 — Engine hardening + integration contract

**Goal:** any structured agent (and the Anthropic SDK agent loop) can be recorded, replayed, and forked reliably.

- Generalize and document the integration contract; add the **Anthropic SDK agent-loop adapter**.
- Robust state capture, deterministic-replay guarantees, the record-and-mock side-effect policy with per-tool opt-in live re-exec.
- Persist traces in SQLite; ship the `glassbox` CLI (record, list, replay, fork).

**Exit:** instrument a second, different agent with no engine changes; full record/replay/fork works from the CLI.

## Phase 2 — Debugger UI (the demo)

**Goal:** the money demo in a browser.

- `glassbox dev` daemon serves a Next.js web app + API.
- Trace timeline, step inspector (state / prompt / tool I/O per step), and the **fork-and-replay** interaction (pick a step, edit the prompt or a tool output, watch the divergent replay stream in).

**Exit:** open a recorded run in the browser, scrub it, fork a step, and see the new branch — end to end.

## Phase 3 — Local packaging + open-source

**Goal:** a stranger can use it.

- Clean SDK + daemon DX; `npm i` + a few lines to instrument a sample agent.
- README, a 90-second demo GIF on a real agent, and a short **design write-up of the record-replay-fork engine** (especially side-effect handling). Public repo.

**Exit:** fresh-clone setup works; the demo + writeup are public. For a lab, this *is* the signal.

## Later pillars (each its own phase, deferred — do not start unprompted)

- **MCP firewall / observability** — policy + injection/secret scanning on the capture layer. Pillar 2, and the de-risked pivot if Phase 0/1 resumability proves too hard.
- **Evals + regression gate** — task generation, scoring, failure heatmap; trace-diff PR gate. Nearly free once replay exists.
- **Probes** — attach scoped agents to hookable runtime events; read-only modes first.
- **Editor extension** — VS Code/Cursor webview over the same web app; never a forked IDE.

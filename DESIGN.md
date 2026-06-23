# Design: the record-replay-fork engine

Glassbox is built on one capability — **deterministically record an agent run, replay
it bit-identically, and fork from any step into a divergent-but-valid continuation** —
with side effects recorded-and-mocked so a replay never re-sends an email or re-charges
a card. This document explains how the engine works and, more importantly, *why* the
non-obvious decisions are the way they are. The hard parts are determinism and
side-effect soundness; most of the design exists to make those two correct by
construction rather than by hope.

## 1. The atom

```
record  ──▶  trace ──▶  replay (bit-identical, LLM not re-called)
                  └────▶ fork(k, edit) ──▶ divergent continuation, steps 0..k-1 untouched
```

A **trace** captures everything an agent did: every LLM call (system + messages +
completion + tokens), every tool call (args + result + kind), per-step working state,
and every draw of nondeterminism (time, randomness, ids). Replay re-drives the agent
feeding those recorded values back. Fork restores the state at step *k*, applies an edit
(e.g. a new system prompt), and runs **live from k onward** — re-calling the LLM only
in the divergent suffix.

Everything else — the CLI, the daemon, the debugger UI — is a *view* over this engine.

## 2. Resumability without contorting the agent

The kickoff named the failure mode up front: if clean resumability requires twisting the
agent into an unnatural shape, that's the go/no-go signal to stop. It nearly did.

The tempting contract is a pure step function `(state, input) -> (state, action)`. It
can't carry an LLM completion back into the agent's *next* decision without the author
hand-serializing a continuation into `state` — exactly the contortion we were warned
about. The fix is the opposite shape: **inline-io**.

```ts
type AgentFn = (io: AgentIO) => Promise<JsonValue>;   // returns the run's `final`
// io.model.complete(...) and io.tools.run(...) are awaited inline; io.state is mutated.
```

The agent reads like ordinary code. The trick is how we resume it:

> **Resumption is deterministic re-drive, not snapshot-restore.** Replay and fork re-run
> the agent function *from the top*. For each primitive the agent reaches, the engine
> either **serves** the recorded value (before the fork) or runs it **live** (at/after
> the fork). Because the agent's control flow is deterministic given served values,
> re-driving reconstructs the exact same state — so we never restore a snapshot mid-function.

This one decision pays for itself repeatedly:

- **"Bit-identical" becomes a real proof.** State is *recomputed* by re-driving and then
  compared to the recording, not copied from it. A copy-and-compare would be a tautology.
- A whole class of bugs disappears: no mid-function continuation to serialize, no
  state-restore aliasing, no seam discontinuity, no step-index collision between a copied
  prefix and a live suffix. There is only one continuous re-driven run with one counter.
- "No redoing steps 0..k-1" still holds in the sense that *matters*: the LLM is never
  re-called and tools never re-fire for the prefix — those values are served. Re-running
  the agent's cheap glue code is what makes determinism provable.

## 3. Determinism is the product

A replay that isn't bit-identical pre-fork is a bug, enforced by tests. Getting there
meant defeating a list of traps — several surfaced by adversarial red-teams *before* and
*after* the code was written.

- **One canonical representation: sorted-key JSON.** It is the source of truth for
  cloning, hashing, on-disk form, and comparison. The naive canonicalizer
  `JSON.stringify(obj, sortedKeys)` is a footgun: the replacer-array form is an allowlist
  applied at *every* depth, silently deleting nested keys and producing a **false**
  bit-identical pass. The engine uses a true recursive key-sorter instead.
- **State is JSON, validated at every snapshot.** `structuredClone` preserves
  `Date`/`Map`/`Set`/`undefined`/`NaN`; JSON drops or mangles them. Mixing the two is how
  an engine reports "identical" while state has diverged. Snapshots use a JSON round-trip
  after a strict validation that *rejects* non-JSON values with a located error — so the
  in-memory and on-disk forms are byte-identical by construction.
- **The nondeterminism oracle is strict.** The agent may only draw time/randomness/ids
  from `io.ctx`. In record those draws are logged; on replay they're served from the log
  with a cursor that asserts the requested *kind* matches the recorded kind and throws a
  diagnosable `nondeterminism desync` rather than silently returning `undefined`. Draws
  made *inside* a served tool body (which doesn't re-execute) are reconstructed by the
  recorder, in recorded order.
- **Per-step system prompt on replay.** A subtle one the review caught: a *forked* trace
  records the original prompt in its prefix and the mutated prompt in its suffix. Replay
  must serve each step's *own* recorded system prompt, not one flat config value — else
  replaying a saved fork desyncs. So a fork is itself fully replayable.

"Bit-identical" is adjudicated over the *behavioral* content of a trace (config, input,
steps, nondeterminism, status, cost, final), excluding two classes of field: envelope
metadata (id, timestamps) that is legitimately unique per run, and per-step runtime
annotations (`executionMode`, `simulated`) that legitimately differ between a recorded
step and the same step replayed.

## 4. Side-effect soundness

You cannot faithfully re-run a real side effect. Once an email is sent, replaying it
would re-send. This is the heart of the design, and it is enforced by *kind*, not by hope.

Every tool declares `kind: read_only | idempotent | side_effecting`. The policy is region-
and kind-aware and decided at runtime — never copied from the recording:

| context | read_only / idempotent | side_effecting |
|---|---|---|
| **record** | execute (real) | execute (real) — the only time the effect fires |
| **replay / fork prefix** | served from recording | served, labeled **SIMULATED** |
| **fork suffix** (divergent) | execute live | **SIMULATED** (synthesized), never executed |

A divergent forked agent can emit a brand-new side-effecting call the recording never
knew about. The kind-based interception fires *before* any recording lookup or live-exec
fallback, so that call can't slip through to a real send. Belt-and-suspenders:

- An **execution trap** — during replay/fork, a side-effecting tool's real `run` is
  unreachable; if it were ever reached the engine throws. The test asserts the real fn's
  call count stays flat across replay/fork.
- The side-effect **sink is injected**, never hard-coded. The real file (outbox/tickets)
  is reachable only in record mode; replay/fork wire an in-memory sink.

The trace splits two facts that are easy to conflate: `wasRealEffect` (immutable — did
the effect truly fire at record time) is part of the identity; `executionMode` /
`simulated` (recorded vs replayed vs simulated vs live) are runtime annotations excluded
from the bit-identical check.

**Opt-in live re-execution.** Live re-firing is the explicit, dangerous escape hatch the
SPEC calls for: `liveReplay` / `liveTools` make a side-effecting tool *actually* run in
the fork suffix (flagged `executionMode: 'live'`). It is scoped to the fork suffix only —
the serve region is always served, so default replay stays bit-identical no matter what.

## 5. The trace model and the fork seam

`Trace = { id, parentId, fork?, config, input, steps[], nondeterminism[], status, cost, final }`,
all zod-validated at every boundary. Config is first-class so "same input, different
config" is directly diffable (the basis for regression, later).

Fork mechanics hinge on a **live-flip at step *k***. The flip happens *at* the k-th
primitive call, not before it — so nondeterminism draws *leading into* step k are still
served and `stateBefore[k]` (the state entering the fork point) is preserved exactly;
divergence begins precisely at step k's execution. The prefix check asserts steps `[0,k)`
*and* `stateBefore[k]` are byte-identical between original and fork — the "restore the
state at k" guarantee, made explicit.

## 6. How correctness was earned

- **Adversarial red-team of the design**, before any code: four lenses (bit-identical,
  fork-soundness, side-effects, contract) that reshaped the engine — the canonicalizer
  footgun, the clone-vs-JSON split, cursor drift, and the side-effect-in-fork hole were
  all closed before line one.
- **Adversarial review of the implementation**, find→verify, after each phase. It caught
  real bugs the author missed — most notably that a *saved fork was unreplayable*, and
  (in the daemon) a wildcard-CORS hole letting any visited web page read traces from the
  unauthenticated localhost daemon.
- **Determinism-edge probes** as permanent regression tests: trailing draws, interleaved
  internal/leading draws, side-effecting internal draws, and fork-boundary state.

## 7. Views over the engine

- **`@glassbox/engine`** — the pure, headless, zod-validated core: trace model, the
  inline-io contract + a tool-loop adapter, the Anthropic SDK adapter, a SQLite store, and
  a generic CLI. The integration surface is small (see `INTEGRATION.md`).
- **`@glassbox/daemon`** — a localhost REST API over the engine, with a local-first guard
  (no wildcard CORS; rejects non-localhost Host and cross-origin requests).
- **`apps/web`** — a Next.js debugger: scrub a recorded run's timeline, inspect any step,
  Replay for a `bit-identical ✓`, and Fork — edit a prompt at a step and watch the
  divergent branch render side by side, with side effects SIMULATED.

Two demo agents (research-emailer, support-triage) run on the engine with no engine
changes between them — the contract, not the engine, is what each agent customizes.

## 8. What's next

The engine is the hard part; the rest is consequence. Evals are batch-record + scoring; a
regression gate is replay-with-variation, diffed; an MCP firewall is the capture layer
with policy at the same chokepoint. Each is a view over the same record-replay-fork atom.

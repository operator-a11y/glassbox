# Glassbox — Spec
*(working name)*

## One line

An agent-development tool built on deterministic **record-replay-fork** of an agent run. Record everything an agent does, replay it exactly, fork from any step to explore counterfactuals. Debugging, security, evals, regression, and probes are all views over that one engine.

## The problem

When an agent misbehaves — wrong tool call, hallucinated argument, a doomed multi-step path — you can't set a breakpoint and step through it. It's long-running, stochastic, and stateful, so today you re-run and pray it reproduces, or squint at a giant log. There's no reproducibility and no inspectability for a stochastic, side-effecting process. That's the gap.

## The core capability (the atom)

**Record → Replay → Fork.**

- **Record** a run: capture every LLM call (prompt + completion), every tool/MCP call (args + result), the agent's state at each step, and every other source of nondeterminism (timestamps, seeds).
- **Replay** it deterministically: re-drive the agent, feeding recorded values back, reproducing the run bit-identically (the LLM is not re-called).
- **Fork** from any step: restore the state at step *k*, edit something (the system prompt, a tool's returned value), and replay *forward from k only* — re-calling the LLM at/after the fork to get a divergent but valid continuation. No redoing steps 0…k-1.

Everything else in Glassbox is a view over this. Nail the engine and the rest is consequence.

## Soundness: side effects (first-class, not a footnote)

You cannot faithfully re-run a real side effect — once an email was sent or a card charged, replaying it would re-send or re-charge. So:

- On replay/fork, **side-effecting tools are served from the recording** (mock) and clearly labeled SIMULATED downstream of the fork.
- **Live re-execution is opt-in and explicit**, per tool, with a visible warning.
- Idempotent/read-only tools can be re-executed live safely; the engine distinguishes tool kinds (`read_only | idempotent | side_effecting`).

Handling this correctly is the heart of the design — and the clearest signal of engineering judgment.

## The substrate

### Instrumentation layer

One layer both *captures* and (later) *guards*:

- **LLM wrapper** — wraps the model client; every completion emits a Step. In replay mode it returns the recorded completion.
- **Tool dispatcher wrapper / MCP-aware proxy** — records every tool/MCP call (server, args, result, kind); is also the enforcement point for the firewall pillar later. Same chokepoint, two jobs.
- **State capture** — each Step snapshots the agent's working state so a run is resumable from any point.

### Integration contract (small on purpose)

Glassbox records agents expressed in a **resumable** shape:

- a step function `(state, input) -> (state, action)`, or
- a supported framework loop (the Anthropic SDK agent loop first; LangGraph-Python via a future adapter).

You instrument once: wrap the client + run your agent through the Glassbox runner. Arbitrary free-form `while` loops are a later concern; structured agents come first.

### The Trace (the engine's output)

```
Trace = { id, agent, config { model, system_prompt_hash, toolset }, steps[], status, cost }
Step  = { idx, type (llm | tool | state), input, output, state_snapshot,
          nondeterminism { ts, seed, ... }, tool_kind?, tokens, latency, flags }
```

Config is first-class so "same input, different config" is directly diffable (the basis for regression).

## Capabilities as views over the engine

1. **Debugger (the centerpiece — build first).** Scrub a recorded run step by step, inspect exact state, and fork-and-replay from any step. This is the demo.
2. **MCP firewall / observability (pillar 2 — de-risked pivot).** The capture layer with teeth: a live tool-call feed + policy enforcement + injection/secret scanning at the boundary. The most novel and self-contained pillar; if the resumability engine proves too hard solo, this becomes the centerpiece.
3. **Evals.** Auto-generate a task suite, run the agent across it (= many traces), score each (assertions + LLM-judge rubric), heatmap failures. Evals = batch record + scoring.
4. **Regression gate.** A case library with golden traces; on any config change, re-run and **diff traces** old vs new, PR-style, to gate the change. Regression = replay-with-variation, diffed. (Subsumes prompt-regression-diff.)
5. **Probes (later flourish — reframed).** Attach a small scoped agent to a **hookable runtime event** (function / step / tool boundary), not a static source line. Modes: watch/assert, guard, explain, intervene, investigate. "Highlight code" is sugar that maps a selection to the nearest instrumented hook. Read-only probes (watch / explain / guard-flag) are sound; mutating probes need sandboxing and sit inside the trust boundary, so they come last.

## Deployment model

- **SDK** — importable TS library; wraps the LLM client + tool dispatcher, runs your agent, emits traces. The only part inside your code.
- **Daemon (`glassbox dev`)** — local Node service; stores traces (SQLite), orchestrates replay/fork, serves the web app + API. Localhost only; nothing leaves the machine.
- **Web app** — Next.js debugger UI over the daemon API.
- **Editor extension (later)** — a thin VS Code/Cursor webview embedding the *same* web app, adding native text-selection for probes. Not a separate product, and never a forked IDE.

Local-first, web-first, extension-second.

## Positioning

What Chrome DevTools, Sentry, CI, and a WAF are for web apps, this is for agents — and those barely exist for agents yet. Observability/evals have players (LangSmith, Langfuse, Braintrust, Arize, Helicone); what's open and differentiated here is (a) an interactive **fork-and-replay** debugger (most tools are read-only viewers), (b) the **MCP security** layer (essentially unclaimed, and MCP is exploding), and (c) the whole thing built on one record-replay engine. Frame: a portfolio centerpiece that could seed a startup; the wedge is debugger + firewall, depth over breadth.

Lineage: this is the superset of **Agent Canvas** (visual agent debugging) and **SelfQA** (the agent eval loop), fused and extended with security — one coherent platform story.

## Name

Working name **Glassbox** (turn the black box transparent). Alternatives: Tracepoint, Forkpoint, Replay, Probe, Lucent. Easy to change.

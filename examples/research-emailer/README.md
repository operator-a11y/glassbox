# research-emailer — Glassbox Phase-0 demo

A structured agent that proves the Glassbox thesis end to end:

> **record → bit-identical replay → fork (edit the prompt) → divergent-but-valid continuation**,
> with the side-effecting tool **served from the recording (SIMULATED)** on replay/fork and
> **never re-fired**.

The agent does real multi-step tool use:

```
topic → search → read → draft summary → send_email (side-effecting) → confirm
```

7 recorded steps: `llm → tool search → llm → tool read → llm → tool send_email → llm`.

## Run it

From the repo root:

```bash
pnpm i
pnpm record    # run live, write the trace, append the real email to outbox.json
pnpm replay    # replay; assert bit-identical; prove the email was SIMULATED, not re-sent
pnpm fork      # fork at the draft step with an edited TONE; show the divergent email
pnpm demo      # all three, end to end
pnpm exec tsx examples/research-emailer/src/cli.ts steps   # list steps + fork hints
```

`fork` takes optional flags:

```bash
pnpm fork --step 4 --system "…TONE: formal"
```

### Offline by default, real model when you have a key

- **No `ANTHROPIC_API_KEY`** → a deterministic, prompt-conditioned **stub model** is used. It is
  fully offline and still diverges on a prompt edit (the stub reads the `TONE:` directive), so the
  whole thesis is demonstrable with zero setup.
- **With `ANTHROPIC_API_KEY`** → `record` and the **fork suffix** call the real model
  (`GLASSBOX_MODEL_ID`, default `claude-sonnet-4-6`). Replay never calls the model at all.

## What each command proves

| Command  | What it demonstrates |
|----------|----------------------|
| `record` | A live run is captured: every LLM output, every tool call + result, per-step state, and all nondeterminism (a `runId`/`startedAt` from the agent, the email's `messageId`/`sentAt`). The real email is appended to `outbox.json` **once**. |
| `replay` | The run is re-driven and is **bit-identical** to the recording. The LLM is **not re-called** (the harness passes a client that throws if invoked). The `send_email` step is **served from the recording, labeled SIMULATED**, and `outbox.json` is **unchanged**. |
| `fork`   | Restores the state at step *N* by re-driving, swaps in an edited system prompt, and runs **live from step N only**. Steps `0..N-1` are **byte-identical** to the original; the continuation **diverges** (a differently-toned email); the `send_email` step is **SIMULATED** even though its arguments are new, and `outbox.json` is still **unchanged**. |

Example fork output (stub model, `TONE: neutral → enthusiastic`):

```
▶ # 4 llm   [recorded ] → calls send_email        # 4 llm   [live     ] → calls send_email
≠ # 5 tool  [recorded ] send_email SIMULATED…     # 5 tool  [simulated] send_email SIMULATED…
≠ # 6 llm   [recorded ] → "Done …"                # 6 llm   [live     ] → "Done …"

EMAIL DIVERGENCE (the side-effecting step):
  original (SENT)       "Summary: transformer models"
  forked   (SIMULATED)  "🎉 Exciting findings on transformer models"
```

## How it maps to the engine

- The agent is written in the engine's **inline-io** shape: it `await`s `io.model.complete(...)` and
  `io.tools.run(...)` and mutates `io.state`. The engine records a step at each wrapped call and
  re-drives this same function to replay/fork — so resumption needs no hand-written continuation.
- The system prompt is **injected by the engine**, never baked into the messages, so a fork mutation
  actually reaches the next model call.
- `send_email` is `kind: 'side_effecting'`: its real implementation is reachable **only in record
  mode**, its result is **served (SIMULATED)** on replay, and on a divergent fork it is **synthesized
  without performing the effect**. The outbox sink is injected (real file at record, in-memory
  otherwise) as a second, independent guarantee.

See [`../../SPEC.md`](../../SPEC.md) for the full picture and [`../../packages/engine`](../../packages/engine)
for the engine.

# Probes

A probe is a scoped check attached to a runtime event. Glassbox ships the **sound**
modes — read-only `watch` / `assert` over a recorded trace — plus the one a
record-replay-fork engine is uniquely able to offer: **`investigate`**, a
fork-to-counterfactual. (Mutating / intervening probes need sandboxing and live inside
the trust boundary, so they come later.)

## investigate — the fork-to-counterfactual

Pose a *"what if I changed X at step k?"* question. `investigate` forks the trace at k
with the mutation, re-runs live from there, and reports **both** how behavior diverged
(the regression diff) **and** how the security picture changed (firewall findings
resolved / introduced / severity-changed):

```bash
pnpm glassbox investigate --trace <id> --system "You are Support-Triage. STYLE: standard. REDACT secrets from tickets."
# investigate <id> → <fork>   (fork at step #0, edited prompt)
#   behavior: 2 step change(s)
#   ⤓ downgraded: possible exfiltration: Anthropic API key in args of side-effecting tool "create_ticket"  (critical → high)
```

That output is the whole pitch in three lines: adding a redaction instruction **stops the
critical exfiltration** (the key no longer reaches the side-effecting `create_ticket`),
and the firewall is honest that a **residual high** remains (the secret still reaches a
read-only tool — you can't un-type the user's input). No other agent tool can answer a
counterfactual like this offline, because no other tool can fork a recorded run.

It is pure composition over proven pieces: `runAgent` (fork) + `compareRuns` (the
regression diff) + `scanTrace` (the firewall), correlated by finding identity.

## watch / assert — read-only probes

```bash
pnpm glassbox probe --trace <id>
# probe <id>: 4 passed, 0 failed
#   · #5 watch:tool-calls            create_ticket (side_effecting) [recorded]
#   ✓ #5 assert:side-effects-tracked create_ticket: wasRealEffect=true simulated=false
#   ✓ #5 assert:args<50000           262 chars
```

A probe is `{ name, on, mode, when?, run }` — a check at a step boundary; `watch` records
an observation, `assert` records a pass/fail. `runProbes(trace, probes)` is pure and
deterministic over the recorded trace. Built-ins: `watchToolCalls`, `assertSideEffectsTracked`,
`assertArgsUnder`. Write your own — including ones that compose with the firewall or evals.

## Why this is sound

`runProbes` and `investigate` never touch the engine's determinism: probes read a recorded
trace; `investigate` forks (which the engine already isolates) and only *reads* the
resulting traces. The novel power — counterfactual behavior + security analysis — falls
out of record-replay-fork for free.

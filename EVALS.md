# Evals + regression gate

Once you can record and replay deterministically, two things fall out almost for free:
a **regression gate** (replay-with-variation, diffed) and an **eval suite** (batch record
+ scoring). `@glassbox/evals` is both, assembled over the engine.

## Regression gate — `compareRuns`

You have a **golden** trace (a known-good run). You change something — usually the system
prompt — and want to know what that did to the agent's *behavior*, without re-reading a
giant log. Re-run the same input with the variation and diff:

```bash
pnpm glassbox regress --trace <golden-id> --system "You are Support-Triage. STYLE: urgent"
# regress <golden> → <candidate>   (edited system prompt)
#   3 step change(s), final changed; cost +0 tokens
#   ≠ #4  llm → create_ticket  →  llm → create_ticket
#   ≠ #5  tool create_ticket   →  tool create_ticket
#   ≠ #6  llm → "Triaged c-9's standard ticket…" → llm → "Triaged c-9's urgent ticket…"
#   FAIL — behavior changed (gate)        # exit code 1
```

The diff is **semantic**: it compares the agent's tool-call decisions, the args it passed,
and the final answer — and deliberately ignores per-run nondeterminism (uuids, timestamps,
state snapshots, tool_use ids) that differs between any two live runs. So it surfaces real
behavior changes, not noise. Exit code is nonzero on any change, which makes it a drop-in
**PR gate**: pin a golden trace per scenario, and a prompt edit that changes behavior fails CI.

Re-running with no `--system` (same config) should diff clean — a "did anything drift?" check.

## Eval suite — `runEvals`

A case is an input plus assertions over the resulting trace:

```ts
import { runEvals, toolCalled, statusIs, finalContains } from '@glassbox/evals';

const report = await runEvals({ agent, client, modelId, cases: [
  { name: 'researches and emails', input: { topic: 'x', recipient: 'a@b.com' },
    assertions: [toolCalled('search'), toolCalled('send_email'), statusIs('completed'), finalContains('Done')] },
]});
// report.ok / report.passed / per-case checks
```

```bash
pnpm glassbox eval --agent support-triage
# eval support-triage: 2/2 cases passed
#   ✓ classifies and files a ticket
#   ✓ firewall catches a leaked key flowing into the filed ticket
```

Built-in assertions: `toolCalled` / `toolNotCalled`, `noRealSideEffects`, `finalContains` /
`finalNotContains`, `statusIs`, `stepCountIs`, `costUnder`. An assertion is just
`(trace) => Check`, so you can write your own — including ones that compose with the
firewall (`scanTrace(trace).some(f => f.severity === 'critical')`), as the support-triage
suite does to assert exfiltration is caught.

## Why it's nearly free

The regression gate is `runAgent` (fork-with-variation) + a semantic diff; evals are
`runAgent` (record) + pure assertion functions. Both are assembly over the proven engine —
no new determinism surface, no new trust boundary. Config is first-class in the trace, so
"same input, different config" is directly diffable.

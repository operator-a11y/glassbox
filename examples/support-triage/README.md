# support-triage — Glassbox demo agent #2

A second structured agent, in a different domain from research-emailer, that runs on
the **same engine with no engine changes** — the Phase-1 exit criterion.

```
ticket → classify → lookup_customer → draft → create_ticket (side-effecting) → confirm
```

7 recorded steps. The side-effecting tool is `create_ticket` (writes to `tickets.json`).
The system prompt carries a `STYLE:` directive (`standard | urgent | friendly`) that the
deterministic stub uses to flavor the filed ticket, so a fork that edits STYLE produces a
divergent-but-valid continuation offline.

## Run it via the glassbox CLI

```bash
pnpm glassbox record --agent support-triage --input '{"customer":"c-42","ticket":"login is broken, cannot access account"}'
pnpm glassbox replay --trace <id>
pnpm glassbox fork   --trace <id> --step 4 --system "You are Support-Triage. STYLE: urgent"
```

`replay` is bit-identical and proves `create_ticket` is SIMULATED (served, never re-filed).
`fork` shows the ticket title/body diverge with the edited STYLE while steps 0–3 stay identical
and `tickets.json` is unchanged.

## What it shares with research-emailer

Nothing but the engine. It is built with the same `toolLoopAgent` adapter and the same
`ToolDefinition` contract — only the domain, tools, stub planner, and side-effecting tool differ.
That is the whole point: the record-replay-fork engine generalizes across agents.

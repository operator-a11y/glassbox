# Firewall — MCP security over the capture layer

The same chokepoint that records every tool call can also *guard* it. `@glassbox/firewall`
is that capture layer with teeth: it audits any recorded run, and (live) blocks
exfiltration and quarantines injected tool results — with **zero engine changes**.

It has two modes:

- **`scanTrace(trace)` — the source of truth.** A pure, deterministic offline audit of any
  recorded / replayed / forked trace. Same trace in → byte-identical findings out. This is
  what the daemon `/scan` endpoint, the `glassbox scan` CLI, and the UI panel all use.
- **`guard(tools, firewall)` — live enforcement.** Wraps an agent's tools to deny/quarantine
  in real time. Ephemeral; `scanTrace` remains the durable record.

## What makes it signal, not theater: data-flow direction

A regex that just shouts "secret found" is noise. Severity is scored by *where the value is
flowing*, which the trace already tells us:

| finding | where | severity |
|---|---|---|
| secret in a **side-effecting tool's args** | leaving the machine | **critical** (exfiltration) |
| secret in the system prompt / final output | exposed | high |
| secret merely **read** from a `read_only` result | contained | medium |
| prompt-injection in a **tool result** | the MCP hijack | high |
| prompt-injection in a **tool description** | malicious server | high |
| prompt-injection in the **user's own turn** | expected | low |

And the detection this engine is uniquely positioned for — **taint flow**: an untrusted
`read_only` tool result whose content reappears in a `side_effecting` argument and was *not*
in the user's input (the read-it-here, send-it-there exfiltration/injection chain).

## Detections

- **Secrets** — a high-confidence prefixed tier (`sk-ant-`, `sk-proj-`, `ghp_`, `AKIA`,
  `xoxb-`, JWT, PEM private keys) plus an entropy-gated tier for unknown formats. Engine-minted
  uuids (from `trace.nondeterminism`) are suppressed; git SHAs / UUIDs / hashes are excluded.
- **Prompt injection** — a normalized phrase pass (defeating whitespace / case / zero-width /
  NFKC evasions) plus role-impersonation markers. Explicitly **best-effort**, not a complete filter.
- **Taint** — untrusted-result → side-effecting-sink flow.

Two properties are invariant-tested: **redaction never echoes a secret** (findings carry only a
type label + length + an 8-hex sha256 prefix — no substring of the value), and the scanners are
**ReDoS-safe** (a megabyte pathological input can't hang them).

## Use it

```bash
# audit any recorded trace
pnpm glassbox scan --trace <id>
# → [CRITICAL] secret  possible exfiltration: Anthropic API key in args of side-effecting tool "create_ticket"
#               /steps/5/input   Anthropic API key ⟨len 41, sha256:bdb1720c⟩

# in the UI: the "Firewall" panel on every trace, severity-coded, linked to steps
pnpm dev
```

```ts
// live enforcement at the agent's tool layer
import { createFirewall, guard } from '@glassbox/firewall';
const tools = guard(myTools, createFirewall(), (event) => liveFeed.push(event));
// a secret in a side-effecting arg → the tool is blocked (no side effect);
// an injected tool result → withheld from the model; clean results pass byte-identical.
```

## Why it's sound

`scanTrace` is pure over data the trace already carries, so it covers recorded, replayed, and
forked traces uniformly and never affects engine determinism. `guard` inspects deep clones, so an
allowed result reaches the agent byte-identical — replay stays bit-identical. A denied/quarantined
result is recorded as the tool's output and served back on replay like any other step.

This design was red-teamed across four lenses (scanTrace determinism/coverage, scanner
accuracy/ReDoS, live-guard soundness, threat-model realism) *before* implementation, then the
implementation was adversarially reviewed.

# Integration contract

Glassbox records agents written in one small, resumable shape. You instrument once
and get record → bit-identical replay → fork for free. There are two layers: the
**raw contract** (maximum control) and the **tool-loop adapter** (the common case,
config-only).

## The raw contract

An agent is an inline-io async function:

```ts
type AgentFn = (io: AgentIO) => Promise<JsonValue>; // returns the run's `final`

interface AgentIO {
  readonly input: JsonValue;       // the run input
  readonly state: JsonObject;      // mutable working state — MUST stay plain JSON
  readonly model: WrappedModel;    // await io.model.complete({ messages, tools, maxTokens })
  readonly tools: WrappedTools;    // await io.tools.run(name, args)
  readonly ctx: ToolContext;       // io.ctx.now() / random() / uuid() — the ONLY nondeterminism
}

interface AgentDefinition {
  name: string;
  systemPrompt: string;            // injected by the engine at every model call
  tools: ToolDefinition[];
  run: AgentFn;
}
```

Four rules — follow them and replay is bit-identical by construction:

1. **State is plain JSON.** `io.state` may hold only objects, arrays, strings, finite
   numbers, booleans, and null. No `Date`, `Map`, `Set`, `undefined`, `NaN`, functions.
   The engine validates this at every snapshot and fails loudly otherwise.
2. **All nondeterminism comes from `io.ctx`.** Use `io.ctx.now()/random()/uuid()` —
   never `Date.now()`/`Math.random()` directly. Those draws are recorded and served
   back on replay.
3. **Never pass a system prompt.** Call `io.model.complete({ messages, tools, maxTokens })`
   without `system`; the engine injects the configured (or forked) prompt so a fork
   mutation actually reaches the model.
4. **Side effects go through a tool.** Declare a `kind` per tool
   (`read_only | idempotent | side_effecting`). Side-effecting tools run for real only
   at record time; on replay/fork they are served or synthesized (SIMULATED).

```ts
interface ToolDefinition {
  name: string;
  kind: 'read_only' | 'idempotent' | 'side_effecting';
  run(args: JsonValue, ctx: ToolContext): JsonValue | Promise<JsonValue>;
  simulate?(args: JsonValue, ctx: ToolContext): JsonValue | Promise<JsonValue>; // fork suffix
  liveReplay?: boolean; // opt in to real re-execution on replay/fork (see below)
}
```

## The tool-loop adapter (the common case)

Most agents are the same loop. `toolLoopAgent` writes it for you, so a new agent is
pure configuration — no hand-written resumption, no engine changes:

```ts
import { toolLoopAgent } from '@glassbox/engine';

const agent = toolLoopAgent({
  name: 'my-agent',
  systemPrompt: '…',
  tools: [ /* ToolDefinition[] */ ],
  toolSchemas: [ /* Anthropic Messages tool schemas */ ],
  userMessage: (input) => `…build the first user message from ${JSON.stringify(input)}…`,
  finalize: (text) => ({ result: text }), // optional: shape the trace's `final`
});
```

The adapter draws a `runId`/`startedAt` from `ctx` at the top (captured nondeterminism)
and bounds the loop (`maxTurns`) so a divergent fork always terminates.

## Running it

```ts
import { runAgent } from '@glassbox/engine';

const { trace } = await runAgent({ agent, input, mode: { kind: 'record' }, client, modelId });
const replay  = await runAgent({ agent, input, mode: { kind: 'replay' }, client, source: trace, modelId });
const forked  = await runAgent({ agent, input, source: trace, modelId,
  mode: { kind: 'fork', fromStep: k, mutation: { system: editedPrompt } } });
```

`client` is any `ModelClient` (the real Anthropic adapter, or a deterministic stub).
On replay the model is never called. See `examples/` for two complete agents and the
generic `glassbox` CLI that drives record / list / replay / fork over a trace store.

## Per-tool live re-execution (opt-in)

By default every tool is served from the recording on replay/fork (so replay is
bit-identical and side effects never re-fire). A tool may opt in to **real
re-execution** with `liveReplay: true` (or per-run `liveTools: ['name']`). This is the
explicit, visible escape hatch the SPEC calls for — useful for genuinely idempotent
reads you want fresh — and it means replay is no longer bit-identical for that tool.
Live-re-executed steps are flagged so the divergence is never silent.

# Glassbox debugger (web)

A Next.js 16 (App Router + Tailwind 4) debugger UI over the local daemon. It is a
**thin client** — it imports no engine code; every value comes from the daemon's
REST API, proxied through `/api/*` (see `next.config.ts`).

## Run

From the repo root:

```bash
pnpm dev        # daemon on :4319 + web on http://localhost:3000
```

Then open <http://localhost:3000>:

1. **Record** — pick an agent, edit the JSON input, hit Record.
2. **Open a trace** — scrub the **timeline**; the **step inspector** shows each
   step's prompt / messages / completion (or tool args + result), state before &
   after, captured nondeterminism, and `executionMode`.
3. **Replay** — one click; shows `bit-identical ✓` (the LLM is not re-called).
4. **Fork & replay** — select a step, edit the system prompt, **Fork**. You get a
   side-by-side diff of the divergent branch: `▶` fork point, `≠` divergence,
   `SIMULATED` side effects, and a link to open the new branch.

Point at a non-default daemon with `GLASSBOX_DAEMON_URL`.

## How it fits

```
browser ──/api/*──▶ Next (rewrite) ──▶ daemon (REST) ──▶ @glassbox/engine
```

The engine and daemon are pure TS run via tsx; the web app bundles only React +
the typed `lib/api.ts` client. See `../../packages/daemon` and `../../packages/engine`.

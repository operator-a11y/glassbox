/**
 * The local Glassbox daemon — a small node:http REST API over the engine.
 *
 * It owns the trace store and orchestrates record / replay / fork; the web app is
 * a thin client over this API. Localhost only, no auth, nothing leaves the machine.
 * Replay uses a throwing model client so a bug that re-calls the LLM fails loudly.
 *
 *   GET  /api/health
 *   GET  /api/agents
 *   GET  /api/traces
 *   GET  /api/traces/:id
 *   GET  /api/traces/:id/forks
 *   POST /api/record                 { agent, input }
 *   POST /api/traces/:id/replay
 *   POST /api/traces/:id/fork         { fromStep, system?, liveTools? }
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { comparePrefix, compareTraces, runAgent } from '@glassbox/engine';
import type { AgentRegistration, JsonValue, ModelClient, Trace, TraceStore } from '@glassbox/engine';

export interface DaemonConfig {
  agents: Record<string, AgentRegistration>;
  store: TraceStore;
}

export interface Daemon {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const throwingClient: ModelClient = {
  async complete() {
    throw new Error('replay must not call the model — the recorded completion should be served instead');
  },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createDaemon(config: DaemonConfig): Daemon {
  const server = createServer((req, res) => {
    handle(config, req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : isZodError(err) ? 400 : 500;
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, status, { error: message });
    });
  });

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function handle(config: DaemonConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const seg = path.split('/').filter(Boolean); // e.g. ['api','traces',':id']
  const method = req.method ?? 'GET';

  if (seg[0] !== 'api') throw new HttpError(404, `not found: ${path}`);

  // /api/health
  if (method === 'GET' && seg.length === 2 && seg[1] === 'health') {
    return sendJson(res, 200, { ok: true });
  }
  // /api/agents
  if (method === 'GET' && seg.length === 2 && seg[1] === 'agents') {
    return sendJson(res, 200, { agents: Object.keys(config.agents) });
  }
  // /api/traces
  if (method === 'GET' && seg.length === 2 && seg[1] === 'traces') {
    return sendJson(res, 200, { traces: config.store.list() });
  }
  // /api/record
  if (method === 'POST' && seg.length === 2 && seg[1] === 'record') {
    return record(config, await readBody(req), res);
  }
  // /api/traces/:id  and  /api/traces/:id/(forks|replay|fork)
  if (seg.length >= 3 && seg[1] === 'traces') {
    const id = decodeURIComponent(seg[2]!);
    const sub = seg[3];
    if (method === 'GET' && seg.length === 3) {
      const trace = config.store.get(id);
      if (!trace) throw new HttpError(404, `no trace ${id}`);
      return sendJson(res, 200, { trace });
    }
    if (method === 'GET' && sub === 'forks' && seg.length === 4) {
      return sendJson(res, 200, { traces: config.store.listForks(id) });
    }
    if (method === 'POST' && sub === 'replay' && seg.length === 4) {
      return replay(config, id, res);
    }
    if (method === 'POST' && sub === 'fork' && seg.length === 4) {
      return fork(config, id, await readBody(req), res);
    }
  }

  throw new HttpError(404, `not found: ${method} ${path}`);
}

async function record(config: DaemonConfig, body: JsonValue, res: ServerResponse): Promise<void> {
  const { agent: agentName, input } = asObject(body);
  if (typeof agentName !== 'string') throw new HttpError(400, '`agent` (string) is required');
  const reg = config.agents[agentName];
  if (!reg) throw new HttpError(400, `unknown agent "${agentName}" (have: ${Object.keys(config.agents).join(', ')})`);

  const agent = reg.build();
  if (agent.name !== agentName) {
    throw new HttpError(500, `agent "${agentName}" builds as "${agent.name}"`);
  }
  const sel = await reg.client();
  const { trace } = await runAgent({ agent, input: input ?? {}, mode: { kind: 'record' }, client: sel.client, modelId: sel.modelId });
  config.store.save(trace);
  sendJson(res, 200, { trace });
}

async function replay(config: DaemonConfig, id: string, res: ServerResponse): Promise<void> {
  const original = config.store.get(id);
  if (!original) throw new HttpError(404, `no trace ${id}`);
  const reg = config.agents[original.config.agent];
  if (!reg) throw new HttpError(409, `agent "${original.config.agent}" is not registered`);

  const { trace: replayed } = await runAgent({
    agent: reg.build(),
    input: original.input,
    mode: { kind: 'replay' },
    client: throwingClient,
    modelId: original.config.model,
    source: original,
  });
  const cmp = compareTraces(original, replayed);
  sendJson(res, 200, { identical: cmp.identical, differences: cmp.differences, trace: replayed });
}

async function fork(config: DaemonConfig, id: string, body: JsonValue, res: ServerResponse): Promise<void> {
  const original = config.store.get(id);
  if (!original) throw new HttpError(404, `no trace ${id}`);
  const reg = config.agents[original.config.agent];
  if (!reg) throw new HttpError(409, `agent "${original.config.agent}" is not registered`);

  const o = asObject(body);
  const fromStep = typeof o['fromStep'] === 'number' ? o['fromStep'] : defaultForkStep(original);
  const maxStep = original.steps.length - 1;
  if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep > maxStep) {
    throw new HttpError(400, `fromStep must be an integer in [0, ${maxStep}]`);
  }
  const system = typeof o['system'] === 'string' ? o['system'] : null;
  const liveTools = Array.isArray(o['liveTools']) ? o['liveTools'].filter((x): x is string => typeof x === 'string') : undefined;

  const sel = await reg.client();
  const { trace: forked } = await runAgent({
    agent: reg.build(),
    input: original.input,
    mode: { kind: 'fork', fromStep, mutation: { system } },
    client: sel.client,
    modelId: sel.modelId,
    source: original,
    ...(liveTools && liveTools.length ? { liveTools } : {}),
  });
  config.store.save(forked);
  const cmp = comparePrefix(original, forked, fromStep);
  sendJson(res, 200, { trace: forked, fromStep, prefixIdentical: cmp.identical, differences: cmp.differences });
}

function defaultForkStep(trace: Trace): number {
  const sideEffect = trace.steps.findIndex((s) => s.type === 'tool' && s.kind === 'side_effecting');
  if (sideEffect > 0) return sideEffect - 1;
  for (let i = trace.steps.length - 1; i >= 0; i--) if (trace.steps[i]!.type === 'llm') return i;
  return Math.max(0, trace.steps.length - 1);
}

// ---- http helpers -----------------------------------------------------------

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function asObject(v: JsonValue): { [k: string]: JsonValue } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'expected a JSON object body');
  return v;
}

function isZodError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ZodError';
}

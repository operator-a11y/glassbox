// Lightweight client over the daemon's REST API. The web app defines its own trace
// types (a subset it renders) so it stays fully decoupled from the engine package.

export type ToolKind = 'read_only' | 'idempotent' | 'side_effecting';
export type ExecutionMode = 'recorded' | 'replayed' | 'simulated' | 'live';

export interface Tokens {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmStep {
  idx: number;
  type: 'llm';
  input: { system: string; messages: unknown[]; tools: unknown[] };
  output: { content: unknown[]; stopReason: string };
  tokens: Tokens;
  latencyMs: number;
  stateBefore: unknown;
  stateAfter: unknown;
  executionMode: ExecutionMode;
}

export interface ToolStep {
  idx: number;
  type: 'tool';
  toolName: string;
  kind: ToolKind;
  input: unknown;
  output: unknown;
  wasRealEffect: boolean;
  simulated: boolean;
  latencyMs: number;
  stateBefore: unknown;
  stateAfter: unknown;
  executionMode: ExecutionMode;
}

export type Step = LlmStep | ToolStep;

export interface Draw {
  kind: 'now' | 'random' | 'uuid';
  value: number | string;
  stepIdx: number;
}

export interface TraceConfig {
  agent: string;
  model: string;
  systemPrompt: string;
  systemPromptHash: string;
  toolset: { name: string; kind: ToolKind }[];
  maxSteps: number;
}

export interface Trace {
  schemaVersion: number;
  id: string;
  parentId: string | null;
  fork: { fromStep: number; mutation: { system: string | null } } | null;
  createdAtIso: string;
  config: TraceConfig;
  input: unknown;
  steps: Step[];
  nondeterminism: Draw[];
  status: string;
  cost: { inputTokens: number; outputTokens: number; totalTokens: number };
  final: unknown;
}

export interface TraceSummary {
  id: string;
  parentId: string | null;
  agent: string;
  model: string;
  createdAtIso: string;
  status: string;
  steps: number;
}

export interface ReplayResult {
  identical: boolean;
  differences: string[];
  trace: Trace;
}

export interface ForkResult {
  trace: Trace;
  fromStep: number;
  prefixIdentical: boolean;
  differences: string[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(err ? (typeof err === 'string' ? err : JSON.stringify(err)) : `HTTP ${res.status}`);
  }
  return body as T;
}

export const listAgents = () => api<{ agents: string[] }>('/agents').then((r) => r.agents);
export const listTraces = () => api<{ traces: TraceSummary[] }>('/traces').then((r) => r.traces);
export const getTrace = (id: string) => api<{ trace: Trace }>(`/traces/${id}`).then((r) => r.trace);
export const listForks = (id: string) => api<{ traces: TraceSummary[] }>(`/traces/${id}/forks`).then((r) => r.traces);
export const record = (agent: string, input: unknown) =>
  api<{ trace: Trace }>('/record', { method: 'POST', body: JSON.stringify({ agent, input }) }).then((r) => r.trace);
export const replay = (id: string) => api<ReplayResult>(`/traces/${id}/replay`, { method: 'POST' });
export const fork = (id: string, opts: { fromStep?: number; system?: string | null; liveTools?: string[] }) =>
  api<ForkResult>(`/traces/${id}/fork`, { method: 'POST', body: JSON.stringify(opts) });

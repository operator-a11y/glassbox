/**
 * @glassbox/firewall — MCP firewall / observability over the capture layer.
 *
 * scanTrace(trace) is the source of truth: a pure, deterministic audit of any
 * recorded/replayed/forked trace for secrets, prompt-injection, and untrusted→sink
 * taint flow, scored by data-flow direction. The live guard adds real-time
 * enforcement (deny exfiltration, quarantine injected tool results).
 */

export type {
  Severity,
  FindingKind,
  Action,
  Provenance,
  FindingLocation,
  Finding,
  CallVerdict,
} from './types.ts';
export { compareFindings, severityRank } from './types.ts';

export { scanTrace, scanTraceResult } from './scan-trace.ts';
export type { ScanOptions, ScanResult } from './scan-trace.ts';

export { normalize, shannonEntropy } from './normalize.ts';
export { secretFingerprint, redactSecret, neutralizePhrase } from './redact.ts';

export { createFirewall } from './firewall.ts';
export type { Firewall, FirewallConfig, PolicyRule, ToolCall } from './firewall.ts';
export { guard } from './guard.ts';
export type { FirewallEvent } from './guard.ts';

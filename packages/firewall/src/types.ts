/**
 * Firewall types. A Finding is the unit of output for every surface (scanTrace,
 * the live guard, the daemon, the CLI, the UI). Its `match` is always REDACTED —
 * a finding must never re-leak the secret it reports.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type FindingKind = 'secret' | 'injection' | 'taint' | 'policy';
export type Action = 'allow' | 'flag' | 'deny';

/** Where the value flowed from — drives severity (a secret leaving via a
 *  side-effecting arg is far worse than one merely read). */
export type Provenance =
  | 'user-input'
  | 'config'
  | 'system'
  | 'tool-args'
  | 'tool-result'
  | 'tool-schema'
  | 'model-input'
  | 'model-output'
  | 'state'
  | 'final';

export interface FindingLocation {
  /** Step the finding was found in, or null for trace-level (input / final / config). */
  stepIdx: number | null;
  stepType?: 'llm' | 'tool';
  toolName?: string;
  /** RFC6901-style JSON Pointer into the trace, e.g. '/steps/4/output'. */
  pointer: string;
}

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** The rule/scanner that fired, e.g. 'secret.openai-key' or 'injection.ignore-instructions'. */
  rule: string;
  message: string;
  location: FindingLocation;
  provenance: Provenance;
  /** A REDACTED snippet — a secret hint (never the value) or a neutralized phrase. */
  match: string;
  /** Other pointers where the same secret appeared (cross-reference). */
  also?: string[];
}

export interface CallVerdict {
  action: Action;
  findings: Finding[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** Deterministic total order for stable output: severity, then location, then rule, then match. */
export function compareFindings(a: Finding, b: Finding): number {
  if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  const ai = a.location.stepIdx ?? -1;
  const bi = b.location.stepIdx ?? -1;
  if (ai !== bi) return ai - bi;
  if (a.location.pointer !== b.location.pointer) return a.location.pointer < b.location.pointer ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return a.match < b.match ? -1 : a.match > b.match ? 1 : 0;
}

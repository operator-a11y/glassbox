/**
 * scanTrace — the offline audit and the firewall's source of truth. Pure and
 * deterministic over the recorded trace: same trace in → byte-identical findings out.
 * It works uniformly on recorded, replayed, and forked traces.
 *
 * Severity is scored by DATA-FLOW DIRECTION, which is what separates signal from
 * theater: a secret in a side-effecting tool's args (leaving the machine) is
 * critical exfiltration; the same secret merely read is medium. An injection in a
 * tool result (the MCP hijack) is high; in the user's own turn it is expected (low).
 * The taint scanner adds the flow this engine is uniquely positioned to see: an
 * untrusted tool result reappearing in a side-effecting argument.
 */

import type { Trace } from '@glassbox/engine';
import type { Finding, FindingLocation, Severity } from './types.ts';
import { compareFindings, severityRank } from './types.ts';
import { normalize } from './normalize.ts';
import { neutralizePhrase, redactSecret, secretFingerprint } from './redact.ts';
import { scanSecrets } from './secret-scan.ts';
import { scanInjections } from './injection-scan.ts';
import { collectSurface } from './walk.ts';
import type { Surface } from './walk.ts';

export interface ScanOptions {
  maxFindings?: number;
}

export interface ScanResult {
  findings: Finding[];
  truncated: boolean;
}

const DEFAULT_MAX_FINDINGS = 1000;
const MAX_UNTRUSTED = 500;

interface Candidate {
  dedupKey: string;
  sev: Severity;
  finding: Finding;
}

export function scanTrace(trace: Trace, options: ScanOptions = {}): Finding[] {
  return scanTraceResult(trace, options).findings;
}

export function scanTraceResult(trace: Trace, options: ScanOptions = {}): ScanResult {
  const maxFindings = options.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const surfaces = collectSurface(trace);

  // Engine-minted ids (runId, messageId, …) are recorded nondeterminism, not secrets.
  const engineIds = new Set<string>();
  for (const d of trace.nondeterminism) if (d.kind === 'uuid' && typeof d.value === 'string') engineIds.add(d.value);

  const userInputText = normalize(
    surfaces.filter((s) => s.provenance === 'user-input').flatMap((s) => s.leaves).join('\n'),
  );

  const candidates: Candidate[] = [];

  for (const s of surfaces) {
    const text = normalize(s.leaves.join('\n'));
    // Entropy tier on the '\n' join (no cross-leaf artifacts); prefixed detectors also on a
    // separator-free join so a distinctive key split across adjacent leaves is still caught.
    const joined = normalize(s.leaves.join(''));
    const secretMatches = [...scanSecrets(text), ...scanSecrets(joined, { entropy: false })];

    for (const m of secretMatches) {
      if (engineIds.has(m.secret)) continue;
      const sev = secretSeverity(s);
      candidates.push({
        dedupKey: `secret:${secretFingerprint(m.secret)}`,
        sev,
        finding: {
          kind: 'secret',
          severity: sev,
          rule: `secret.${m.rule}`,
          message: secretMessage(s, m.label),
          location: locationOf(s),
          provenance: s.provenance,
          match: redactSecret(m.secret, m.label),
        },
      });
    }

    for (const m of scanInjections(text)) {
      const sev = injectionSeverity(s);
      candidates.push({
        dedupKey: `injection:${m.rule}:${m.phrase}`,
        sev,
        finding: {
          kind: 'injection',
          severity: sev,
          rule: `injection.${m.rule}`,
          message: injectionMessage(s),
          location: locationOf(s),
          provenance: s.provenance,
          match: neutralizePhrase(m.phrase),
        },
      });
    }
  }

  candidates.push(...taintCandidates(surfaces, userInputText));

  const deduped = dedup(candidates);
  const truncated = deduped.length > maxFindings;
  return { findings: truncated ? deduped.slice(0, maxFindings) : deduped, truncated };
}

// ---- severity by data-flow direction ----------------------------------------

function secretSeverity(s: Surface): Severity {
  if (s.provenance === 'tool-args' && s.toolKind === 'side_effecting') return 'critical';
  if (s.provenance === 'final' || s.provenance === 'system' || s.provenance === 'config') return 'high';
  if (s.provenance === 'tool-args') return 'high';
  return 'medium';
}

function injectionSeverity(s: Surface): Severity {
  if (s.provenance === 'tool-result' || s.provenance === 'tool-schema') return 'high';
  if (s.provenance === 'model-output') return 'medium';
  return 'low'; // user-input / model-input / state — expected or noise
}

/** toolName is attacker-controlled (an MCP server names its own tools), so a
 *  credential-shaped name must be redacted before it ever enters a finding. */
function safeToolName(name: string): string {
  return scanSecrets(normalize(name)).length > 0 ? `⟨tool sha256:${secretFingerprint(name)}⟩` : name;
}

function secretMessage(s: Surface, label: string): string {
  if (s.provenance === 'tool-args' && s.toolKind === 'side_effecting') {
    return `possible exfiltration: ${label} in args of side-effecting tool "${safeToolName(s.toolName ?? '?')}"`;
  }
  if (s.provenance === 'final') return `${label} leaked into the final output`;
  if (s.provenance === 'system' || s.provenance === 'config') return `${label} embedded in the system prompt`;
  return `${label} found in ${s.provenance}`;
}

function injectionMessage(s: Surface): string {
  if (s.provenance === 'tool-result') return `prompt-injection in a tool result (possible MCP hijack)`;
  if (s.provenance === 'tool-schema') return `prompt-injection in a tool description`;
  return `prompt-injection pattern in ${s.provenance}`;
}

function locationOf(s: Surface): FindingLocation {
  const loc: FindingLocation = { stepIdx: s.stepIdx, pointer: s.pointer };
  if (s.stepType) loc.stepType = s.stepType;
  if (s.toolName) loc.toolName = safeToolName(s.toolName);
  return loc;
}

// ---- taint: untrusted tool result reaching a side-effecting argument ---------

function taintCandidates(surfaces: Surface[], userInputText: string): Candidate[] {
  const untrusted: string[] = [];
  for (const s of surfaces) {
    if (s.provenance !== 'tool-result' || (s.toolKind !== 'read_only' && s.toolKind !== 'idempotent')) continue;
    for (const leaf of s.leaves) {
      const n = normalize(leaf).trim();
      if (n.length >= 20 && untrusted.length < MAX_UNTRUSTED) untrusted.push(n);
    }
  }

  const out: Candidate[] = [];
  for (const s of surfaces) {
    if (s.provenance !== 'tool-args' || s.toolKind !== 'side_effecting') continue;
    const argText = normalize(s.leaves.join('\n'));
    for (const u of untrusted) {
      if (!argText.includes(u) || userInputText.includes(u)) continue;
      const dangerous = scanSecrets(u).length > 0 || scanInjections(u).length > 0;
      const sev: Severity = dangerous ? 'critical' : 'medium';
      out.push({
        dedupKey: `taint:${secretFingerprint(u)}:${s.stepIdx}`,
        sev,
        finding: {
          kind: 'taint',
          severity: sev,
          rule: 'taint.untrusted-to-sink',
          message: `untrusted tool-result data reaches side-effecting tool "${safeToolName(s.toolName ?? '?')}"${dangerous ? ' carrying a secret/injection' : ''}`,
          location: locationOf(s),
          provenance: 'tool-args',
          match: `⟨len ${u.length}, sha256:${secretFingerprint(u)}⟩`,
        },
      });
    }
  }
  return out;
}

// ---- dedup: one finding per secret/phrase, worst severity, cross-referenced --

function dedup(candidates: Candidate[]): Finding[] {
  const best = new Map<string, Candidate>();
  const also = new Map<string, Set<string>>();
  for (const c of candidates) {
    const existing = best.get(c.dedupKey);
    if (!existing) {
      best.set(c.dedupKey, c);
      also.set(c.dedupKey, new Set());
      continue;
    }
    const newIsWorse = severityRank(c.sev) < severityRank(existing.sev);
    const keep = newIsWorse ? c : existing;
    const drop = newIsWorse ? existing : c;
    also.get(c.dedupKey)!.add(drop.finding.location.pointer);
    best.set(c.dedupKey, keep);
  }
  const out: Finding[] = [];
  for (const [key, c] of best) {
    const others = [...(also.get(key) ?? [])].filter((p) => p !== c.finding.location.pointer).sort();
    out.push(others.length ? { ...c.finding, also: others } : c.finding);
  }
  return out.sort(compareFindings);
}

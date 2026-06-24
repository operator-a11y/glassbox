/**
 * The live firewall: pure, deterministic inspection at the tool boundary. It is the
 * real-time enforcement signal; scanTrace remains the durable audit source of truth.
 *
 * Default enforcement (both overridable):
 *  - a secret in a SIDE-EFFECTING tool's args ⇒ deny (block the exfiltration).
 *  - a high/critical injection in a tool RESULT ⇒ quarantine (the poisoned result is
 *    withheld from the model rather than being allowed to hijack it).
 */

import type { JsonValue, ToolKind } from '@glassbox/engine';
import type { Action, CallVerdict, Finding, Provenance, Severity } from './types.ts';
import { normalize } from './normalize.ts';
import { neutralizePhrase, redactSecret, secretFingerprint } from './redact.ts';
import { scanSecrets } from './secret-scan.ts';
import { scanInjections } from './injection-scan.ts';

/** Tool names can be attacker-controlled; redact a credential-shaped name. */
function safeName(name: string): string {
  return scanSecrets(normalize(name)).length > 0 ? `⟨tool sha256:${secretFingerprint(name)}⟩` : name;
}

export interface PolicyRule {
  tool?: string;
  kind?: ToolKind;
  action: Action;
  reason?: string;
}

export interface FirewallConfig {
  policy?: PolicyRule[];
  /** Deny a side-effecting call when a secret is found in its args (default true). */
  denyExfiltration?: boolean;
  /** Withhold a tool result that contains a high/critical injection (default true). */
  quarantineInjection?: boolean;
}

export interface ToolCall {
  tool: string;
  kind: ToolKind;
  args: JsonValue;
}

export interface Firewall {
  inspectCall(call: ToolCall): CallVerdict;
  inspectResult(call: ToolCall, result: JsonValue): { findings: Finding[]; quarantine: boolean };
}

export function createFirewall(config: FirewallConfig = {}): Firewall {
  const denyExfiltration = config.denyExfiltration ?? true;
  const quarantineInjection = config.quarantineInjection ?? true;
  const policy = config.policy ?? [];

  return {
    inspectCall(call) {
      const findings: Finding[] = [];
      let action: Action = 'allow';

      for (const rule of policy) {
        if ((rule.tool === undefined || rule.tool === call.tool) && (rule.kind === undefined || rule.kind === call.kind)) {
          if (rule.action === 'deny') action = 'deny';
          else if (rule.action === 'flag' && action === 'allow') action = 'flag';
          if (rule.action !== 'allow') {
            findings.push({
              kind: 'policy', severity: rule.action === 'deny' ? 'high' : 'medium', rule: 'policy.rule',
              message: rule.reason ?? `policy ${rule.action} on tool "${call.tool}"`,
              location: { stepIdx: null, pointer: `live:${call.tool}/call`, stepType: 'tool', toolName: call.tool },
              provenance: 'tool-args', match: `${call.tool} (${call.kind})`,
            });
          }
        }
      }

      const text = flatten(call.args);
      for (const m of scanSecrets(text)) {
        const exfil = call.kind === 'side_effecting';
        if (exfil && denyExfiltration) action = 'deny';
        findings.push(secretFinding(call, m.rule, m.label, m.secret, exfil ? 'critical' : 'high', 'tool-args', '/call/args'));
      }
      for (const m of scanInjections(text)) {
        if (action === 'allow') action = 'flag';
        findings.push(injectionFinding(call, m.rule, m.phrase, 'low', 'tool-args', '/call/args'));
      }
      return { action, findings };
    },

    inspectResult(call, result) {
      const findings: Finding[] = [];
      const text = flatten(result);
      for (const m of scanSecrets(text)) {
        findings.push(secretFinding(call, m.rule, m.label, m.secret, 'medium', 'tool-result', '/result'));
      }
      let quarantine = false;
      for (const m of scanInjections(text)) {
        if (quarantineInjection) quarantine = true;
        findings.push(injectionFinding(call, m.rule, m.phrase, 'high', 'tool-result', '/result'));
      }
      return { findings, quarantine };
    },
  };
}

function flatten(value: JsonValue): string {
  const out: string[] = [];
  const walk = (v: JsonValue): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const el of v) walk(el);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]!);
  };
  walk(value);
  return normalize(out.join('\n'));
}

function secretFinding(call: ToolCall, rule: string, label: string, secret: string, severity: Severity, provenance: Provenance, sub: string): Finding {
  const tool = safeName(call.tool);
  return {
    kind: 'secret', severity, rule: `secret.${rule}`,
    message: provenance === 'tool-args' && call.kind === 'side_effecting'
      ? `possible exfiltration: ${label} in args of side-effecting tool "${tool}"`
      : `${label} in ${provenance}`,
    location: { stepIdx: null, pointer: `live:${tool}${sub}`, stepType: 'tool', toolName: tool },
    provenance, match: redactSecret(secret, label),
  };
}

function injectionFinding(call: ToolCall, rule: string, phrase: string, severity: Severity, provenance: Provenance, sub: string): Finding {
  const tool = safeName(call.tool);
  return {
    kind: 'injection', severity, rule: `injection.${rule}`,
    message: provenance === 'tool-result' ? 'prompt-injection in a tool result (possible MCP hijack)' : `prompt-injection pattern in ${provenance}`,
    location: { stepIdx: null, pointer: `live:${tool}${sub}`, stepType: 'tool', toolName: tool },
    provenance, match: neutralizePhrase(phrase),
  };
}

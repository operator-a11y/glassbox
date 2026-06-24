/**
 * @glassbox/probes — scoped checks attached to runtime events.
 *
 * `investigate` is the engine-unique one: a fork-to-counterfactual that reports how a
 * change at step k alters behavior (regression diff) AND security (firewall findings
 * resolved/introduced). `runProbes` is the read-only watch/assert abstraction.
 */

export { investigate } from './investigate.ts';
export type { Investigation, InvestigateResult } from './investigate.ts';

export { runProbes, watchToolCalls, assertSideEffectsTracked, assertArgsUnder } from './probe.ts';
export type { Probe, ProbeMode, ProbeContext, ProbeHit, ProbeReport } from './probe.ts';

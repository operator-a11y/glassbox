/**
 * @glassbox/evals — evals + regression gate over the engine.
 *
 * compareRuns is the regression diff (replay-with-variation, diffed); runEvals is
 * batch record + assertion scoring. Both are pure assembly over the proven engine.
 */

export { compareRuns } from './compare.ts';
export type { RunDiff, StepChange } from './compare.ts';

export {
  finalContains,
  finalNotContains,
  toolCalled,
  toolNotCalled,
  noRealSideEffects,
  statusIs,
  stepCountIs,
  costUnder,
} from './assert.ts';
export type { Assertion, Check } from './assert.ts';

export { runEvals } from './run.ts';
export type { EvalCase, CaseResult, EvalReport } from './run.ts';

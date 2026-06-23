/**
 * The Recorder — the engine's heart. It owns the run mode, the nondeterminism
 * oracle, and the serve-vs-live policy for every primitive (LLM call / tool call).
 *
 * Resumption model (the key design decision): replay and fork RE-DRIVE the agent
 * from the top. They do not snapshot-and-restore state. For every primitive the
 * agent reaches, the Recorder either SERVES the recorded value (so no LLM is
 * re-called and no tool is re-executed before the fork) or runs it LIVE. Because
 * the agent's control flow is deterministic given served values, re-driving
 * reconstructs the exact same state — which is why the bit-identical check is a
 * real determinism proof rather than a tautology of copying an array.
 *
 * The fork "live-flip" happens AT the k-th primitive call, not before it, so any
 * nondeterminism draws leading into step k are still served and `stateBefore[k]`
 * is preserved exactly; divergence begins precisely at step k's execution.
 */

import { randomUUID } from 'node:crypto';
import { assertJsonValue, canonicalEqual, jsonClone } from './json.ts';
import type { JsonValue } from './json.ts';
import type { Draw, DrawKind, ExecutionMode, LlmStep, Step, ToolStep } from './trace.ts';
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from './model.ts';
import type { ToolContext, ToolDefinition } from './tools.ts';

export class DesyncError extends Error {
  override readonly name = 'DesyncError';
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(readonly maxSteps: number) {
    super(`run exceeded maxSteps budget of ${maxSteps}`);
  }
}

export class SideEffectTrapError extends Error {
  override readonly name = 'SideEffectTrapError';
}

export type RunMode =
  | { kind: 'record' }
  | { kind: 'replay' }
  | { kind: 'fork'; fromStep: number; mutation: { system: string | null } };

export interface RecorderInit {
  mode: RunMode;
  systemPrompt: string;
  maxSteps: number;
  /** The recorded trace to serve from (required for replay / fork). */
  source?: { steps: Step[]; nondeterminism: Draw[] } | null;
}

export class Recorder {
  readonly mode: RunMode;
  private readonly systemPrompt: string;
  private readonly maxSteps: number;
  private readonly sourceSteps: Step[];
  private readonly sourceDraws: Draw[];

  private readonly steps: Step[] = [];
  private readonly draws: Draw[] = [];
  private primitiveCount = 0;
  private drawCursor = 0;
  private live: boolean;
  private getState: () => JsonValue = () => ({});

  readonly ctx: ToolContext;

  constructor(init: RecorderInit) {
    this.mode = init.mode;
    this.systemPrompt = init.systemPrompt;
    this.maxSteps = init.maxSteps;
    this.sourceSteps = init.source?.steps ?? [];
    this.sourceDraws = init.source?.nondeterminism ?? [];

    if (init.mode.kind === 'record') this.live = true;
    else if (init.mode.kind === 'replay') this.live = false;
    else this.live = init.mode.fromStep === 0; // fork at 0 == everything live

    this.ctx = {
      now: () => this.draw('now', () => Date.now()) as number,
      random: () => this.draw('random', () => Math.random()) as number,
      uuid: () => this.draw('uuid', () => randomUUID()) as string,
    };
  }

  bindState(getState: () => JsonValue): void {
    this.getState = getState;
  }

  getSteps(): Step[] {
    return this.steps;
  }

  getDraws(): Draw[] {
    return this.draws;
  }

  /** Replay must consume exactly the recorded steps and draws — assert it. */
  assertFullyConsumed(): void {
    if (this.mode.kind !== 'replay') return;
    if (this.primitiveCount !== this.sourceSteps.length) {
      throw new DesyncError(
        `replay divergence: agent produced ${this.primitiveCount} steps, recording has ${this.sourceSteps.length}`,
      );
    }
    if (this.drawCursor !== this.sourceDraws.length) {
      throw new DesyncError(
        `replay divergence: agent consumed ${this.drawCursor} nondeterminism draws, recording has ${this.sourceDraws.length}`,
      );
    }
  }

  // ---- nondeterminism oracle ------------------------------------------------

  private draw(kind: DrawKind, liveGen: () => string | number): string | number {
    if (this.live) {
      const value = liveGen();
      this.draws.push({ kind, value, stepIdx: this.primitiveCount });
      return value;
    }
    const rec = this.sourceDraws[this.drawCursor];
    if (rec === undefined) {
      throw new DesyncError(
        `nondeterminism cursor overrun: agent requested ${kind} draw #${this.drawCursor}, recording has only ${this.sourceDraws.length}`,
      );
    }
    if (rec.kind !== kind) {
      throw new DesyncError(
        `nondeterminism desync at draw #${this.drawCursor}: agent requested ${kind}, recording has ${rec.kind}`,
      );
    }
    if (rec.stepIdx !== this.primitiveCount) {
      throw new DesyncError(
        `nondeterminism desync at draw #${this.drawCursor}: drawn during step ${this.primitiveCount}, recording has step ${rec.stepIdx}`,
      );
    }
    this.drawCursor++;
    this.draws.push({ kind: rec.kind, value: rec.value, stepIdx: rec.stepIdx });
    return rec.value;
  }

  /**
   * Reconstruct draws that were made *inside* a served step's body (e.g. a tool
   * that minted a uuid). On replay the body does not execute, so those draws are
   * never re-requested via ctx; the recorder serves them here, in recorded order.
   * Leading draws made by agent code before the call were already consumed via
   * ctx; only this step's internal draws remain at the cursor with this stepIdx.
   */
  private drainStepDraws(idx: number): void {
    while (
      !this.live &&
      this.drawCursor < this.sourceDraws.length &&
      this.sourceDraws[this.drawCursor]!.stepIdx === idx
    ) {
      const rec = this.sourceDraws[this.drawCursor]!;
      this.drawCursor++;
      this.draws.push({ kind: rec.kind, value: rec.value, stepIdx: rec.stepIdx });
    }
  }

  // ---- primitives -----------------------------------------------------------

  private maybeFlipLive(): void {
    if (this.mode.kind === 'fork' && !this.live && this.primitiveCount === this.mode.fromStep) {
      this.live = true;
    }
  }

  private effectiveSystem(): string {
    if (this.mode.kind === 'fork' && this.live && this.mode.mutation.system !== null) {
      return this.mode.mutation.system;
    }
    return this.systemPrompt;
  }

  private ensureBudget(): void {
    if (this.primitiveCount >= this.maxSteps) {
      throw new BudgetExceededError(this.maxSteps);
    }
  }

  private snapshot(): JsonValue {
    return jsonClone(this.getState());
  }

  async runLlmStep(req: ModelRequest, client: ModelClient): Promise<ModelResponse> {
    this.ensureBudget();
    this.maybeFlipLive();
    const idx = this.primitiveCount;
    const system = this.effectiveSystem();
    const stateBefore = this.snapshot();

    let content: ContentBlock[];
    let stopReason: string;
    let usage: { inputTokens: number; outputTokens: number };
    let latencyMs: number;
    let executionMode: ExecutionMode;

    if (this.live) {
      const start = performance.now();
      const resp = await client.complete({
        system,
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens,
      });
      latencyMs = roundMs(performance.now() - start);
      content = resp.content;
      stopReason = resp.stopReason;
      usage = resp.usage;
      executionMode = this.mode.kind === 'record' ? 'recorded' : 'live';
    } else {
      const rec = this.expectStep(idx, 'llm');
      if (rec.input.system !== system) {
        throw new DesyncError(`replay desync at step ${idx}: injected system prompt does not match recording`);
      }
      if (!canonicalEqual(rec.input.messages, req.messages)) {
        throw new DesyncError(`replay desync at step ${idx}: messages do not match recording`);
      }
      if (!canonicalEqual(rec.input.tools, req.tools)) {
        throw new DesyncError(`replay desync at step ${idx}: tool definitions do not match recording`);
      }
      content = rec.output.content as unknown as ContentBlock[];
      stopReason = rec.output.stopReason;
      usage = rec.tokens;
      latencyMs = rec.latencyMs;
      executionMode = 'replayed';
      this.drainStepDraws(idx);
    }

    const clonedContent = jsonClone(content);
    const stateAfter = this.snapshot();
    const step: LlmStep = {
      idx,
      type: 'llm',
      input: { system, messages: jsonClone(req.messages), tools: jsonClone(req.tools) },
      output: { content: clonedContent as unknown as JsonValue[], stopReason },
      tokens: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      latencyMs,
      stateBefore,
      stateAfter,
      executionMode,
    };
    this.steps.push(step);
    this.primitiveCount++;
    return { content: clonedContent as ContentBlock[], stopReason, usage: step.tokens };
  }

  async runToolStep(tool: ToolDefinition, args: JsonValue): Promise<JsonValue> {
    this.ensureBudget();
    this.maybeFlipLive();
    const idx = this.primitiveCount;
    const stateBefore = this.snapshot();

    let result: JsonValue;
    let latencyMs: number;
    let wasRealEffect: boolean;
    let simulated: boolean;
    let executionMode: ExecutionMode;

    if (!this.live) {
      // Pre-fork: serve from recording, never execute.
      const rec = this.expectStep(idx, 'tool');
      if (rec.toolName !== tool.name) {
        throw new DesyncError(`replay desync at step ${idx}: tool name ${rec.toolName} vs requested ${tool.name}`);
      }
      if (!canonicalEqual(rec.input, args)) {
        throw new DesyncError(`replay desync at step ${idx}: args for ${tool.name} do not match recording`);
      }
      result = rec.output;
      latencyMs = rec.latencyMs;
      wasRealEffect = rec.wasRealEffect; // immutable recorded fact
      simulated = tool.kind === 'side_effecting'; // a served side effect is SIMULATED
      executionMode = 'replayed';
      this.drainStepDraws(idx);
    } else if (tool.kind === 'side_effecting' && this.mode.kind !== 'record') {
      // Fork suffix: a side-effecting call is ALWAYS short-circuited before any
      // recording lookup or live-exec fallback. The real fn is never reached.
      const start = performance.now();
      result = await this.synthesize(tool, args);
      latencyMs = roundMs(performance.now() - start);
      wasRealEffect = false;
      simulated = true;
      executionMode = 'simulated';
    } else {
      // record mode (any kind) OR fork-suffix read_only/idempotent: run for real.
      if (tool.kind === 'side_effecting' && this.mode.kind !== 'record') {
        // unreachable, but make the soundness invariant explicit and loud.
        throw new SideEffectTrapError(
          `refusing to execute side-effecting tool "${tool.name}" outside record mode`,
        );
      }
      const start = performance.now();
      result = (await tool.run(args, this.ctx)) as JsonValue;
      latencyMs = roundMs(performance.now() - start);
      wasRealEffect = tool.kind === 'side_effecting';
      simulated = false;
      executionMode = this.mode.kind === 'record' ? 'recorded' : 'live';
    }

    assertJsonValue(result);
    const stateAfter = this.snapshot();
    const step: ToolStep = {
      idx,
      type: 'tool',
      toolName: tool.name,
      kind: tool.kind,
      input: jsonClone(args),
      output: jsonClone(result),
      wasRealEffect,
      simulated,
      latencyMs,
      stateBefore,
      stateAfter,
      executionMode,
    };
    this.steps.push(step);
    this.primitiveCount++;
    return jsonClone(result);
  }

  private async synthesize(tool: ToolDefinition, args: JsonValue): Promise<JsonValue> {
    if (tool.simulate) return (await tool.simulate(args, this.ctx)) as JsonValue;
    return {
      simulated: true,
      note: `SIMULATED — side-effecting tool "${tool.name}" was not executed in fork`,
      tool: tool.name,
      args: jsonClone(args),
    };
  }

  private expectStep(idx: number, type: 'llm'): LlmStep;
  private expectStep(idx: number, type: 'tool'): ToolStep;
  private expectStep(idx: number, type: 'llm' | 'tool'): Step {
    const rec = this.sourceSteps[idx];
    if (!rec) {
      throw new DesyncError(
        `replay desync: agent requested step ${idx} (${type}), recording has only ${this.sourceSteps.length} steps`,
      );
    }
    if (rec.type !== type) {
      throw new DesyncError(`replay desync at step ${idx}: agent requested ${type}, recording has ${rec.type}`);
    }
    return rec;
  }
}

function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

import type { UsageTotals } from './format.ts';

export type PromptOutcome = 'completed' | 'aborted' | 'error';

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    total?: number;
  };
}

export interface PromptMeterState {
  startedAtMs: number;
  pausedAtMs?: number;
  pausedTotalMs: number;
  finalizedUsage: UsageTotals;
  streamingMessageKey?: string;
  streamingUsage: UsageTotals;
  finalizedMessageKeys: Set<string>;
  compactionKeys: Set<string>;
  outcome?: PromptOutcome;
  active: boolean;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function zeroUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function normalizeUsage(usage?: UsageLike): UsageTotals {
  return {
    input: numberOrZero(usage?.input),
    output: numberOrZero(usage?.output),
    cacheRead: numberOrZero(usage?.cacheRead),
    cacheWrite: numberOrZero(usage?.cacheWrite),
    totalTokens: numberOrZero(usage?.totalTokens),
    cost: numberOrZero(usage?.cost?.total),
  };
}

function hasUsage(usage: UsageTotals): boolean {
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.totalTokens > 0 ||
    usage.cost > 0
  );
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: left.cost + right.cost,
  };
}

export function createPromptMeter(nowMs: number): PromptMeterState {
  return {
    startedAtMs: nowMs,
    pausedTotalMs: 0,
    finalizedUsage: zeroUsage(),
    streamingUsage: zeroUsage(),
    finalizedMessageKeys: new Set(),
    compactionKeys: new Set(),
    active: true,
  };
}

export function resetPromptMeter(state: PromptMeterState, nowMs: number): void {
  state.startedAtMs = nowMs;
  state.pausedAtMs = undefined;
  state.pausedTotalMs = 0;
  state.finalizedUsage = zeroUsage();
  state.streamingMessageKey = undefined;
  state.streamingUsage = zeroUsage();
  state.finalizedMessageKeys.clear();
  state.compactionKeys.clear();
  state.outcome = undefined;
  state.active = true;
}

export function pausePromptMeter(state: PromptMeterState, nowMs: number): void {
  if (!state.active || state.pausedAtMs !== undefined) return;
  state.pausedAtMs = nowMs;
}

export function resumePromptMeter(state: PromptMeterState, nowMs: number): void {
  if (!state.active || state.pausedAtMs === undefined) return;
  state.pausedTotalMs += Math.max(0, nowMs - state.pausedAtMs);
  state.pausedAtMs = undefined;
}

export function activeElapsedMs(state: PromptMeterState, nowMs: number): number {
  const openPauseMs = state.pausedAtMs === undefined ? 0 : Math.max(0, nowMs - state.pausedAtMs);
  return Math.max(0, nowMs - state.startedAtMs - state.pausedTotalMs - openPauseMs);
}

export function setStreamingUsage(
  state: PromptMeterState,
  messageKey: string,
  usage?: UsageLike,
): void {
  if (state.finalizedMessageKeys.has(messageKey)) return;
  state.streamingMessageKey = messageKey;
  state.streamingUsage = normalizeUsage(usage);
}

export function finalizeMessageUsage(
  state: PromptMeterState,
  messageKey: string,
  usage?: UsageLike,
): void {
  if (state.finalizedMessageKeys.has(messageKey)) return;

  const finalUsage = normalizeUsage(usage);
  const isCurrentStream = state.streamingMessageKey === messageKey;
  const usageToFinalize = isCurrentStream && !hasUsage(finalUsage)
    ? state.streamingUsage
    : finalUsage;

  state.finalizedMessageKeys.add(messageKey);
  state.finalizedUsage = addUsage(state.finalizedUsage, usageToFinalize);

  if (isCurrentStream) {
    state.streamingMessageKey = undefined;
    state.streamingUsage = zeroUsage();
  }
}

export function addCompactionUsage(
  state: PromptMeterState,
  compactionKey: string,
  usage?: UsageLike,
): void {
  if (state.compactionKeys.has(compactionKey)) return;
  state.compactionKeys.add(compactionKey);
  state.finalizedUsage = addUsage(state.finalizedUsage, normalizeUsage(usage));
}

export function setOutcome(state: PromptMeterState, outcome: PromptOutcome): void {
  state.outcome = outcome;
}

export function snapshotTotals(state: PromptMeterState): UsageTotals {
  return addUsage(state.finalizedUsage, state.streamingUsage);
}

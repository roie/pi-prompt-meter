import { formatMeter, type MeterLabel } from './format.ts';
import {
  activeElapsedMs,
  addCompactionUsage,
  createPromptMeter,
  finalizeMessageUsage,
  pausePromptMeter,
  resumePromptMeter,
  setOutcome,
  setStreamingUsage,
  snapshotTotals,
  type PromptMeterState,
  type PromptOutcome,
  type UsageLike,
} from './state.ts';

const STATUS_KEY = 'pi-prompt-meter';
const TICK_MS = 1_000;

interface ModelLike {
  provider: string;
  id?: string;
}

export interface PromptMeterContext {
  ui: {
    theme?: {
      fg(role: string, text: string): string;
    };
    setStatus(key: string, text: string | undefined): void;
    setWorkingMessage(message?: string): void;
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: 'aboveEditor' | 'belowEditor' },
    ): void;
  };
  model?: ModelLike;
  modelRegistry: {
    isUsingOAuth?(model: ModelLike): boolean;
    isUsingSubscription?(model: ModelLike): boolean;
  };
}

interface MessageLike {
  role: string;
  usage?: UsageLike;
  toolCallId?: string;
  timestamp?: number;
}

interface PromptMeterEventMap {
  session_start: { type: 'session_start'; reason?: string };
  session_shutdown: { type: 'session_shutdown'; reason?: string };
  before_agent_start: { type: 'before_agent_start'; prompt?: string };
  message_start: { type: 'message_start'; message: MessageLike };
  message_update: { type: 'message_update'; message: MessageLike };
  message_end: { type: 'message_end'; message: MessageLike };
  session_compact: {
    type: 'session_compact';
    compactionEntry: { id: string; usage?: UsageLike };
  };
  ui_prompt_start: { type: 'ui_prompt_start' };
  ui_prompt_end: { type: 'ui_prompt_end' };
  agent_before_settle: { type: 'agent_before_settle'; outcome: PromptOutcome };
  agent_settled: { type: 'agent_settled' };
}

export interface PromptMeterExtensionAPI {
  on<K extends keyof PromptMeterEventMap>(
    name: K,
    handler: (event: PromptMeterEventMap[K], ctx: PromptMeterContext) => unknown,
  ): () => void;
}

export interface PromptMeterRuntime {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultRuntime: PromptMeterRuntime = {
  now: () => Date.now(),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as number),
};

function finalLabel(outcome: PromptOutcome | undefined): MeterLabel {
  if (outcome === 'aborted') return 'Canceled';
  if (outcome === 'error') return 'Error';
  return 'Done';
}

function isSubscriptionBacked(ctx: PromptMeterContext): boolean {
  const model = ctx.model;
  if (!model) return false;

  try {
    if (typeof ctx.modelRegistry.isUsingSubscription === 'function') {
      return ctx.modelRegistry.isUsingSubscription(model);
    }
    if (typeof ctx.modelRegistry.isUsingOAuth === 'function') {
      return ctx.modelRegistry.isUsingOAuth(model);
    }
  } catch {
    return false;
  }

  return false;
}


function styleFinalMeter(ctx: PromptMeterContext, label: MeterLabel, text: string): string {
  if (label !== 'Done') return text;

  try {
    return ctx.ui.theme?.fg('dim', text) ?? text;
  } catch {
    return text;
  }
}

function safeSetStatus(ctx: PromptMeterContext, text: string | undefined): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // Display failures must never interfere with the agent run.
  }
}

function safeSetWorkingMessage(ctx: PromptMeterContext, text?: string): void {
  try {
    ctx.ui.setWorkingMessage(text);
  } catch {
    // Display failures must never interfere with the agent run.
  }
}

function safeSetWidget(ctx: PromptMeterContext, text?: string): void {
  try {
    ctx.ui.setWidget(STATUS_KEY, text === undefined ? undefined : [text], { placement: 'aboveEditor' });
  } catch {
    // Display failures must never interfere with the agent run.
  }
}

export function registerPromptMeter(
  pi: PromptMeterExtensionAPI,
  runtime: PromptMeterRuntime = defaultRuntime,
): void {
  let state: PromptMeterState | undefined;
  let timer: unknown;
  let subscription = false;
  let assistantKeysByTimestamp = new Map<number, string>();
  let currentAssistantKey: string | undefined;
  let nextAssistantKey = 1;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    runtime.clearInterval(timer);
    timer = undefined;
  };

  const clearPromptState = (ctx: PromptMeterContext): void => {
    stopTimer();
    state = undefined;
    subscription = false;
    assistantKeysByTimestamp = new Map<number, string>();
    currentAssistantKey = undefined;
    nextAssistantKey = 1;
    safeSetStatus(ctx, undefined);
    safeSetWidget(ctx);
    safeSetWorkingMessage(ctx);
  };

  const rememberAssistantKey = (message: MessageLike, key: string): string => {
    if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
      assistantKeysByTimestamp.set(message.timestamp, key);
    }
    return key;
  };

  const beginAssistant = (message: MessageLike): string => {
    const key = rememberAssistantKey(message, `assistant:${nextAssistantKey++}`);
    currentAssistantKey = key;
    return key;
  };

  const assistantKey = (message: MessageLike): string => {
    if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
      const existing = assistantKeysByTimestamp.get(message.timestamp);
      if (existing) return existing;
    }
    if (currentAssistantKey) return rememberAssistantKey(message, currentAssistantKey);
    return beginAssistant(message);
  };

  const refreshWorking = (ctx: PromptMeterContext): void => {
    if (!state?.active) return;
    safeSetWorkingMessage(
      ctx,
      formatMeter('Working', activeElapsedMs(state, runtime.now()), snapshotTotals(state), subscription),
    );
  };

  const startTimer = (ctx: PromptMeterContext): void => {
    stopTimer();
    timer = runtime.setInterval(() => refreshWorking(ctx), TICK_MS);
  };

  pi.on('session_start', (_event, ctx) => {
    clearPromptState(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    clearPromptState(ctx);
  });

  pi.on('before_agent_start', (_event, ctx) => {
    stopTimer();
    state = createPromptMeter(runtime.now());
    subscription = isSubscriptionBacked(ctx);
    assistantKeysByTimestamp = new Map<number, string>();
    currentAssistantKey = undefined;
    nextAssistantKey = 1;
    safeSetStatus(ctx, undefined);
    safeSetWidget(ctx);
    refreshWorking(ctx);
    startTimer(ctx);
  });

  pi.on('message_start', (event) => {
    if (!state?.active || event.message.role !== 'assistant') return;
    beginAssistant(event.message);
  });

  pi.on('message_update', (event, ctx) => {
    if (!state?.active || event.message.role !== 'assistant') return;
    setStreamingUsage(state, assistantKey(event.message), event.message.usage);
    refreshWorking(ctx);
  });

  pi.on('message_end', (event, ctx) => {
    if (!state?.active) return;

    if (event.message.role === 'assistant') {
      const key = assistantKey(event.message);
      finalizeMessageUsage(state, key, event.message.usage);
      if (currentAssistantKey === key) currentAssistantKey = undefined;
    } else if (event.message.role === 'toolResult') {
      if (!event.message.toolCallId) return;
      finalizeMessageUsage(state, `tool:${event.message.toolCallId}`, event.message.usage);
    } else {
      return;
    }

    refreshWorking(ctx);
  });

  pi.on('session_compact', (event, ctx) => {
    if (!state?.active) return;
    addCompactionUsage(state, `compaction:${event.compactionEntry.id}`, event.compactionEntry.usage);
    refreshWorking(ctx);
  });

  pi.on('ui_prompt_start', (_event, ctx) => {
    if (!state?.active) return;
    pausePromptMeter(state, runtime.now());
    refreshWorking(ctx);
  });

  pi.on('ui_prompt_end', (_event, ctx) => {
    if (!state?.active) return;
    resumePromptMeter(state, runtime.now());
    refreshWorking(ctx);
  });

  pi.on('agent_before_settle', (event) => {
    if (!state?.active) return;
    setOutcome(state, event.outcome);
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!state?.active) return;

    const settledAt = runtime.now();
    resumePromptMeter(state, settledAt);
    const elapsedMs = activeElapsedMs(state, settledAt);
    const usage = snapshotTotals(state);
    const label = finalLabel(state.outcome);

    state.active = false;
    stopTimer();
    safeSetWorkingMessage(ctx);
    safeSetStatus(ctx, undefined);
    const finalText = formatMeter(label, elapsedMs, usage, subscription);
    safeSetWidget(ctx, styleFinalMeter(ctx, label, finalText));
  });
}

export default function piPromptMeter(pi: PromptMeterExtensionAPI): void {
  registerPromptMeter(pi);
}

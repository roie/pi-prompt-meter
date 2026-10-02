import { listProjectHistory } from './history/catalog.ts';
import { navigateToHistoryPrompt } from './navigation.ts';
import { MeterView, type MeterViewResult } from './ui/meter-view.ts';
import { METER_ENTRY_TYPE } from './history/record.ts';
import type { BillingKind, MeterHistoryOutcome } from './history/types.ts';
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
  sessionManager: {
    getEntries(): Array<{ type: string; id: string; message?: MessageLike }>;
    getSessionFile?(): string | undefined;
  };
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
    notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
    custom?<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any | Promise<any>): Promise<T>;
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
  appendEntry(customType: string, data?: unknown): void;
  registerCommand?(name: string, command: { description: string; handler: (args: string, ctx: PromptMeterCommandContext) => unknown }): void;
  on<K extends keyof PromptMeterEventMap>(
    name: K,
    handler: (event: PromptMeterEventMap[K], ctx: PromptMeterContext) => unknown,
  ): () => void;
}

export interface PromptMeterCommandContext extends PromptMeterContext {
  mode: string;
  cwd: string;
  waitForIdle(): Promise<void>;
  navigateTree(entryId: string): Promise<{ cancelled: boolean }>;
  switchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: PromptMeterCommandContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;
  sessionManager: PromptMeterContext['sessionManager'] & { getSessionFile(): string | undefined };
  ui: PromptMeterContext['ui'] & {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any | Promise<any>): Promise<T>;
  };
}

export interface PromptMeterServices {
  listProjectHistory: typeof listProjectHistory;
  createMeterView: typeof MeterView.create;
  navigateToHistoryPrompt: typeof navigateToHistoryPrompt;
}

const defaultServices: PromptMeterServices = {
  listProjectHistory,
  createMeterView: (...args) => MeterView.create(...args),
  navigateToHistoryPrompt,
};

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

function billingKind(ctx: PromptMeterContext): BillingKind {
  const model = ctx.model;
  if (!model) return 'unknown';

  try {
    if (typeof ctx.modelRegistry.isUsingSubscription === 'function') {
      return ctx.modelRegistry.isUsingSubscription(model) ? 'subscription' : 'metered';
    }
    if (typeof ctx.modelRegistry.isUsingOAuth === 'function') {
      return ctx.modelRegistry.isUsingOAuth(model) ? 'subscription' : 'metered';
    }
  } catch {
    return 'unknown';
  }

  return 'unknown';
}

function historyOutcome(outcome: PromptOutcome | undefined): MeterHistoryOutcome {
  if (outcome === 'aborted') return 'canceled';
  if (outcome === 'error') return 'error';
  return 'completed';
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
  services: PromptMeterServices = defaultServices,
): void {
  let state: PromptMeterState | undefined;
  let timer: unknown;
  let subscription = false;
  let assistantKeysByTimestamp = new Map<number, string>();
  let currentAssistantKey: string | undefined;
  let nextAssistantKey = 1;
  let promptText = '';
  let initiatingUserMessage: MessageLike | undefined;

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
    promptText = '';
    initiatingUserMessage = undefined;
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

  pi.registerCommand?.('meter', {
    description: 'Show prompt history and usage trends',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/meter requires TUI mode', 'warning');
        return;
      }

      await ctx.waitForIdle();
      let catalog;
      try {
        catalog = await services.listProjectHistory(ctx.cwd);
      } catch (error) {
        ctx.ui.notify(`Unable to read prompt history: ${error instanceof Error ? error.message : String(error)}`, 'warning');
        return;
      }

      const result = await ctx.ui.custom<MeterViewResult>(
        (tui, theme, _keybindings, done) =>
          services.createMeterView(tui, theme, catalog, done, {
            currentSessionPath: ctx.sessionManager.getSessionFile(),
          }),
      );

      if (result.kind === 'navigate') {
        await services.navigateToHistoryPrompt(ctx as any, {
          sessionPath: result.sessionPath,
          userEntryId: result.userEntryId,
        });
        return;
      }
    },
  });

  pi.on('session_start', (_event, ctx) => {
    clearPromptState(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    clearPromptState(ctx);
  });

  pi.on('before_agent_start', (event, ctx) => {
    stopTimer();
    state = createPromptMeter(runtime.now());
    subscription = isSubscriptionBacked(ctx);
    assistantKeysByTimestamp = new Map<number, string>();
    currentAssistantKey = undefined;
    nextAssistantKey = 1;
    promptText = event.prompt ?? '';
    initiatingUserMessage = undefined;
    safeSetStatus(ctx, undefined);
    safeSetWidget(ctx);
    refreshWorking(ctx);
    startTimer(ctx);
  });

  pi.on('message_start', (event) => {
    if (!state?.active) return;
    if (event.message.role === 'user') {
      initiatingUserMessage ??= event.message;
      return;
    }
    if (event.message.role === 'assistant') beginAssistant(event.message);
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

    try {
      const userEntryId = initiatingUserMessage
        ? ctx.sessionManager.getEntries().find(
            (entry) => entry.type === 'message' && entry.message === initiatingUserMessage,
          )?.id
        : undefined;
      if (userEntryId) {
        pi.appendEntry(METER_ENTRY_TYPE, {
          userEntryId,
          prompt: promptText,
          startedAt: state.startedAtMs,
          endedAt: settledAt,
          durationMs: elapsedMs,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          cost: usage.cost,
          billing: billingKind(ctx),
          outcome: historyOutcome(state.outcome),
        });
      }
    } catch {
      // History persistence must never interfere with the live meter.
    }
  });
}

export default function piPromptMeter(pi: PromptMeterExtensionAPI): void {
  registerPromptMeter(pi);
}

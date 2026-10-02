import { listProjectHistory } from './history/catalog.ts';
import { navigateToHistoryPrompt } from './navigation.ts';
import { MeterView, type MeterViewResult } from './ui/meter-view.ts';
import { renderMeterHistoryEntry } from './ui/render-meter-entry.ts';
import { METER_ENTRY_TYPE } from './history/record.ts';
import type { BillingKind, MeterHistoryOutcome } from './history/types.ts';
import { formatMeter } from './format.ts';
import {
  activeElapsedMs,
  addCompactionUsage,
  createPromptMeter,
  finalizeMessageUsage,
  pausePromptMeter,
  recordToolCall,
  recordTurn,
  resumePromptMeter,
  setOutcome,
  setStreamingUsage,
  snapshotActivity,
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
  stopReason?: string;
}

interface PromptMeterEventMap {
  session_start: { type: 'session_start'; reason?: string };
  session_shutdown: { type: 'session_shutdown'; reason?: string };
  before_agent_start: { type: 'before_agent_start'; prompt?: string; images?: readonly unknown[] };
  agent_start: { type: 'agent_start' };
  turn_start: { type: 'turn_start'; turnIndex: number; timestamp: number };
  tool_execution_start: {
    type: 'tool_execution_start';
    toolCallId: string;
    toolName: string;
    args?: unknown;
    parentToolCallId?: string;
  };
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
  registerEntryRenderer?(
    customType: string,
    renderer: (
      entry: { data?: unknown },
      options: { expanded: boolean },
      theme: { fg(role: string, text: string): string },
    ) => unknown,
  ): void;
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

function clearWidget(ctx: PromptMeterContext): void {
  try {
    ctx.ui.setWidget(STATUS_KEY, undefined, { placement: 'aboveEditor' });
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
  let turnOffset = 0;
  let assistantKeysByTimestamp = new Map<number, string>();
  let currentAssistantKey: string | undefined;
  let nextAssistantKey = 1;
  let promptText = '';
  let initiatingUserMessage: MessageLike | undefined;

  const durableTranscript = typeof pi.registerEntryRenderer === 'function';
  pi.registerEntryRenderer?.(
    METER_ENTRY_TYPE,
    (entry, _options, theme) => renderMeterHistoryEntry(entry.data, theme),
  );

  const stopTimer = (): void => {
    if (timer === undefined) return;
    runtime.clearInterval(timer);
    timer = undefined;
  };

  const clearPromptState = (ctx: PromptMeterContext): void => {
    stopTimer();
    state = undefined;
    subscription = false;
    turnOffset = 0;
    assistantKeysByTimestamp = new Map<number, string>();
    currentAssistantKey = undefined;
    nextAssistantKey = 1;
    promptText = '';
    initiatingUserMessage = undefined;
    safeSetStatus(ctx, undefined);
    clearWidget(ctx);
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
      formatMeter(
        'Working',
        activeElapsedMs(state, runtime.now()),
        snapshotTotals(state),
        subscription,
        snapshotActivity(state),
      ),
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
    clearPromptState(ctx);
    // Empty, image-free runs are internal probes, not user prompts (e.g. /context).
    if (!event.prompt?.trim() && !event.images?.length) return;
    state = createPromptMeter(runtime.now());
    subscription = isSubscriptionBacked(ctx);
    turnOffset = 0;
    assistantKeysByTimestamp = new Map<number, string>();
    currentAssistantKey = undefined;
    nextAssistantKey = 1;
    promptText = event.prompt ?? '';
    initiatingUserMessage = undefined;
    safeSetStatus(ctx, undefined);
    clearWidget(ctx);
    refreshWorking(ctx);
    startTimer(ctx);
  });

  pi.on('agent_start', () => {
    if (!state?.active) return;
    // Pi resets turnIndex on agent.continue(), including retries and recovery.
    // Those runs still belong to the same prompt until agent_settled.
    turnOffset = snapshotActivity(state).turns;
  });

  pi.on('turn_start', (event) => {
    if (!state?.active) return;
    recordTurn(state, turnOffset + event.turnIndex);
  });

  pi.on('tool_execution_start', (event) => {
    if (!state?.active) return;
    recordToolCall(state, event.toolCallId);
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
      // Pi skips agent_before_settle when aborted. The latest terminal assistant
      // supplies the fallback outcome; a later recovery or boundary can replace it.
      const stopReason = event.message.stopReason;
      setOutcome(state, stopReason === 'aborted' || stopReason === 'error' ? stopReason : 'completed');
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
    const activity = snapshotActivity(state);

    state.active = false;
    stopTimer();
    safeSetWorkingMessage(ctx);
    safeSetStatus(ctx, undefined);
    // Completed meters belong only to the custom-entry transcript, never a widget.
    clearWidget(ctx);
    let persisted = false;

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
          turns: activity.turns,
          toolCalls: activity.toolCalls,
          compactions: activity.compactions,
          transcript: true,
          billing: billingKind(ctx),
          outcome: historyOutcome(state.outcome),
        });
        persisted = true;
      }
    } catch {
      // appendEntry may throw after storing the entry (for example in a UI listener).
      // Never retry or create a second meter on another surface.
    }

    if (!persisted || !durableTranscript) {
      try {
        ctx.ui.notify?.('Prompt meter transcript unavailable; no fallback meter was created.', 'warning');
      } catch {
        // Notification failures must not affect settlement either.
      }
    }
  });
}

export default function piPromptMeter(pi: PromptMeterExtensionAPI): void {
  registerPromptMeter(pi);
}

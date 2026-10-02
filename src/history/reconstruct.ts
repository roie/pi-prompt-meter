import { METER_ENTRY_TYPE, parseMeterHistoryRecord } from './record.ts';
import type {
  MeterHistoryOutcome,
  MeterHistoryRecordV1,
  PromptHistoryRow,
  SessionHistorySummary,
  SessionMeta,
  SessionUsageTotals,
  UsageKnown,
} from './types.ts';

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface SessionEntryLike {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  customType?: string;
  data?: unknown;
  usage?: UsageLike;
  message?: {
    role?: string;
    content?: unknown;
    usage?: UsageLike;
    stopReason?: string;
  };
}

interface LegacyAccumulator {
  user: SessionEntryLike;
  prompt: string;
  startedAt?: number;
  endedAt?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  outcome?: MeterHistoryOutcome;
  latestAssistantOrder: number;
  known: UsageKnown;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function addUsage(target: LegacyAccumulator, usage?: UsageLike): void {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  for (const field of fields) {
    const value = usage?.[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      target[field] += value;
      target.known[field] = true;
    }
  }
  const cost = usage?.cost?.total;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
    target.cost += cost;
    target.known.cost = true;
  }
}

function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function outcomeFromStopReason(reason: unknown): MeterHistoryOutcome | undefined {
  if (reason === 'error') return 'error';
  if (reason === 'aborted') return 'canceled';
  if (reason === 'stop') return 'completed';
  return undefined;
}

function exactRow(record: MeterHistoryRecordV1, meta: SessionMeta): PromptHistoryRow {
  return {
    sessionId: meta.id,
    sessionPath: meta.path,
    userEntryId: record.userEntryId,
    prompt: record.prompt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    durationApproximate: false,
    input: record.input,
    output: record.output,
    cacheRead: record.cacheRead,
    cacheWrite: record.cacheWrite,
    cost: record.cost,
    ...(record.turns !== undefined ? { turns: record.turns } : {}),
    ...(record.toolCalls !== undefined ? { toolCalls: record.toolCalls } : {}),
    ...(record.compactions !== undefined ? { compactions: record.compactions } : {}),
    billing: record.billing,
    outcome: record.outcome,
    exact: true,
    known: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
  };
}

export function reconstructSessionHistory(
  entries: SessionEntryLike[],
  meta: SessionMeta,
): SessionHistorySummary {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const nearestUserMemo = new Map<string, string | undefined>();

  const nearestUser = (entry: SessionEntryLike): string | undefined => {
    if (nearestUserMemo.has(entry.id)) return nearestUserMemo.get(entry.id);
    let current: SessionEntryLike | undefined = entry;
    const visited: string[] = [];
    const seen = new Set<string>();
    let resolved: string | undefined;
    while (current && !seen.has(current.id)) {
      if (nearestUserMemo.has(current.id)) {
        resolved = nearestUserMemo.get(current.id);
        break;
      }
      seen.add(current.id);
      visited.push(current.id);
      if (current.type === 'message' && current.message?.role === 'user') {
        resolved = current.id;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (const id of visited) nearestUserMemo.set(id, resolved);
    return resolved;
  };

  const exactByUser = new Map<string, MeterHistoryRecordV1>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== METER_ENTRY_TYPE) continue;
    const parsed = parseMeterHistoryRecord(entry.data);
    if (parsed) exactByUser.set(parsed.userEntryId, parsed);
  }

  const legacy = new Map<string, LegacyAccumulator>();
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    legacy.set(entry.id, {
      user: entry,
      prompt: promptText(entry.message.content),
      startedAt: timestampMs(entry.timestamp),
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      latestAssistantOrder: -1,
      known: { input: false, output: false, cacheRead: false, cacheWrite: false, cost: false },
    });
  }

  entries.forEach((entry, order) => {
    const userId = nearestUser(entry);
    if (!userId) return;
    const target = legacy.get(userId);
    if (!target) return;

    const role = entry.type === 'message' ? entry.message?.role : undefined;
    const relevant = role === 'assistant' || role === 'toolResult' || entry.type === 'compaction';
    if (!relevant) return;

    const at = timestampMs(entry.timestamp);
    if (at !== undefined && (target.endedAt === undefined || at > target.endedAt)) target.endedAt = at;

    if (role === 'assistant' || role === 'toolResult') addUsage(target, entry.message?.usage);
    else if (entry.type === 'compaction') addUsage(target, entry.usage);

    if (role === 'assistant' && order >= target.latestAssistantOrder) {
      target.latestAssistantOrder = order;
      target.outcome = outcomeFromStopReason(entry.message?.stopReason);
    }
  });

  const rows: PromptHistoryRow[] = [];
  for (const [userId, acc] of legacy) {
    const exact = exactByUser.get(userId);
    if (exact) {
      rows.push(exactRow(exact, meta));
      continue;
    }
    const validDuration =
      acc.startedAt !== undefined && acc.endedAt !== undefined && acc.endedAt >= acc.startedAt
        ? acc.endedAt - acc.startedAt
        : undefined;
    rows.push({
      sessionId: meta.id,
      sessionPath: meta.path,
      userEntryId: userId,
      prompt: acc.prompt,
      startedAt: acc.startedAt,
      endedAt: acc.endedAt,
      durationMs: validDuration,
      durationApproximate: validDuration !== undefined,
      input: acc.input,
      output: acc.output,
      cacheRead: acc.cacheRead,
      cacheWrite: acc.cacheWrite,
      cost: acc.cost,
      billing: 'unknown',
      outcome: acc.outcome,
      exact: false,
      known: { ...acc.known },
    });
  }

  for (const [userId, exact] of exactByUser) {
    if (!legacy.has(userId)) rows.push(exactRow(exact, meta));
  }

  rows.sort((a, b) => (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY));

  const totals: SessionUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const totalsKnown: UsageKnown = { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true };
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let knownDuration = 0;
  let hasDuration = false;
  let durationApproximate = false;
  for (const row of rows) {
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
    totals.cost += row.cost;
    const known = row.known;
    if (known) {
      totalsKnown.input &&= known.input;
      totalsKnown.output &&= known.output;
      totalsKnown.cacheRead &&= known.cacheRead;
      totalsKnown.cacheWrite &&= known.cacheWrite;
      totalsKnown.cost &&= known.cost;
    }
    if (row.startedAt !== undefined && (startedAt === undefined || row.startedAt < startedAt)) startedAt = row.startedAt;
    if (row.endedAt !== undefined && (endedAt === undefined || row.endedAt > endedAt)) endedAt = row.endedAt;
    if (row.durationMs !== undefined) {
      knownDuration += row.durationMs;
      hasDuration = true;
      if (row.durationApproximate) durationApproximate = true;
    }
  }

  return {
    sessionId: meta.id,
    sessionPath: meta.path,
    createdMs: meta.createdMs,
    modifiedMs: meta.modifiedMs,
    rows,
    startedAt,
    endedAt,
    durationMs: hasDuration ? knownDuration : undefined,
    durationApproximate: hasDuration ? durationApproximate : false,
    totals,
    totalsKnown,
  };
}

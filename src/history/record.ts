import type { BillingKind, MeterHistoryOutcome, MeterHistoryRecordV1 } from './types.ts';

export const METER_ENTRY_TYPE = 'pi-prompt-meter/v1';

const BILLING = new Set<BillingKind>(['subscription', 'metered', 'unknown']);
const OUTCOMES = new Set<MeterHistoryOutcome>(['completed', 'canceled', 'error']);

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseMeterHistoryRecord(data: unknown): MeterHistoryRecordV1 | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = data as Record<string, unknown>;
  if (typeof value.userEntryId !== 'string' || value.userEntryId.length === 0) return undefined;
  if (typeof value.prompt !== 'string') return undefined;
  if (!isNonNegativeFinite(value.startedAt) || !isNonNegativeFinite(value.endedAt)) return undefined;
  if (value.endedAt < value.startedAt) return undefined;
  if (!isNonNegativeFinite(value.durationMs)) return undefined;
  if (!isNonNegativeFinite(value.input)) return undefined;
  if (!isNonNegativeFinite(value.output)) return undefined;
  if (!isNonNegativeFinite(value.cacheRead)) return undefined;
  if (!isNonNegativeFinite(value.cacheWrite)) return undefined;
  if (!isNonNegativeFinite(value.cost)) return undefined;
  if (typeof value.billing !== 'string' || !BILLING.has(value.billing as BillingKind)) return undefined;
  if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome as MeterHistoryOutcome)) return undefined;

  return {
    userEntryId: value.userEntryId,
    prompt: value.prompt,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    durationMs: value.durationMs,
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    cost: value.cost,
    billing: value.billing as BillingKind,
    outcome: value.outcome as MeterHistoryOutcome,
  };
}
